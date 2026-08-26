import { existsSync, mkdtempSync, writeFileSync, rmSync, readFileSync, readdirSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join, resolve } from 'path'
import { homedir, platform, tmpdir } from 'os'
import { createInterface } from 'readline'
import chalk from 'chalk'
import { execa } from 'execa'
import { loadConfig } from '../config/loader.js'
import { buildDiagnoseReport } from './diagnose.js'
import { selectOptimizeAgent } from './optimize.js'
import { sanitizeEntry, loadErrorEntriesForPattern, sanitizeDraftContent } from '../lib/log-analysis.js'
import type { RawLogEntry } from '../lib/log-analysis.js'
import { loadIssueQueue, markQueueItemDone } from '../lib/issue-queue.js'
import type { IssueQueueRecord } from '../lib/issue-queue.js'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)
const PACKAGE_ROOT = resolve(__dirname, '..', '..')
const LOG_DIR = join(homedir(), '.crosscheck', 'logs')
const ISSUE_REPO = 'humanbased-ai/crosscheck'

function loadIssueHarness(cwd: string): string {
  const candidates = [
    join(cwd, 'ISSUE.md'),
    join(cwd, '.crosscheck', 'ISSUE.md'),
    join(PACKAGE_ROOT, 'ISSUE.md'),
  ]
  for (const p of candidates) {
    if (existsSync(p)) return readFileSync(p, 'utf8')
  }
  return ''
}

function loadRawLogEntries(since: string): RawLogEntry[] {
  if (!existsSync(LOG_DIR)) return []
  const sinceMs = new Date(since).getTime()
  const entries: RawLogEntry[] = []
  for (const f of readdirSync(LOG_DIR).sort()) {
    if (!f.endsWith('.ndjson')) continue
    const fileDate = f.replace('.ndjson', '')
    if (fileDate < since.slice(0, 10)) continue
    const lines = readFileSync(join(LOG_DIR, f), 'utf8').split('\n')
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      try {
        const entry = JSON.parse(trimmed) as RawLogEntry
        if (new Date(entry.ts as string).getTime() >= sinceMs) entries.push(entry)
      } catch { /* skip malformed lines */ }
    }
  }
  return entries
}

const { version: PKG_VERSION } = JSON.parse(
  readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
) as { version: string }

export interface QuestionAnswers {
  reproducibility: string
  trigger: string
  impact: string
}

export function parseDraft(output: string): { title: string; body: string; labels?: string[] } | null {
  const lines = output.split('\n')
  const titleIdx = lines.findIndex(l => l.startsWith('TITLE:'))
  if (titleIdx === -1) return null

  const title = lines[titleIdx].replace(/^TITLE:\s*/, '').trim()
  if (!title) return null

  let sepIdx = -1
  for (let i = titleIdx + 1; i < lines.length; i++) {
    if (lines[i].trim() === '---') { sepIdx = i; break }
  }
  if (sepIdx === -1) return null

  const body = lines.slice(sepIdx + 1).join('\n').trim()
  if (!body) return null

  const labelsLine = lines.slice(titleIdx + 1, sepIdx).find(l => l.startsWith('LABELS:'))
  const labels = labelsLine
    ? labelsLine.replace(/^LABELS:\s*/, '').split(',').map(l => l.trim()).filter(Boolean)
    : undefined

  return { title, body, labels }
}

export function buildIssueContent(
  draft: { title: string; body: string },
  answers: QuestionAnswers,
): { title: string; body: string } {
  const context = [
    '',
    '## User Context',
    '',
    `- **Reproducibility:** ${answers.reproducibility}`,
    `- **Trigger command:** ${answers.trigger}`,
    `- **Impact:** ${answers.impact}`,
  ].join('\n')
  return { title: draft.title, body: draft.body + context }
}

function defaultSince(): string {
  const d = new Date()
  d.setDate(d.getDate() - 3)
  return d.toISOString().split('T')[0] as string
}

function daysBetween(since: string): number {
  return Math.max(1, Math.ceil((Date.now() - new Date(since).getTime()) / 86_400_000))
}

async function ask(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout })
  return new Promise(resolve => {
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

async function pickOne(label: string, choices: string[]): Promise<number> {
  console.log(`\n  ${label}`)
  choices.forEach((c, i) => console.log(`  [${i + 1}] ${c}`))
  while (true) {
    const raw = await ask('  > ')
    const n = parseInt(raw, 10)
    if (Number.isInteger(n) && n >= 1 && n <= choices.length) return n - 1
    console.log(chalk.dim(`  Enter a number from 1 to ${choices.length}`))
  }
}

function buildAgentPrompt(
  errorPattern: string,
  errorCount: number,
  daysSince: number,
  reviewer: string | undefined,
  entries: RawLogEntry[],
  mode: string,
): string {
  const entriesFormatted = entries.map(e => JSON.stringify(sanitizeEntry(e))).join('\n')
  return [
    'You are drafting a GitHub issue for the crosscheck project (a cross-vendor AI code review CLI tool).',
    '',
    `Error pattern: ${errorPattern}`,
    `Frequency: ${errorCount} occurrence${errorCount !== 1 ? 's' : ''} in the last ${daysSince} day${daysSince !== 1 ? 's' : ''}`,
    reviewer ? `Reviewer at time of failure: ${reviewer}` : '',
    '',
    'Sanitized log entries (up to 5 most recent):',
    entriesFormatted || '(none available)',
    '',
    `Environment: crosscheck ${PKG_VERSION} · ${platform()} · mode: ${mode}`,
    '',
    'Write a GitHub issue for this failure. Output exactly:',
    'TITLE: <concise title under 80 characters>',
    '---',
    '<issue body in GitHub-flavored markdown>',
    '',
    'The body must contain: ## Description, ## Steps to Reproduce, ## Log Excerpt, ## Environment',
    'In Log Excerpt, show the sanitized log entries as a json code block.',
    'Do not invent details not present in the provided context.',
  ].filter(Boolean).join('\n')
}

function buildOpportunityPrompt(
  harness: string,
  entries: RawLogEntry[],
  daysSince: number,
  mode: string,
): string {
  const sample = entries
    .filter(e => ['session_start', 'session_end', 'tunnel_opened', 'tunnel_closed',
      'tunnel_error', 'webhook_registered', 'webhook_error', 'pr_received',
      'review_complete', 'verdict_parse_failed', 'error'].includes(e.event as string))
    .map(e => JSON.stringify(sanitizeEntry(e)))
    .join('\n')

  return [
    harness,
    '',
    '---',
    '',
    `## Log data to analyze (last ${daysSince} day${daysSince !== 1 ? 's' : ''})`,
    '',
    `Environment: crosscheck ${PKG_VERSION} · ${platform()} · mode: ${mode}`,
    `Total events loaded: ${entries.length}`,
    '',
    'Filtered events (session lifecycle, tunnel, webhook, review):',
    '```',
    sample || '(no matching events in range)',
    '```',
    '',
    'Apply the analysis framework above. Identify the highest-priority issue or',
    'improvement opportunity present in this data. Output exactly:',
    'TITLE: <concise title under 80 characters>',
    'LABELS: <comma-separated labels>',
    '---',
    '<issue body per the Output format section above>',
    '',
    'Report one issue only — the highest priority finding.',
  ].join('\n')
}

// eslint-disable-next-line no-control-regex
const ANSI_RE = /[\x1B\x9B][[()#;?]*(?:[0-9]{1,4}(?:;[0-9]{0,4})*)?[0-9A-ORZcf-nqry=><~]/g

async function runWithClaude(prompt: string): Promise<string> {
  let result
  try {
    result = await execa('claude', ['--print', prompt], {
      timeout: 120_000,
      stdin: 'ignore',
      env: { ...process.env },
    })
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|please run \/login|run \/login|403|request not allowed|failed to authenticate/i.test(msg)) {
      throw new Error('claude is not authenticated — run: claude /login')
    }
    throw err
  }
  return (result.stdout ?? result.stderr ?? '').replace(ANSI_RE, '').trim()
}

async function runWithCodex(prompt: string): Promise<string> {
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-issue-'))
  try {
    writeFileSync(join(tmpDir, 'ISSUE_PROMPT.md'), prompt)
    const result = await execa('codex', [
      'exec',
      '--skip-git-repo-check',
      'Read ISSUE_PROMPT.md and produce a GitHub issue draft. ' +
      'Output exactly: TITLE: line, then ---, then the markdown body.',
    ], {
      cwd: tmpDir,
      timeout: 180_000,
      env: { ...process.env },
    })
    return (result.stdout ?? '').trim()
  } finally {
    rmSync(tmpDir, { recursive: true, force: true })
  }
}

function printDraft(title: string, body: string): void {
  const width = Math.min(process.stdout.columns ?? 80, 80)
  const bar = '─'.repeat(width)
  console.log('\n' + chalk.dim(bar))
  console.log(chalk.bold(`  TITLE: ${title}`))
  console.log(chalk.dim(bar))
  for (const line of body.split('\n')) {
    console.log(`  ${line}`)
  }
  console.log(chalk.dim(bar) + '\n')
}

function errorLabel(e: { pattern: string; command?: string; branch?: string }): string {
  if (e.pattern === 'command_not_found') return `command not found: ${e.command}`
  if (e.pattern === 'base_branch_missing') return `base branch missing: ${e.branch}`
  return e.pattern
}

function buildQueueItemPrompt(record: IssueQueueRecord, mode: string): string {
  return [
    'You are drafting a GitHub issue for the crosscheck project (a cross-vendor AI code review CLI tool).',
    '',
    `Context: ${record.context}`,
    '',
    `User anticipation: ${record.user_anticipation}`,
    '',
    `Current status: ${record.current_status}`,
    '',
    `Environment: crosscheck ${PKG_VERSION} · ${platform()} · mode: ${mode}`,
    '',
    'Write a GitHub issue for this problem. Output exactly:',
    'TITLE: <concise title under 80 characters>',
    '---',
    '<issue body in GitHub-flavored markdown>',
    '',
    'The body must contain: ## Description, ## Observed Behavior, ## Expected Behavior, ## Steps to Reproduce',
    'Do not invent details not present in the provided context.',
  ].join('\n')
}

async function processQueueItem(
  item: { path: string; record: IssueQueueRecord },
  candidates: Array<'claude' | 'codex'>,
  opts: { dryRun?: boolean; yes?: boolean; mode: string },
): Promise<void> {
  const { record } = item
  console.log(chalk.bold(`\n  Queue item: ${record.pr_url}`))
  console.log(chalk.dim(`    ${record.user_anticipation}`))
  console.log(chalk.dim(`    ${record.current_status}`))
  console.log()

  const prompt = buildQueueItemPrompt(record, opts.mode)
  let agentOutput: string | undefined

  for (let i = 0; i < candidates.length; i++) {
    const agent = candidates[i] as 'claude' | 'codex'
    const reason = i === 0 ? 'primary' : `fallback — ${candidates[i - 1]} failed`
    console.log(chalk.dim(`  drafting with ${agent} (${reason})...`))
    try {
      agentOutput = agent === 'claude'
        ? await runWithClaude(prompt)
        : await runWithCodex(prompt)
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hasNext = i < candidates.length - 1
      console.error(chalk.yellow(`  ✗ ${agent} failed: ${msg}${hasNext ? ' — trying next...' : ''}`))
    }
  }

  if (agentOutput === undefined) {
    console.error(chalk.yellow('  ✗ All agents failed — skipping this queue item'))
    return
  }

  const draftParsed = parseDraft(agentOutput)
  if (!draftParsed) {
    console.error(chalk.yellow('  ✗ Unexpected output format — skipping'))
    return
  }

  const cleanDraft = sanitizeDraftContent(draftParsed.title, draftParsed.body)
  printDraft(cleanDraft.title, cleanDraft.body)

  if (opts.dryRun) {
    console.log(chalk.dim('  (dry run — not submitting)'))
    return
  }

  if (!opts.yes) {
    const confirmed = await ask(`  Submit to ${ISSUE_REPO}? [y/N]: `)
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log('  Skipped.')
      return
    }
  }

  const labels = ['bug', 'workflow-skip']
  await submitIssue(cleanDraft.title, cleanDraft.body, labels)
  markQueueItemDone(item.path)
}

export async function runIssue(opts: {
  since?: string
  dryRun?: boolean
  yes?: boolean
  config?: string
  opportunities?: boolean
  fromQueue?: boolean
}): Promise<void> {
  const since = opts.since ?? defaultSince()

  // --- Queue processing mode (--from-queue) ---
  if (opts.fromQueue) {
    const queue = loadIssueQueue()
    if (queue.length === 0) {
      console.log(chalk.dim('  Issue queue is empty — nothing to process.'))
      return
    }

    console.log(chalk.bold(`\n  Processing ${queue.length} queued issue record${queue.length !== 1 ? 's' : ''}...\n`))

    const config = loadConfig(opts.config)
    const candidates: Array<'claude' | 'codex'> = []
    try {
      const sel = selectOptimizeAgent(config, buildDiagnoseReport(since, LOG_DIR))
      candidates.push(sel.agent)
    } catch {
      candidates.push('claude')
    }
    const fallback = (['claude', 'codex'] as const).find(v => !candidates.includes(v) && config.vendors[v].enabled)
    if (fallback) candidates.push(fallback)

    for (const item of queue) {
      await processQueueItem(item, candidates, { dryRun: opts.dryRun, yes: opts.yes, mode: config.mode })
    }
    return
  }

  if (!existsSync(LOG_DIR)) {
    console.error(chalk.yellow('No logs found. Run `crosscheck watch` first.'))
    return
  }

  const config = loadConfig(opts.config)
  const days = daysBetween(since)

  // --- Opportunity analysis mode (--opportunities) ---
  if (opts.opportunities) {
    const harness = loadIssueHarness(process.cwd())
    if (!harness) {
      console.error(chalk.red('✗ ISSUE.md harness not found — expected at project root or .crosscheck/ISSUE.md'))
      process.exit(1)
    }

    console.log(chalk.dim('  loading logs for opportunity analysis...'))
    const allEntries = loadRawLogEntries(since)
    if (allEntries.length === 0) {
      console.log('  No log entries found in range — nothing to analyze')
      return
    }
    console.log(chalk.dim(`  ${allEntries.length} events across ${days} day${days !== 1 ? 's' : ''}`))

    const prompt = buildOpportunityPrompt(harness, allEntries, days, config.mode)

    const candidates: Array<'claude' | 'codex'> = []
    try {
      const sel = selectOptimizeAgent(config, buildDiagnoseReport(since, LOG_DIR))
      candidates.push(sel.agent)
    } catch {
      candidates.push('claude')
    }
    const fallback = (['claude', 'codex'] as const).find(
      v => !candidates.includes(v) && config.vendors[v].enabled,
    )
    if (fallback) candidates.push(fallback)

    let agentOutput: string | undefined
    for (let i = 0; i < candidates.length; i++) {
      const agent = candidates[i] as 'claude' | 'codex'
      const reason = i === 0 ? 'selected by optimize logic' : `fallback — ${candidates[i - 1]} failed`
      console.log(chalk.dim(`  analyzing with ${agent} (${reason})...`))
      try {
        agentOutput = agent === 'claude'
          ? await runWithClaude(prompt)
          : await runWithCodex(prompt)
        break
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err)
        const hasNext = i < candidates.length - 1
        console.error(chalk.yellow(`  ✗ ${agent} failed: ${msg}${hasNext ? ' — trying next agent...' : ''}`))
      }
    }

    if (agentOutput === undefined) {
      console.error(chalk.red('✗ all configured agents failed'))
      process.exit(1)
    }

    const draftParsed = parseDraft(agentOutput)
    if (!draftParsed) {
      console.error(chalk.red('✗ Agent returned unexpected output format'))
      console.error(chalk.dim('  Expected: TITLE: line, then ---, then body'))
      process.exit(1)
    }

    const cleanDraft = sanitizeDraftContent(draftParsed.title, draftParsed.body)
    printDraft(cleanDraft.title, cleanDraft.body)

    if (opts.dryRun) {
      console.log(chalk.dim('  (dry run — not submitting)'))
      return
    }

    if (!opts.yes) {
      const confirmed = await ask(`  Submit to ${ISSUE_REPO}? [y/N]: `)
      if (!/^y(es)?$/i.test(confirmed)) {
        console.log('  Cancelled.')
        return
      }
    }

    await submitIssue(cleanDraft.title, cleanDraft.body, draftParsed.labels ?? ['improvement'])
    return
  }

  // --- Default mode: error-pattern bug report ---

  // 1. Scan logs for error patterns
  console.log(chalk.dim('  scanning logs...'))
  const report = buildDiagnoseReport(since, LOG_DIR)

  if (report.errors.length === 0) {
    console.log('  No errors found in recent logs — nothing to report')
    return
  }

  // 2. Select which error to report
  let errorIdx = 0
  if (report.errors.length > 1 && !opts.yes) {
    console.log(chalk.bold(`\n  Found ${report.errors.length} error patterns in the last ${days} day${days !== 1 ? 's' : ''}:\n`))
    report.errors.forEach((e, i) => {
      const label = errorLabel(e).padEnd(44)
      const rev = e.reviewer ? chalk.dim(` ${e.reviewer}`) : ''
      console.log(`  [${i + 1}] ${label} ×${e.count}${rev}`)
    })
    errorIdx = await pickOne(
      'Which issue do you want to report?',
      report.errors.map((_, i) => String(i + 1)),
    )
  }

  const selected = report.errors[errorIdx]
  if (!selected) {
    console.error(chalk.red('✗ Invalid selection'))
    process.exit(1)
  }

  // 3. Load representative log entries for this pattern
  const rawEntries = loadErrorEntriesForPattern(
    selected.pattern,
    selected.command,
    since,
  )

  // 4. Select agents — primary first, then other enabled vendor as fallback
  const candidates: Array<'claude' | 'codex'> = []
  let primaryReason = 'default'
  try {
    const sel = selectOptimizeAgent(config, report)
    candidates.push(sel.agent)
    primaryReason = sel.reason
  } catch {
    candidates.push('claude')
  }
  const fallbackVendor = (['claude', 'codex'] as const).find(
    v => !candidates.includes(v) && config.vendors[v].enabled,
  )
  if (fallbackVendor) candidates.push(fallbackVendor)

  // 5. Draft issue via AI agent — try each candidate in order
  const prompt = buildAgentPrompt(
    errorLabel(selected),
    selected.count,
    days,
    selected.reviewer,
    rawEntries,
    config.mode,
  )

  let agentOutput: string | undefined
  for (let i = 0; i < candidates.length; i++) {
    const agent = candidates[i] as 'claude' | 'codex'
    const reason = i === 0 ? primaryReason : `fallback — ${candidates[i - 1]} failed`
    console.log(chalk.dim(`  drafting issue with ${agent} (${reason})...`))
    try {
      agentOutput = agent === 'claude'
        ? await runWithClaude(prompt)
        : await runWithCodex(prompt)
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hasNext = i < candidates.length - 1
      console.error(chalk.yellow(`  ✗ ${agent} failed: ${msg}${hasNext ? ' — trying next agent...' : ''}`))
    }
  }

  if (agentOutput === undefined) {
    console.error(chalk.red('✗ all configured agents failed to draft the issue'))
    process.exit(1)
  }

  const draftParsed = parseDraft(agentOutput)
  if (!draftParsed) {
    console.error(chalk.red('✗ Agent returned unexpected output format'))
    console.error(chalk.dim('  Expected: TITLE: <title>\\n---\\n<body>'))
    process.exit(1)
  }

  // 6. Ask follow-up questions (skipped when --yes)
  const answers: QuestionAnswers = {
    reproducibility: 'Unknown',
    trigger: 'Unknown',
    impact: 'Degraded',
  }

  if (!opts.yes) {
    const repIdx = await pickOne(
      'Can you reproduce this consistently?',
      ['Every time', 'Sometimes', 'Happened once'],
    )
    answers.reproducibility = ['Every time', 'Sometimes', 'Happened once'][repIdx] as string

    const trigIdx = await pickOne(
      'Which command triggered this?',
      ['watch', 'review', 'Unknown'],
    )
    answers.trigger = ['watch', 'review', 'Unknown'][trigIdx] as string

    const impactIdx = await pickOne(
      'Is this blocking you from using crosscheck?',
      ['Blocked', 'Degraded', 'Cosmetic'],
    )
    answers.impact = ['Blocked', 'Degraded', 'Cosmetic'][impactIdx] as string
  }

  // 7. Build final content and show draft
  // Sanitize AI output before use — the agent may echo back content it received,
  // even if inputs were sanitized; this is the last gate before posting.
  const cleanDraft = sanitizeDraftContent(draftParsed.title, draftParsed.body)
  const { title, body } = buildIssueContent(cleanDraft, answers)
  printDraft(title, body)

  // 8. Submit
  if (opts.dryRun) {
    console.log(chalk.dim('  (dry run — not submitting)'))
    return
  }

  if (!opts.yes) {
    const confirmed = (await ask(`  Submit to ${ISSUE_REPO}? [y/N]: `))
    if (!/^y(es)?$/i.test(confirmed)) {
      console.log('  Cancelled.')
      return
    }
  }

  const labels = ['bug']
  if (answers.impact === 'Blocked') labels.push('priority:high')

  await submitIssue(title, body, labels)
}

async function submitIssue(title: string, body: string, labels: string[]): Promise<void> {
  const ghArgs = [
    'issue', 'create',
    '--repo', ISSUE_REPO,
    '--title', title,
    '--body', body,
    ...labels.flatMap(l => ['--label', l]),
  ]

  let issueUrl: string
  try {
    const result = await execa('gh', ghArgs, { timeout: 30_000 })
    issueUrl = (result.stdout ?? '').trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|not authenticated/i.test(msg)) {
      console.error(chalk.yellow('  gh is not authenticated — run: gh auth login'))
    } else {
      console.error(chalk.yellow(`  gh issue create failed: ${msg}`))
    }
    const escapedTitle = title.replace(/'/g, "'\\''")
    const escapedBody = body.replace(/'/g, "'\\''")
    const labelsStr = labels.map(l => `--label '${l}'`).join(' ')
    console.log('\n  Run this manually:')
    console.log(chalk.cyan(
      `  gh issue create --repo ${ISSUE_REPO} --title '${escapedTitle}' --body '${escapedBody}' ${labelsStr}`,
    ))
    process.exit(2)
  }

  console.log(chalk.green(`\n  ✓ issue created → ${issueUrl}`))
  console.log(chalk.dim('  Thank you for your support — your feedback helps improve crosscheck! 🙏'))
}

// ── Watch idle integration ────────────────────────────────────────────────────
// Called by the watch command when no PR activity is detected for the configured
// idle threshold. Runs an opportunity analysis and walks the user through a
// double-confirmation flow before filing a GitHub issue.

export async function runIssueFromWatchIdle(opts: {
  since?: string
  config?: string
  dryRun?: boolean
}): Promise<void> {
  if (!process.stdin.isTTY) return

  const since = opts.since ?? defaultSince()
  const days = daysBetween(since)

  // Step 1: Initial consent — ask before spending tokens on AI analysis.
  const consentAnswer = await ask(
    '\n  crosscheck has been idle — would you like me to analyze logs and create an improvement ticket? [y/N]: ',
  )
  if (!/^y(es)?$/i.test(consentAnswer)) {
    console.log(chalk.dim('  Skipped.'))
    return
  }

  const harness = loadIssueHarness(process.cwd())
  if (!harness) {
    console.log(chalk.yellow('  ✗ ISSUE.md harness not found — skipping opportunity analysis.'))
    return
  }

  console.log(chalk.dim(`\n  Loading logs for opportunity analysis (last ${days} day${days !== 1 ? 's' : ''})...`))
  const allEntries = loadRawLogEntries(since)
  if (allEntries.length === 0) {
    console.log(chalk.dim('  No log events found — nothing to analyze.'))
    return
  }

  let config
  try {
    config = loadConfig(opts.config)
  } catch {
    config = loadConfig()
  }

  const prompt = buildOpportunityPrompt(harness, allEntries, days, config.mode)

  const candidates: Array<'claude' | 'codex'> = []
  try {
    const sel = selectOptimizeAgent(config, buildDiagnoseReport(since, LOG_DIR))
    candidates.push(sel.agent)
  } catch {
    candidates.push('claude')
  }
  const fallback = (['claude', 'codex'] as const).find(v => !candidates.includes(v) && config.vendors[v].enabled)
  if (fallback) candidates.push(fallback)

  let agentOutput: string | undefined
  for (let i = 0; i < candidates.length; i++) {
    const agent = candidates[i] as 'claude' | 'codex'
    const reason = i === 0 ? 'selected by optimize logic' : `fallback — ${candidates[i - 1]} failed`
    console.log(chalk.dim(`  Analyzing with ${agent} (${reason})...`))
    try {
      agentOutput = agent === 'claude'
        ? await runWithClaude(prompt)
        : await runWithCodex(prompt)
      break
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const hasNext = i < candidates.length - 1
      console.error(chalk.yellow(`  ✗ ${agent} failed: ${msg}${hasNext ? ' — trying next agent...' : ''}`))
    }
  }

  if (agentOutput === undefined) {
    console.error(chalk.yellow('  ✗ All configured agents failed — try again later.'))
    return
  }

  const draftParsed = parseDraft(agentOutput)
  if (!draftParsed) {
    console.error(chalk.yellow('  ✗ Unexpected output format from agent — skipping.'))
    return
  }

  const cleanDraft = sanitizeDraftContent(draftParsed.title, draftParsed.body)

  // Step 2: Show draft summary and ask for first confirmation.
  console.log('\n  Here is the draft ticket:')
  printDraft(cleanDraft.title, cleanDraft.body)

  if (opts.dryRun) {
    console.log(chalk.dim('  (dry run — not submitting)'))
    return
  }

  const firstConfirm = await ask(`  Submit this ticket to ${ISSUE_REPO}? [y/N]: `)
  if (!/^y(es)?$/i.test(firstConfirm)) {
    console.log(chalk.dim('  Cancelled.'))
    return
  }

  // Step 3: Show summary again and ask final double-confirmation.
  const width = Math.min(process.stdout.columns ?? 80, 80)
  const bar = '─'.repeat(width)
  console.log(`\n  ${chalk.bold('Final summary:')}\n  ${chalk.dim(bar)}`)
  console.log(`  ${chalk.bold(cleanDraft.title)}`)
  console.log(`  ${chalk.dim(bar)}`)
  const bodyPreview = cleanDraft.body.split('\n').slice(0, 5).map(l => `  ${l}`).join('\n')
  console.log(bodyPreview)
  if (cleanDraft.body.split('\n').length > 5) console.log(chalk.dim('  ...'))
  console.log(`  ${chalk.dim(bar)}\n`)

  const finalConfirm = await ask(`  Confirm submission to ${ISSUE_REPO}? [y/N]: `)
  if (!/^y(es)?$/i.test(finalConfirm)) {
    console.log(chalk.dim('  Submission cancelled.'))
    return
  }

  // Use a local submit that never calls process.exit — the caller is a long-running
  // watch session and an issue-filing failure must not terminate it.
  const labels = draftParsed.labels ?? ['improvement']
  const ghArgs = [
    'issue', 'create',
    '--repo', ISSUE_REPO,
    '--title', cleanDraft.title,
    '--body', cleanDraft.body,
    ...labels.flatMap(l => ['--label', l]),
  ]
  try {
    const result = await execa('gh', ghArgs, { timeout: 30_000 })
    const issueUrl = (result.stdout ?? '').trim()
    console.log(chalk.green(`\n  ✓ Issue created → ${issueUrl}`))
    console.log(chalk.dim('  Thank you for your support — your feedback helps improve crosscheck! 🙏'))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    console.error(chalk.yellow(`  ✗ gh issue create failed: ${msg}`))
    const escapedTitle = cleanDraft.title.replace(/'/g, "'\\''")
    const escapedBody = cleanDraft.body.replace(/'/g, "'\\''")
    const labelsStr = labels.map(l => `--label '${l}'`).join(' ')
    console.log(chalk.dim(`\n  Run manually: gh issue create --repo ${ISSUE_REPO} --title '${escapedTitle}' --body '${escapedBody}' ${labelsStr}`))
  }
}
