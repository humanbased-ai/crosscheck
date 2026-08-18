import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { saveToIssueQueue } from '../lib/issue-queue.js'
import type { StepRecord, NextStepResult } from '../lib/pr-workflow-state.js'

const LOG_DIR = join(homedir(), '.crosscheck', 'logs')

type ErrorPattern =
  | 'command_not_found'
  | 'base_branch_missing'
  | 'timeout'
  | 'rate_limit'    // 429 - GitHub or model API rate limit
  | 'overloaded'    // 529 - upstream model API temporarily overloaded
  | 'budget'        // per-review budget cap reached
  | 'auth_failure'
  | 'other'

interface ErrorEntry {
  pattern: ErrorPattern
  command?: string
  branch?: string
  count: number
  reviewer?: string
}

interface ReviewerPerf {
  attempts: number
  successes: number
  failure_rate: number
  by_step_type?: Record<string, { attempts: number; successes: number }>
}

interface Suggestion {
  type: 'add_constraint' | 'investigate' | 'config_change'
  instruction?: string
  reason: string
}

export interface DiagnoseReport {
  period: { from: string; to: string; log_files: number }
  summary: { total_reviews: number; successful: number; failed: number; failure_rate: number }
  errors: ErrorEntry[]
  verdict_distribution: { APPROVE: number; NEEDS_WORK: number; BLOCK: number }
  verdict_parse_failures: number
  repos_seen: string[]
  languages_detected: string[]
  reviewer_performance: Record<string, ReviewerPerf>
  suggestions: Suggestion[]
}

// Maps command names to language identifiers
const COMMAND_LANGUAGE_MAP: Record<string, string[]> = {
  tsc: ['typescript'], 'ts-node': ['typescript'], tsx: ['typescript'],
  npm: ['nodejs'], npx: ['nodejs'], yarn: ['nodejs'], pnpm: ['nodejs'],
  jest: ['nodejs'], vitest: ['nodejs'], mocha: ['nodejs'],
  pytest: ['python'], pip: ['python'], python: ['python'], python3: ['python'],
  cargo: ['rust'],
  go: ['golang'],
  mvn: ['java'], gradle: ['java'],
  rspec: ['ruby'], bundle: ['ruby'],
}

// Language id → constraint instruction.
// Keys must be a subset of the language ids produced by INDICATORS and COMMAND_LANGUAGE_MAP.
// "jest" was a dead key — jest/vitest/mocha all map to "nodejs" in COMMAND_LANGUAGE_MAP.
const LANGUAGE_CONSTRAINT_MAP: Record<string, string> = {
  typescript: 'Do not run tsc, ts-node, or tsx.',
  nodejs: 'Do not run npm, npx, yarn, pnpm, jest, vitest, or mocha.',
  python: 'Do not run pytest, pip, or python scripts.',
  rust: 'Do not run cargo build or cargo test.',
  golang: 'Do not run go build or go test.',
  java: 'Do not run mvn or gradle.',
  ruby: 'Do not run bundle exec or rspec.',
}


interface LogEntry {
  ts: string
  level: string
  event: string
  message?: string
  pr?: number
  repo?: string
  reviewer?: string
  verdict?: string
  [key: string]: unknown
}

function parseLogFile(path: string): LogEntry[] {
  const entries: LogEntry[] = []
  const lines = readFileSync(path, 'utf8').split('\n')
  for (const line of lines) {
    if (!line.trim()) continue
    try { entries.push(JSON.parse(line) as LogEntry) } catch { /* skip malformed */ }
  }
  return entries
}

export function classifyError(message: string): { pattern: ErrorPattern; command?: string; branch?: string } {
  const cmdMatch = message.match(/(?:sh:|bash:|zsh:)?\s*([a-zA-Z0-9_-]+):\s*(?:command not found|not found)/i)
  if (cmdMatch) return { pattern: 'command_not_found', command: cmdMatch[1].toLowerCase() }

  const branchMatch = message.match(/fatal: no such branch:?\s*'?([^\s'"]+)'?/i)
  if (branchMatch) return { pattern: 'base_branch_missing', branch: branchMatch[1] }

  // Transient model-API conditions are matched before the broad auth check so a
  // 429/529/budget body that also mentions credentials isn't swallowed as an auth
  // failure. Mirrors logger.classifyError so the issue/diagnose summary lines up
  // with the categories recorded in the logs.
  // Word-boundary the numeric codes so they don't match digits embedded in
  // durations/counts/ports (e.g. "timed out after 5290ms" must not read as 529).
  if (/rate limit|secondary rate|\b429\b/i.test(message)) return { pattern: 'rate_limit' }
  if (/\b529\b|overloaded/i.test(message)) return { pattern: 'overloaded' }
  if (/maximum budget|budget (?:exhausted|exceeded)|error_max_budget|reached maximum budget/i.test(message)) return { pattern: 'budget' }

  if (/timed? ?out|etimedout/i.test(message)) return { pattern: 'timeout' }

  if (/bad credentials|401|unauthorized|auth failure|authentication failed/i.test(message)) return { pattern: 'auth_failure' }

  return { pattern: 'other' }
}

function detectLanguagesFromCommands(errors: ErrorEntry[]): string[] {
  const detected = new Set<string>()
  for (const e of errors) {
    if (e.pattern === 'command_not_found' && e.command) {
      const langs = COMMAND_LANGUAGE_MAP[e.command] ?? []
      for (const l of langs) detected.add(l)
    }
  }
  return [...detected]
}

function buildSuggestions(errors: ErrorEntry[], _languages: string[]): Suggestion[] {
  const suggestions: Suggestion[] = []
  const seen = new Set<string>()

  for (const e of errors) {
    if (e.pattern === 'command_not_found' && e.command) {
      const langs = COMMAND_LANGUAGE_MAP[e.command] ?? []
      for (const lang of langs) {
        const instruction = LANGUAGE_CONSTRAINT_MAP[lang]
        if (instruction && !seen.has(instruction)) {
          seen.add(instruction)
          suggestions.push({
            type: 'add_constraint',
            instruction,
            reason: `${e.command}: command not found ×${e.count}${e.reviewer ? ` (${e.reviewer})` : ''}`,
          })
        }
      }
    }

    if (e.pattern === 'base_branch_missing' && !seen.has('base_branch_missing')) {
      seen.add('base_branch_missing')
      suggestions.push({
        type: 'investigate',
        reason: `base branch '${e.branch}' not found ×${e.count} — verify the branch is fetched before review`,
      })
    }

    if (e.pattern === 'timeout' && e.count >= 2 && !seen.has('timeout')) {
      seen.add('timeout')
      suggestions.push({
        type: 'config_change',
        reason: `review timed out ×${e.count} — consider lowering quality.tier to "fast" or "balanced"`,
      })
    }

    if ((e.pattern === 'rate_limit' || e.pattern === 'overloaded') && e.count >= 2 && !seen.has('transient_capacity')) {
      seen.add('transient_capacity')
      suggestions.push({
        type: 'investigate',
        reason: `transient vendor-capacity errors (${e.pattern}) ×${e.count} — add retry/backoff or stagger concurrent reviews`,
      })
    }

    if (e.pattern === 'budget' && !seen.has('budget')) {
      seen.add('budget')
      suggestions.push({
        type: 'config_change',
        reason: `per-review budget exhausted ×${e.count} — raise the budget cap or lower quality.tier`,
      })
    }
  }

  return suggestions
}

function collectLogFiles(since?: string, logDir = LOG_DIR): string[] {
  if (!existsSync(logDir)) return []
  return readdirSync(logDir)
    .filter(f => f.endsWith('.ndjson'))
    .filter(f => !since || f.replace('.ndjson', '') >= since)
    .sort()
    .map(f => join(logDir, f))
}

export function buildDiagnoseReport(since?: string, logDir?: string): DiagnoseReport {
  const files = collectLogFiles(since, logDir)
  const allEntries: LogEntry[] = files.flatMap(parseLogFile)

  // Track review lifecycle: review_started → review_complete
  const started = new Map<string, LogEntry>()     // key: `${repo}#${pr}`
  const completed = new Set<string>()

  const errorPatterns = new Map<string, ErrorEntry>()
  const verdicts = { APPROVE: 0, NEEDS_WORK: 0, BLOCK: 0 }
  let verdictParseFailures = 0
  const reposSeen = new Set<string>()
  const languagesSeen = new Set<string>()   // from review_started log events
  const reviewerStats = new Map<string, { attempts: number; successes: number; byStepType: Map<string, { attempts: number; successes: number }> }>()

  for (const e of allEntries) {
    if (e.repo) reposSeen.add(e.repo)

    if (e.event === 'review_started') {
      const key = `${e.repo}#${e.pr}`
      started.set(key, e)
      const r = e.reviewer ?? 'unknown'
      if (!reviewerStats.has(r)) reviewerStats.set(r, { attempts: 0, successes: 0, byStepType: new Map() })
      const stats = reviewerStats.get(r)!
      stats.attempts++
      const stepType = (e['step_type'] as string | undefined) ?? 'other'
      if (!stats.byStepType.has(stepType)) stats.byStepType.set(stepType, { attempts: 0, successes: 0 })
      stats.byStepType.get(stepType)!.attempts++
      // Collect languages detected at review time
      if (Array.isArray(e['languages'])) {
        for (const lang of e['languages'] as string[]) languagesSeen.add(lang)
      }
    }

    if (e.event === 'review_complete') {
      const key = `${e.repo}#${e.pr}`
      completed.add(key)
      const r = e.reviewer ?? 'unknown'
      const stats = reviewerStats.get(r)
      if (stats) {
        stats.successes++
        const stepType = (started.get(key)?.['step_type'] as string | undefined) ?? 'other'
        const stEntry = stats.byStepType.get(stepType)
        if (stEntry) stEntry.successes++
      }
      if (e.verdict) {
        const v = e.verdict as keyof typeof verdicts
        if (v in verdicts) verdicts[v]++
      }
    }

    if (e.event === 'verdict_parse_failed') {
      verdictParseFailures++
    }

    if (e.event === 'error' && e.level === 'error') {
      const msg = e.message ?? ''
      const { pattern, command, branch } = classifyError(msg)

      // Derive reviewer from the active review_started entry for this repo+PR.
      // The message itself never starts with "codex:" or "claude:" — that regex was dead.
      const key = `${e.repo}#${e.pr}`
      const reviewer = started.get(key)?.reviewer

      const mapKey = pattern === 'command_not_found' ? `cmd:${command}` : pattern
      if (errorPatterns.has(mapKey)) {
        errorPatterns.get(mapKey)!.count++
      } else {
        errorPatterns.set(mapKey, { pattern, command, branch, count: 1, reviewer })
      }
    }
  }

  const errors = [...errorPatterns.values()].sort((a, b) => b.count - a.count)
  // Merge: languages from log events + languages inferred from command errors
  const languagesFromErrors = detectLanguagesFromCommands(errors)
  const languages = [...new Set([...languagesSeen, ...languagesFromErrors])]
  const suggestions = buildSuggestions(errors, languages)

  if (verdictParseFailures > 0) {
    suggestions.push({
      type: 'investigate',
      reason: `Codex returned no verdict line ×${verdictParseFailures} — check your .codex/instructions file or lower vendors.codex.quality to "low"`,
    })
  }

  const fromDate = files[0]?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A'
  const toDate = files.at(-1)?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A'

  const totalReviews = started.size
  const successfulReviews = completed.size
  // Guard against negative count: review_complete can exceed review_started when
  // --since truncates the log window and some review_started events fall outside it.
  const failedReviews = Math.max(0, totalReviews - successfulReviews)

  const reviewer_performance: Record<string, ReviewerPerf> = {}
  for (const [name, stats] of reviewerStats.entries()) {
    const by_step_type: Record<string, { attempts: number; successes: number }> = {}
    for (const [st, stStats] of stats.byStepType.entries()) {
      by_step_type[st] = { attempts: stStats.attempts, successes: stStats.successes }
    }
    reviewer_performance[name] = {
      attempts: stats.attempts,
      successes: stats.successes,
      failure_rate: stats.attempts > 0 ? (stats.attempts - stats.successes) / stats.attempts : 0,
      ...(stats.byStepType.size > 1 ? { by_step_type } : {}),
    }
  }

  return {
    period: { from: fromDate, to: toDate, log_files: files.length },
    summary: {
      total_reviews: totalReviews,
      successful: successfulReviews,
      failed: failedReviews,
      failure_rate: totalReviews > 0 ? failedReviews / totalReviews : 0,
    },
    errors,
    verdict_distribution: verdicts,
    verdict_parse_failures: verdictParseFailures,
    repos_seen: [...reposSeen],
    languages_detected: languages,
    reviewer_performance,
    suggestions,
  }
}

function pct(n: number, total: number): string {
  return total === 0 ? '—' : `${Math.round((n / total) * 100)}%`
}

function printReport(report: DiagnoseReport): void {
  const { period, summary, errors, verdict_distribution: vd, reviewer_performance: rp, suggestions } = report
  const total = vd.APPROVE + vd.NEEDS_WORK + vd.BLOCK

  console.log(chalk.bold('\ncrosscheck diagnose\n'))
  console.log(chalk.dim(`  Period   ${period.from} → ${period.to}  (${period.log_files} log file${period.log_files !== 1 ? 's' : ''})`))
  console.log()

  console.log(chalk.dim('  Reviews'))
  console.log(`    total       ${summary.total_reviews}`)
  console.log(`    successful  ${chalk.green(summary.successful)}`)
  console.log(`    failed      ${summary.failed > 0 ? chalk.red(summary.failed) : chalk.green(summary.failed)}  ${summary.failed > 0 ? chalk.dim(`(${pct(summary.failed, summary.total_reviews)} failure rate)`) : ''}`)
  if (report.verdict_parse_failures > 0) {
    console.log(`    no verdict  ${chalk.yellow(report.verdict_parse_failures)}  ${chalk.dim('(review completed but no VERDICT line found)')}`)
  }
  console.log()

  if (Object.keys(rp).length > 0) {
    console.log(chalk.dim('  Reviewer performance'))
    for (const [name, perf] of Object.entries(rp)) {
      const rate = perf.attempts > 0 ? Math.round((perf.successes / perf.attempts) * 100) : 0
      const indicator = rate >= 80 ? chalk.green(`${rate}%`) : rate >= 50 ? chalk.yellow(`${rate}%`) : chalk.red(`${rate}%`)
      console.log(`    ${name.padEnd(8)} ${perf.successes}/${perf.attempts} success  ${indicator}`)
      if (perf.by_step_type) {
        for (const [st, stPerf] of Object.entries(perf.by_step_type)) {
          const stRate = stPerf.attempts > 0 ? Math.round((stPerf.successes / stPerf.attempts) * 100) : 0
          const stIndicator = stRate >= 80 ? chalk.green(`${stRate}%`) : stRate >= 50 ? chalk.yellow(`${stRate}%`) : chalk.red(`${stRate}%`)
          console.log(`             ${chalk.dim(st.padEnd(10))} ${stPerf.successes}/${stPerf.attempts}  ${stIndicator}`)
        }
      }
    }
    console.log()
  }

  if (total > 0) {
    console.log(chalk.dim('  Verdict distribution'))
    console.log(`    APPROVE     ${vd.APPROVE}  ${chalk.dim(pct(vd.APPROVE, total))}`)
    console.log(`    NEEDS WORK  ${vd.NEEDS_WORK}  ${chalk.dim(pct(vd.NEEDS_WORK, total))}`)
    console.log(`    BLOCK       ${vd.BLOCK}  ${chalk.dim(pct(vd.BLOCK, total))}`)
    console.log()
  }

  if (errors.length > 0) {
    console.log(chalk.dim('  Error patterns'))
    for (const e of errors) {
      const label = e.pattern === 'command_not_found' ? `command not found: ${e.command}`
        : e.pattern === 'base_branch_missing' ? `base branch missing: ${e.branch}`
        : e.pattern === 'rate_limit' ? 'rate limit (429)'
        : e.pattern === 'overloaded' ? 'API overloaded (529)'
        : e.pattern === 'budget' ? 'budget exhausted'
        : e.pattern
      console.log(`    ${chalk.red('✗')} ${label.padEnd(40)} ×${e.count}${e.reviewer ? chalk.dim(`  (${e.reviewer})`) : ''}`)
    }
    console.log()
  }

  if (report.languages_detected.length > 0) {
    console.log(chalk.dim('  Languages detected'))
    console.log(`    ${report.languages_detected.join(', ')}`)
    console.log()
  }

  if (suggestions.length > 0) {
    console.log(chalk.dim('  Suggestions'))
    for (const s of suggestions) {
      const icon = s.type === 'add_constraint' ? chalk.yellow('→') : chalk.dim('→')
      console.log(`    ${icon} ${s.reason}`)
      if (s.instruction) console.log(`      ${chalk.cyan(`add to workflow.yml review step instructions: "${s.instruction}"`)}`)
    }
    console.log()
    console.log(chalk.dim('  Run `crosscheck optimize` to apply suggestions automatically.'))
  } else if (summary.total_reviews > 0) {
    console.log(chalk.green('  ✓ No actionable issues found.'))
  }

  console.log()
}

export async function runDiagnose(opts: { json?: boolean; since?: string; pr?: string }): Promise<void> {
  if (opts.pr) {
    return runDiagnoseForPR(opts.pr, opts)
  }

  if (!existsSync(LOG_DIR)) {
    if (opts.json) {
      console.log(JSON.stringify({ error: 'No log directory found. Run crosscheck watch first.' }))
    } else {
      console.error(chalk.yellow('No logs found. Run `crosscheck watch` first.'))
    }
    return
  }

  const report = buildDiagnoseReport(opts.since, LOG_DIR)

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  printReport(report)
}

// ── PR-specific analysis ──────────────────────────────────────────────────────

function parsePRUrlForDiagnose(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

interface PRLogEvent {
  ts: string
  event: string
  reason?: string
  sha?: string
  reviewer?: string
  verdict?: string
  message?: string
}

function loadPRLogEvents(repoKey: string, prNumber: number, since?: string): PRLogEvent[] {
  const events: PRLogEvent[] = []
  if (!existsSync(LOG_DIR)) return events
  const normalizedRepo = repoKey.toLowerCase()
  const sinceMs = since ? new Date(since).getTime() : 0
  for (const f of readdirSync(LOG_DIR).sort()) {
    if (!f.endsWith('.ndjson')) continue
    // Fast-path: skip files whose date prefix is before --since
    if (since && f.replace('.ndjson', '') < since.slice(0, 10)) continue
    const lines = readFileSync(join(LOG_DIR, f), 'utf8').split('\n')
    for (const line of lines) {
      if (!line.trim()) continue
      try {
        const entry = JSON.parse(line) as LogEntry
        const entryRepo = (entry.repo as string | undefined)?.toLowerCase()
        const entryPr = entry.pr as number | undefined
        if (entryRepo !== normalizedRepo || entryPr !== prNumber) continue
        if (sinceMs > 0 && new Date(entry.ts).getTime() < sinceMs) continue
        events.push({
          ts: entry.ts,
          event: entry.event,
          reason: entry['reason'] as string | undefined,
          sha: entry['sha'] as string | undefined,
          reviewer: entry.reviewer,
          verdict: entry.verdict,
          message: entry.message,
        })
      } catch { /* skip malformed */ }
    }
  }
  return events
}

function fmtDatetime(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function fmtDatetimeSec(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}`
}

function verdictStr(verdict: string | undefined): string {
  if (!verdict) return chalk.dim('?')
  if (verdict === 'APPROVE') return chalk.green(verdict)
  if (verdict === 'BLOCK') return chalk.red(verdict)
  return chalk.yellow(verdict)
}

// SKIP_REASON_LABELS maps pr_skipped reason values to human-readable labels.
const SKIP_REASON_LABELS: Record<string, string> = {
  author_not_allowed: 'author filtered',
  no_reviewer: 'no reviewer assigned',
  workflow_complete: 'workflow already complete',
  in_progress_local: 'review in progress (local lock)',
  in_progress_remote: 'review in progress (remote lock)',
  no_diff_change: 'diff unchanged since last review',
  crosscheck_sha: 'commit pushed by crosscheck (fix step)',
  annotation_injection_blocked: 'annotation injection blocked',
  comment_self_trigger: 'triggered by own comment (skipped)',
  comment_stale_sha: 'stale SHA in comment annotation',
}

// Returns true when a skip reason is likely unexpected from a user perspective.
function isUnexpectedSkip(reason: string | undefined): boolean {
  if (!reason) return false
  return ['author_not_allowed', 'no_reviewer'].includes(reason)
}

function buildStepRecs(history: StepRecord[], logEvents: PRLogEvent[], nextResult: NextStepResult | null, prUrl: string): string[] {
  const recs: string[] = []
  const seen = new Set<string>()

  const addRec = (key: string, msg: string) => {
    if (!seen.has(key)) { seen.add(key); recs.push(msg) }
  }

  for (const ev of logEvents) {
    if (ev.event !== 'pr_skipped') continue
    const r = ev.reason ?? ''
    if (r === 'author_not_allowed') {
      addRec(r, 'Add the PR author to `routing.allowed_authors` in your config so crosscheck reviews their PRs.')
    }
    if (r === 'no_reviewer') {
      addRec(r, 'No reviewer was assigned. Enable at least one vendor (claude/codex) in your config under `vendors`.')
    }
    if (r === 'no_diff_change') {
      addRec(r, 'The diff was unchanged since the last review (force-push/amend with no content change). This is expected behavior.')
    }
    if (r === 'in_progress_local' || r === 'in_progress_remote') {
      addRec('in_progress', 'The PR was skipped because another review was already in progress. Retry once the in-flight review completes.')
    }
  }

  if (nextResult?.step != null) {
    const step = nextResult.step.type
    if (step === 'fix') {
      addRec('pending_fix', `Fix step is pending. Run manually: crosscheck run ${prUrl} --steps fix`)
      addRec('pending_fix_watch', 'Or ensure `crosscheck watch` is running and listening to this repo.')
    }
    if (step === 'recheck') {
      addRec('pending_recheck', `Recheck is pending. Run manually: crosscheck run ${prUrl} --steps recheck`)
    }
    if (step === 'review') {
      addRec('pending_review', `Review has not run yet. Trigger it with: crosscheck review ${prUrl}`)
    }
    if (step === 'conflict-resolve') {
      addRec('pending_conflict_resolve', `PR has merge conflicts that must be resolved before the workflow can continue. Resolve the conflicts, push, and re-run: ${chalk.cyan(`crosscheck run ${prUrl}`)}`)
    }
  }

  return recs
}

async function runDiagnoseForPR(prUrl: string, opts: { json?: boolean; since?: string; config?: string }): Promise<void> {
  const parsed = parsePRUrlForDiagnose(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed
  const repoKey = `${owner}/${repo}`

  // Lazy import — PR mode requires GitHub auth; no-arg mode does not.
  const { getGithubToken } = await import('../config/loader.js')
  const { createGithubClient } = await import('../github/client.js')
  const { fetchStepHistory, identifyNextWorkflowStep } = await import('../lib/pr-workflow-state.js')
  const { loadWorkflow } = await import('../lib/workflow.js')

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  let history: StepRecord[] = []
  let nextResult: NextStepResult | null = null
  let prTitle = ''
  let currentSha = ''
  let fetchError = ''

  try {
    const octokit = createGithubClient(token)
    const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
    prTitle = prData.title
    currentSha = prData.head.sha
    const steps = loadWorkflow(process.cwd())
    history = await fetchStepHistory(owner, repo, number, token)
    nextResult = identifyNextWorkflowStep(history, steps, currentSha, { mergeable: prData.mergeable })
  } catch (err) {
    fetchError = err instanceof Error ? err.message : String(err)
  }

  // ── Early exit on fetch failure ──────────────────────────────────────────
  if (fetchError) {
    if (opts.json) {
      console.log(JSON.stringify({
        pr: { url: prUrl, number, repo: repoKey },
        fetch_error: fetchError,
        ...(opts.since && { since: opts.since }),
      }, null, 2))
    } else {
      console.error(chalk.red(`✗ Could not fetch PR data: ${fetchError}`))
      console.error(chalk.dim('  Verify your GITHUB_TOKEN and that the PR URL is correct.'))
    }
    process.exit(1)
  }

  const logEvents = loadPRLogEvents(repoKey, number, opts.since)
  const recs = buildStepRecs(history, logEvents, nextResult, prUrl)
  const workflowComplete = nextResult?.step === null && history.length > 0

  // ── JSON output mode ─────────────────────────────────────────────────────
  if (opts.json) {
    console.log(JSON.stringify({
      pr: { url: prUrl, number, repo: repoKey, title: prTitle, headSha: currentSha },
      ...(opts.since && { since: opts.since }),
      step_history: history.map(r => ({
        type: r.type, verdict: r.verdict, sha: r.sha, pushedSha: r.pushedSha,
        round: r.round, reviewer: r.reviewer, createdAt: r.createdAt, source: r.source,
      })),
      pending_step: nextResult?.step ? nextResult.step.type : null,
      workflow_complete: workflowComplete,
      log_events: logEvents,
      recommendations: recs,
    }, null, 2))
    return
  }

  // ── Human-readable output ─────────────────────────────────────────────────

  console.log(chalk.bold(`\ncrosscheck diagnose — PR #${number}\n`))
  console.log(chalk.dim(`  ${prUrl}\n`))

  const divider = chalk.dim('─'.repeat(68))

  // ── Step 01: Workflow History ─────────────────────────────────────────────
  console.log(chalk.bold('  Step 01') + chalk.dim(' — Workflow History'))
  if (prTitle) console.log(chalk.dim(`  PR: "${prTitle}"  ·  HEAD: ${currentSha.slice(0, 7)}`))
  console.log(`  ${divider}\n`)

  if (history.length === 0) {
    console.log(chalk.dim('    (no crosscheck steps found on this PR)'))
  } else {
    const typeWidth = Math.max(...history.map(r => r.type.length))
    for (let i = 0; i < history.length; i++) {
      const r = history[i]
      const idx = chalk.dim(String(i + 1).padStart(2))
      const date = chalk.dim(fmtDatetime(r.createdAt))
      const type = r.type.padEnd(typeWidth)
      const reviewer = r.reviewer ? chalk.cyan(r.reviewer) : chalk.dim('—')
      const sha = (r.sha ?? r.pushedSha) ? chalk.dim(`sha=${(r.sha ?? r.pushedSha)!.slice(0, 7)}`) : ''
      const verdict = (r.type === 'review' || r.type === 'recheck') ? verdictStr(r.verdict) : ''
      const parts = [reviewer, sha, verdict].filter(Boolean).join('  ')
      console.log(`    ${idx}  ${date}  ${type}  ${parts}`)
    }
  }

  // Show pending step as a skip marker attached to the last recorded step
  if (nextResult?.step != null) {
    const idx = chalk.yellow(String(history.length + 1).padStart(2))
    const label = chalk.yellow(`[expected: ${nextResult.step.type}]`)
    console.log(`   ${chalk.yellow('*')}${idx}  ${chalk.dim('(pending)')}         ${label}  ${chalk.dim('— not yet executed')}`)
  } else if (nextResult?.step === null && history.length > 0) {
    const lastVerdict = [...history].reverse().find(r => r.verdict)?.verdict
    console.log()
    console.log(`    ${chalk.green('✓')} Workflow complete${lastVerdict ? ` — last verdict: ${verdictStr(lastVerdict)}` : ''}`)
  }

  console.log()

  // ── Step 02: Execution Log Events ────────────────────────────────────────
  console.log(chalk.bold('  Step 02') + chalk.dim(' — Execution Log Events'))
  console.log(chalk.dim(`  Legend: ${chalk.yellow('*')} skip  ${chalk.green('✓')} completed  ${chalk.red('✗')} failed  ${chalk.dim('·')} info`))
  console.log(`  ${divider}\n`)

  if (logEvents.length === 0) {
    console.log(chalk.dim('    (no log events found — logs may predate this PR or have been cleared)'))
  } else {
    for (let i = 0; i < logEvents.length; i++) {
      const ev = logEvents[i]
      const isSkip = ev.event === 'pr_skipped'
      const isFail = ev.event === 'error'
      const isComplete = ev.event === 'review_complete'
      const isUnexpected = isSkip && isUnexpectedSkip(ev.reason)

      const markerIcon = isSkip ? chalk.yellow('*') : isComplete ? chalk.green('✓') : isFail ? chalk.red('✗') : chalk.dim('·')
      const idx = String(i + 1).padStart(3)
      const date = chalk.dim(fmtDatetimeSec(ev.ts))
      const eventLabel = isSkip ? (isUnexpected ? chalk.yellow(ev.event) : chalk.dim(ev.event))
        : isFail ? chalk.red(ev.event)
        : isComplete ? chalk.green(ev.event)
        : ev.event

      const details: string[] = []
      if (ev.reason) {
        const label = SKIP_REASON_LABELS[ev.reason] ?? ev.reason
        details.push(isUnexpected ? chalk.yellow(label) : chalk.dim(label))
      }
      if (ev.reviewer) details.push(chalk.cyan(ev.reviewer))
      if (ev.verdict) details.push(verdictStr(ev.verdict))
      if (ev.sha) details.push(chalk.dim(`sha=${ev.sha.slice(0, 7)}`))

      console.log(`   ${markerIcon} ${idx}  ${date}  ${eventLabel.padEnd(22)}  ${details.join('  ')}`)
    }
  }

  console.log()

  // ── Step 03: Recommendations ─────────────────────────────────────────────
  console.log(chalk.bold('  Step 03') + chalk.dim(' — Recommendations'))
  console.log(`  ${divider}\n`)

  if (recs.length > 0) {
    for (const rec of recs) {
      console.log(`    ${chalk.yellow('→')} ${rec}`)
    }
    console.log()
    console.log(chalk.dim('  Run `crosscheck diagnose` (without --pr) to see overall log health.'))
    console.log()
    return
  }

  // No recommendations could be generated — save to issue queue and offer to file a ticket.
  if (workflowComplete) {
    const lastVerdict = [...history].reverse().find(r => r.verdict)?.verdict
    console.log(`    ${chalk.green('✓')} No issues detected — workflow completed (${lastVerdict ?? 'no verdict'}).`)
    console.log()
    return
  }

  // Genuine dead-end: no recommendations, workflow not complete, no clear explanation.
  console.log(chalk.dim('    No specific recommendations could be generated for this PR state.'))
  console.log(chalk.dim('    This may indicate an unusual workflow state or insufficient log data.'))
  console.log()

  const context = history.length > 0
    ? `PR has ${history.length} step(s) in history (last: ${history[history.length - 1]?.type ?? 'unknown'}). ` +
      (nextResult?.step ? `Expected next step: ${nextResult.step.type}.` : 'Workflow state unclear.')
    : 'No step history found for this PR.'

  const userAnticipation = nextResult?.step != null
    ? `User expected ${nextResult.step.type} step to execute after the last recorded step.`
    : 'User expected the workflow to progress but no clear next step is identified.'

  const currentStatus = logEvents.length > 0
    ? `${logEvents.length} log events found. Last event: ${logEvents[logEvents.length - 1]?.event ?? 'unknown'}.`
    : 'No log events found for this PR.'

  const record = {
    ts: new Date().toISOString(),
    pr_url: prUrl,
    repo: repoKey,
    pr_number: number,
    context,
    user_anticipation: userAnticipation,
    current_status: currentStatus,
    source: 'diagnose-pr' as const,
  }

  const queuePath = saveToIssueQueue(record)
  console.log(chalk.dim(`    Issue record saved → ${queuePath}`))
  console.log()
  console.log(chalk.dim('  Run `crosscheck issue --from-queue` to file a GitHub ticket for this.'))
  console.log()
}
