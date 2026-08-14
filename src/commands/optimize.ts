import { readFileSync, writeFileSync, existsSync, mkdtempSync, rmSync, mkdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { tmpdir, homedir } from 'os'
import { createInterface } from 'readline'
import chalk from 'chalk'
import { execa } from 'execa'
import yaml from 'js-yaml'
import { loadConfig, resolveConfigPath } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { buildDiagnoseReport, type DiagnoseReport } from './diagnose.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
// dist/commands/ → ../../ = package root
const PACKAGE_ROOT = resolve(__dirname, '..', '..')

type Agent = 'claude' | 'codex'

// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const ANSI_RE = /\x1b\[[0-9;]*m/g

export function selectOptimizeAgent(
  config: Config,
  report: DiagnoseReport,
): { agent: Agent; reason: string } {
  const enabled: Agent[] = []
  if (config.vendors.claude.enabled) enabled.push('claude')
  if (config.vendors.codex.enabled) enabled.push('codex')

  if (enabled.length === 0) throw new Error('No vendors enabled in config — enable claude or codex under vendors.')
  if (enabled.length === 1) return { agent: enabled[0], reason: `only enabled vendor in config` }

  // Both enabled — pick by success rate from log data
  const cp = report.reviewer_performance['claude']
  const xp = report.reviewer_performance['codex']

  if (cp?.attempts > 0 && xp?.attempts > 0) {
    const cr = cp.successes / cp.attempts
    const xr = xp.successes / xp.attempts
    if (xr > cr) return { agent: 'codex', reason: `codex success rate ${Math.round(xr * 100)}% > claude ${Math.round(cr * 100)}%` }
    if (cr > xr) return { agent: 'claude', reason: `claude success rate ${Math.round(cr * 100)}% > codex ${Math.round(xr * 100)}%` }
  }

  return { agent: 'claude', reason: 'default (both enabled, no data or equal rates)' }
}

// ── ProposedChange ────────────────────────────────────────────────────────────

type ChangeTarget = 'config_field' | 'workflow_instructions'

interface ProposedChange {
  target: ChangeTarget
  field?: string    // dotted path for config_field, e.g. 'quality.tier'
  label: string
  oldValue: string
  newValue: string
  reason: string    // evidence from diagnose (specific counts)
  outcome: string   // expected improvement
}

// Derives config-level changes directly from diagnose suggestions — no agent needed.
export function deriveConfigChanges(report: DiagnoseReport, config: Config): ProposedChange[] {
  const changes: ProposedChange[] = []
  const seen = new Set<string>()

  for (const s of report.suggestions) {
    if (s.type !== 'config_change') continue

    if (/timed? ?out/i.test(s.reason) && !seen.has('timeout_tier')) {
      seen.add('timeout_tier')
      const tier = config.quality.tier
      const lower = tier === 'thorough' ? 'balanced' : tier === 'balanced' ? 'fast' : null
      if (lower) {
        changes.push({
          target: 'config_field',
          field: 'quality.tier',
          label: 'quality.tier',
          oldValue: tier,
          newValue: lower,
          reason: s.reason,
          outcome: 'shorter per-review wall-clock; fewer hard timeout failures',
        })
      }
    }

    if (/budget/i.test(s.reason) && !seen.has('budget_cap')) {
      seen.add('budget_cap')
      const cur = config.budget.per_review_usd
      const next = Math.round(cur * 2 * 100) / 100
      changes.push({
        target: 'config_field',
        field: 'budget.per_review_usd',
        label: 'budget.per_review_usd',
        oldValue: String(cur),
        newValue: String(next),
        reason: s.reason,
        outcome: 'reviews no longer cut off mid-run at the budget ceiling',
      })
    }
  }

  return changes
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function findAgentMd(cwd: string): string {
  const candidates = [
    join(cwd, 'AGENT.md'),
    join(cwd, '.crosscheck', 'AGENT.md'),
    join(PACKAGE_ROOT, 'AGENT.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  throw new Error(`AGENT.md not found. Expected at ${candidates[2]}`)
}

// Minimal LCS-based unified diff for display
function unifiedDiff(oldText: string, newText: string): string {
  if (oldText === newText) return ''

  const a = oldText.split('\n')
  const b = newText.split('\n')
  const m = a.length, n = b.length

  const dp: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      dp[i][j] = a[i] === b[j] ? dp[i + 1][j + 1] + 1 : Math.max(dp[i + 1][j], dp[i][j + 1])

  const lines: string[] = []
  let i = 0, j = 0
  while (i < m || j < n) {
    if (i < m && j < n && a[i] === b[j]) {
      lines.push(` ${a[i]}`); i++; j++
    } else if (j < n && (i >= m || dp[i + 1][j] >= dp[i][j + 1])) {
      lines.push(chalk.green(`+${b[j]}`)); j++
    } else {
      lines.push(chalk.red(`-${a[i]}`)); i++
    }
  }

  return lines.filter(l => !l.startsWith(' ')).length > 0 ? lines.join('\n') : ''
}

function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '')
}

export function countInstructionDiffLines(diff: string): { additions: number; deletions: number } {
  const plainLines = diff.split('\n').map(stripAnsi)
  return {
    additions: plainLines.filter(l => l.startsWith('+')).length,
    deletions: plainLines.filter(l => l.startsWith('-')).length,
  }
}

export function buildCodexOptimizeArgs(outputFile: string): string[] {
  return [
    'exec',
    '--skip-git-repo-check',
    '-o', outputFile,
    'Read OPTIMIZE_PROMPT.md carefully and produce the new instructions.md content. ' +
    'Output only the file content — no explanation, no markdown fences.',
  ]
}

function setNestedPath(obj: Record<string, unknown>, path: string, value: unknown): void {
  const parts = path.split('.')
  let cur = obj
  for (let i = 0; i < parts.length - 1; i++) {
    if (typeof cur[parts[i]] !== 'object' || cur[parts[i]] === null) cur[parts[i]] = {}
    cur = cur[parts[i]] as Record<string, unknown>
  }
  cur[parts[parts.length - 1]] = value
}

function parseConfigValue(s: string): unknown {
  if (s === 'true') return true
  if (s === 'false') return false
  const n = Number(s)
  return Number.isNaN(n) ? s : n
}

// ── Agent runners ─────────────────────────────────────────────────────────────

async function runWithClaude(prompt: string): Promise<string> {
  let result
  try {
    result = await execa('claude', ['--print', '--bare'], {
      input: prompt,
      timeout: 120_000,
      env: { ...process.env },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|please run \/login|run \/login/i.test(msg)) {
      throw new Error('claude is not logged in — run: claude /login')
    }
    throw err
  }
  return (result.stdout ?? result.stderr ?? '').trim()
}

async function runWithCodex(prompt: string): Promise<string> {
  // Write prompt as a file — avoids shell argument length limits on large prompts.
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-optimize-'))
  const outputFile = join(tmpDir, 'output.txt')
  try {
    writeFileSync(join(tmpDir, 'OPTIMIZE_PROMPT.md'), prompt)
    await execa('codex', buildCodexOptimizeArgs(outputFile), {
      cwd: tmpDir,
      timeout: 180_000,
      env: { ...process.env },
    })
    if (existsSync(outputFile)) {
      return readFileSync(outputFile, 'utf8').trim()
    }
    return ''
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

// Runs primary agent; on failure, retries with fallback if one is available.
async function runAgentWithFallback(
  primary: Agent,
  fallback: Agent | undefined,
  prompt: string,
): Promise<{ result: string; agent: Agent }> {
  try {
    const result = primary === 'claude' ? await runWithClaude(prompt) : await runWithCodex(prompt)
    return { result, agent: primary }
  } catch (err) {
    if (!fallback) throw err
    const msg = err instanceof Error ? err.message : String(err)
    console.log(chalk.yellow(`  ⚠ ${primary} failed: ${msg.slice(0, 80)}`))
    console.log(chalk.dim(`  falling back to ${fallback}...`))
    const result = fallback === 'claude' ? await runWithClaude(prompt) : await runWithCodex(prompt)
    return { result, agent: fallback }
  }
}

// ── Interactive confirmation ───────────────────────────────────────────────────

async function confirmChange(
  change: ProposedChange,
  index: number,
  total: number,
  diff: string,
): Promise<boolean> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })

    console.log()
    console.log(`  ${chalk.bold(`[${index}/${total}]`)} ${chalk.cyan(change.label)}`)

    if (change.target === 'config_field') {
      console.log(`        ${chalk.dim('from')}    ${chalk.red(change.oldValue)}`)
      console.log(`        ${chalk.dim('to')}      ${chalk.green(change.newValue)}`)
    } else {
      // Show a compact diff preview (first 10 changed lines)
      const changedLines = diff.split('\n').filter(l => l.startsWith('+') || l.startsWith('-'))
      const preview = changedLines.slice(0, 10)
      for (const l of preview) console.log(`        ${l}`)
      if (changedLines.length > 10) {
        console.log(chalk.dim(`        … (${changedLines.length - 10} more changed lines)`))
      }
    }

    console.log(`        ${chalk.dim('reason')}  ${change.reason}`)
    console.log(`        ${chalk.dim('outcome')} ${change.outcome}`)
    console.log()

    rl.question('  Apply? [y/N] ', answer => {
      rl.close()
      const a = answer.trim().toLowerCase()
      resolve(a === 'y' || a === 'yes')
    })
  })
}

// ── Main command ──────────────────────────────────────────────────────────────

export async function runOptimize(opts: {
  apply?: boolean
  dryRun?: boolean
  since?: string
  agent?: string
  config?: string
}): Promise<void> {
  const config = loadConfig(opts.config)
  const cwd = process.cwd()

  // 1. Diagnose
  console.log(chalk.dim('  Running diagnose...'))
  const report = buildDiagnoseReport(opts.since)

  // 2. Select primary agent and optional fallback
  let primaryAgent: Agent
  let agentReason: string
  let fallbackAgent: Agent | undefined

  if (opts.agent === 'claude' || opts.agent === 'codex') {
    primaryAgent = opts.agent
    agentReason = '--agent flag'
    // No fallback when agent is explicitly chosen
  } else {
    try {
      const sel = selectOptimizeAgent(config, report)
      primaryAgent = sel.agent
      agentReason = sel.reason
    } catch (err) {
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
    // Fallback: the other enabled vendor
    const other: Agent = primaryAgent === 'claude' ? 'codex' : 'claude'
    if (primaryAgent === 'claude' && config.vendors.codex.enabled) fallbackAgent = other
    if (primaryAgent === 'codex' && config.vendors.claude.enabled) fallbackAgent = other
  }

  const fallbackSuffix = fallbackAgent ? chalk.dim(` → ${fallbackAgent} on failure`) : ''
  console.log(`  agent    ${chalk.cyan(primaryAgent)} ${chalk.dim(`(${agentReason})`)}${fallbackSuffix}`)

  // 3. Load AGENT.md and current workflow instructions
  let agentMd: string
  try {
    agentMd = findAgentMd(cwd)
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const workflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  let workflowRaw: Record<string, unknown> = {}
  if (existsSync(workflowPath)) {
    try {
      workflowRaw = (yaml.load(readFileSync(workflowPath, 'utf8')) ?? {}) as Record<string, unknown>
    } catch { /* malformed — start fresh */ }
  }
  const workflowSteps = Array.isArray(workflowRaw.steps)
    ? (workflowRaw.steps as Record<string, unknown>[])
    : []
  const reviewStepIdx = workflowSteps.findIndex(s => s.name === 'review' || s.type === 'review')
  const reviewStep = reviewStepIdx >= 0 ? workflowSteps[reviewStepIdx] : null
  const currentInstructions = typeof reviewStep?.instructions === 'string'
    ? reviewStep.instructions
    : DEFAULT_REVIEW_INSTRUCTIONS

  // 4. Derive rule-based config changes from diagnose suggestions
  const configChanges = deriveConfigChanges(report, config)

  // 5. Run AI agent (with fallback) to improve workflow instructions
  const prompt = [
    agentMd,
    '',
    '---',
    '',
    '## Diagnostic report',
    '',
    '```json',
    JSON.stringify(report, null, 2),
    '```',
    '',
    `## Current review step instructions (${workflowPath})`,
    '',
    currentInstructions || '(empty)',
  ].join('\n')

  console.log(chalk.dim(`  Asking ${primaryAgent} to optimize instructions...`))
  let newInstructions: string
  let usedAgent: Agent
  try {
    const r = await runAgentWithFallback(primaryAgent, fallbackAgent, prompt)
    newInstructions = r.result
    usedAgent = r.agent
  } catch (err) {
    console.error(chalk.red(`✗ agent(s) failed: ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (usedAgent !== primaryAgent) {
    console.log(chalk.dim(`  used ${usedAgent} (fallback)`))
  }

  // 6. Build full list of proposed changes
  if (!newInstructions || newInstructions.length < 20) {
    console.error(chalk.red('✗ agent returned an unusable response (too short or empty) — cannot optimize instructions'))
    process.exit(1)
  }
  const instructionsDiff = unifiedDiff(currentInstructions, newInstructions)

  const allChanges: ProposedChange[] = [
    ...configChanges,
    ...(instructionsDiff ? [{
      target: 'workflow_instructions' as ChangeTarget,
      label: 'review step instructions',
      oldValue: currentInstructions,
      newValue: newInstructions,
      reason: `${report.errors.length} distinct error patterns across ${report.period.log_files} log files`,
      outcome: 'more targeted instructions; fewer constraint-check failures',
    }] : []),
  ]

  if (allChanges.length === 0) {
    console.log(chalk.green('\n  ✓ Everything looks optimal — no changes proposed.'))
    return
  }

  // 7. Confirm and apply
  const isInteractive = process.stdin.isTTY && !opts.apply && !opts.dryRun
  const accepted: ProposedChange[] = []

  if (isInteractive) {
    // Ask about each change individually
    console.log(chalk.bold(`\n  ${allChanges.length} change${allChanges.length !== 1 ? 's' : ''} proposed\n`))
    for (let i = 0; i < allChanges.length; i++) {
      const ch = allChanges[i]
      const diff = ch.target === 'workflow_instructions' ? instructionsDiff : ''
      const yes = await confirmChange(ch, i + 1, allChanges.length, diff)
      if (yes) accepted.push(ch)
    }
  } else {
    // Non-interactive: print summary
    console.log(chalk.bold(`\n  Proposed changes (${allChanges.length})\n`))
    for (const ch of allChanges) {
      if (ch.target === 'config_field') {
        console.log(`    ${chalk.cyan(ch.label.padEnd(28))} ${chalk.red(ch.oldValue)} → ${chalk.green(ch.newValue)}`)
      } else {
        const { additions: adds, deletions: dels } = countInstructionDiffLines(instructionsDiff)
        console.log(`    ${chalk.cyan(ch.label.padEnd(28))} ${chalk.green(`+${adds}`)} ${chalk.red(`-${dels}`)} lines`)
      }
      console.log(`      ${chalk.dim(ch.reason)}`)
    }
    console.log()

    if (instructionsDiff) {
      console.log(chalk.bold('  Instruction diff\n'))
      console.log(instructionsDiff)
      console.log()
    }

    if (opts.dryRun) {
      console.log(chalk.dim('  Dry run — no changes written.'))
      return
    }
    if (opts.apply) {
      accepted.push(...allChanges)
    } else {
      console.log(chalk.dim('  Run with --apply to accept all, or without any flags for interactive mode.'))
      return
    }
  }

  if (accepted.length === 0) {
    console.log(chalk.dim('\n  No changes applied.'))
    return
  }

  // 8. Write accepted changes
  const configPath = resolveConfigPath(opts.config) ?? join(homedir(), '.crosscheck', 'config.yml')

  for (const ch of accepted) {
    if (ch.target === 'config_field' && ch.field) {
      let raw: Record<string, unknown> = {}
      if (existsSync(configPath)) {
        try { raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown> } catch { /* start fresh */ }
      }
      setNestedPath(raw, ch.field, parseConfigValue(ch.newValue))
      mkdirSync(dirname(configPath), { recursive: true })
      writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
      console.log(chalk.green(`  ✓ ${ch.label}: ${ch.oldValue} → ${ch.newValue}`) + chalk.dim(`  (${configPath})`))
    } else if (ch.target === 'workflow_instructions') {
      mkdirSync(dirname(workflowPath), { recursive: true })
      if (reviewStepIdx >= 0) {
        workflowSteps[reviewStepIdx] = { ...workflowSteps[reviewStepIdx], instructions: ch.newValue }
        workflowRaw.steps = workflowSteps
        writeFileSync(workflowPath, yaml.dump(workflowRaw, { lineWidth: -1, noRefs: true }))
      } else if (existsSync(workflowPath) && workflowSteps.length > 0) {
        workflowRaw.steps = [...workflowSteps, { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: ch.newValue }]
        writeFileSync(workflowPath, yaml.dump(workflowRaw, { lineWidth: -1, noRefs: true }))
      } else {
        const workflow = {
          on: ['opened', 'synchronize'],
          steps: [{ name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: ch.newValue }],
        }
        writeFileSync(workflowPath, yaml.dump(workflow, { lineWidth: -1, noRefs: true }))
      }
      console.log(chalk.green(`  ✓ review step instructions updated`) + chalk.dim(`  (${workflowPath})`))
    }
  }

  const skipped = allChanges.length - accepted.length
  if (skipped > 0) console.log(chalk.dim(`  ${skipped} change${skipped !== 1 ? 's' : ''} skipped.`))
  console.log(chalk.dim('  Next reviews will use the updated configuration.'))
}
