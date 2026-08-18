import chalk from 'chalk'
import { stdin as input, stdout as output } from 'process'
import { createInterface } from 'readline/promises'
import { execa } from 'execa'
import { resolveCliInvocation, type CliInvocation } from '../lib/cli-invocation.js'
import { createGithubClient } from '../github/client.js'
import { getGithubToken, loadConfig } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import { parseDuration } from '../lib/durations.js'
import { classifyError, logError } from '../lib/logger.js'
import type { ErrorCategory } from '../lib/logger.js'
import { hintForError } from '../lib/remediation.js'
import { pickPRs } from '../lib/pr-picker.js'
import type { ScanPRStatus as PRStatus, ScanResult } from '../lib/pr-status.js'
import { handleScanError, loadScanResult } from './scan.js'
import { shaCovers } from '../lib/pr-workflow-state.js'
import { PRBoard } from '../lib/board.js'
import { loadWorkflow } from '../lib/workflow.js'

export interface KickassOpts {
  force?: boolean
  staleAfter?: string
  dryRun?: boolean
  roundMode?: 'crazy' | 'halfcrazy'
  timeout?: string
  concurrent?: number  // parallel agents; undefined/0 = one per selected PR (default); 1 = sequential; N = cap at N
  staggerMs?: number  // ms delay between concurrent worker starts; default 2000 when concurrent > 1
  sequential?: boolean // force sequential execution (overrides concurrent)
}

export type KickassAction = 'resolve' | 'review' | 'fix' | 'recheck' | 'skip'
export type KickassSkipReason = 'fork_pr' | 'stale_signature'
export type KickassFailureReason = ErrorCategory
export type FixDeliveryMode = Config['post_review']['auto_fix']['delivery']['mode']

export interface PreflightItem {
  pr: PRStatus
  action: KickassAction
  transition: string
  details: string[]
  explanation?: string
  skipReason?: KickassSkipReason
  chainRecheck?: boolean
}

export interface KickassExecutionResult {
  pr: PRStatus
  status: 'executed' | 'skipped' | 'failed'
  reason?: KickassSkipReason | KickassFailureReason
}

export interface ExecuteKickassDeps {
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  dispatchRun: (item: PreflightItem, timeoutMs?: number) => Promise<string | void>
  /** Route status messages through a custom sink (e.g. PRBoard scrollback). Defaults to console.log. */
  log?: (msg: string) => void
  /** Called just before dispatchRun — use to add a board slot. */
  onDispatchStart?: (item: PreflightItem, key: string, startedAt: number) => void
  /** Called after a successful dispatchRun — use to complete a board slot. verdict is parsed from subprocess output when available. */
  onDispatchEnd?: (item: PreflightItem, key: string, startedAt: number, verdict?: string | null) => void
  /** Called when dispatchRun throws — use to mark a board slot as failed. */
  onDispatchFail?: (item: PreflightItem, key: string, error: unknown) => void
  /**
   * Called when timeout failures hit the pump threshold (3). Return new timeout in ms to apply,
   * or null to skip. Omit to disable interactive pumping (e.g. in tests or CI).
   */
  onTimeoutPump?: (currentMs: number | undefined, failures: number) => Promise<number | null>
}

export interface KickassDeps {
  loadScanResult: (options: { force?: boolean; staleAfterMs: number }) => Promise<ScanResult>
  pickPRs: (prs: PRStatus[]) => Promise<PRStatus[]>
  confirm: (message: string) => Promise<boolean>
  getFixDeliveryMode?: () => FixDeliveryMode | Promise<FixDeliveryMode>
  getCurrentHeadSha: (item: PreflightItem) => Promise<string>
  onBeforeExecute?: () => void
  onAfterExecute?: () => void
  dispatchRun: (item: PreflightItem, timeoutMs?: number) => Promise<string | void>
  onTimeoutPump?: (currentMs: number | undefined, failures: number) => Promise<number | null>
}

export async function runKickass(opts: KickassOpts = {}): Promise<void> {
  const config = loadConfig()
  const workflow = loadWorkflow(process.cwd())
  const board = new PRBoard()
  board.setConfig(config, workflow)
  await runKickassWithDeps(opts, defaultKickassDeps(opts, board))
}

export async function runKickassWithDeps(
  opts: KickassOpts = {},
  deps: KickassDeps,
): Promise<void> {
  let staleAfterMs: number
  try {
    staleAfterMs = parseDuration(opts.staleAfter ?? '24h')
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (opts.timeout) {
    try {
      parseDuration(opts.timeout)
    } catch {
      console.error(chalk.red(`✗ Invalid --timeout value "${opts.timeout}". Use a duration like 300s or 10m.`))
      process.exit(1)
    }
  }

  if (opts.concurrent !== undefined && (opts.concurrent < 0 || !Number.isInteger(opts.concurrent))) {
    console.error(chalk.red('✗ --concurrent must be a non-negative integer (0 = one agent per selected PR)'))
    process.exit(1)
  }

  try {
    const scan = await deps.loadScanResult({ force: opts.force, staleAfterMs })

    // Actionable = nextAction is set and is not merge (merge not dispatched in v1).
    // Stale PRs shown first; not-stale actionable PRs follow.
    const queue = scan.prs
      .filter(pr => pr.nextAction !== null && pr.nextAction !== 'merge')
      .sort((a, b) => {
        if (a.freshness !== b.freshness) return a.freshness === 'stale' ? -1 : 1
        return 0
      })

    const mergeReady = scan.prs.filter(pr => pr.nextAction === 'merge')

    if (queue.length === 0 && mergeReady.length === 0) {
      printNoActionablePRsWarning(scan.cached)
      return
    }
    if (queue.length === 0) {
      printMergeReady(mergeReady)
      console.log(chalk.dim('\nNo PRs need resolve, review, fix, or recheck — all actionable work is merge-ready (manual).'))
      return
    }

    const selected = await deps.pickPRs(queue)
    if (selected.length === 0) {
      console.log(chalk.dim('No PRs selected.'))
      return
    }

    const fixDeliveryMode = deps.getFixDeliveryMode ? await deps.getFixDeliveryMode() : 'pull_request'
    const plan = buildPreflightPlan(selected, opts.roundMode, fixDeliveryMode)
    printPreflight(plan, mergeReady)

    if (opts.dryRun) {
      console.log(chalk.dim('\ndry-run: no mutations executed'))
      return
    }

    const shouldRun = await deps.confirm('Proceed with these mutations?')
    if (!shouldRun) {
      console.log(chalk.dim('Canceled.'))
      return
    }

    // Default: one agent per selected PR. --sequential or --concurrent 1 forces sequential.
    const resolvedConcurrency = (opts.sequential || opts.concurrent === 1)
      ? 1
      : (opts.concurrent === undefined || opts.concurrent === 0)
        ? selected.length
        : Math.max(1, opts.concurrent)
    const resolvedStagger = resolvedConcurrency > 1 ? (opts.staggerMs ?? 2_000) : 0
    if (resolvedConcurrency > 1) {
      console.log(chalk.dim(`\n  running ${resolvedConcurrency} agents in parallel (${resolvedStagger}ms stagger)`))
    }
    deps.onBeforeExecute?.()
    const results = await executeKickassPlan(plan, deps, resolvedConcurrency, resolvedStagger)
    deps.onAfterExecute?.()
    printExecutionSummary(results)
    if (results.some(result => result.status === 'failed')) {
      process.exitCode = 2
    }
  } catch (err: unknown) {
    handleScanError('kickass', err)
  }
}

export function buildPreflightPlan(
  prs: PRStatus[],
  roundMode?: 'crazy' | 'halfcrazy',
  fixDeliveryMode: FixDeliveryMode = 'pull_request',
): PreflightItem[] {
  const modeTag = roundMode ? ` [${roundMode}]` : ''
  const chainRecheck = fixDeliveryMode === 'commit'
  return prs.map((pr) => {
    const fork = isForkPR(pr)
    // Conflicts come first: nothing downstream can merge, and a fork PR cannot be pushed
    // to any more than a fix can, so the fork guard applies here too.
    if (pr.nextAction === 'resolve') {
      if (fork) {
        return {
          pr,
          action: 'skip',
          transition: `${pr.reviewState} -> Skip`,
          details: ['reason fork_pr'],
          skipReason: 'fork_pr',
        }
      }
      return {
        pr,
        action: 'resolve',
        transition: 'Conflicted -> Resolve',
        details: [`base ${pr.baseRef}`],
      }
    }

    if (pr.nextAction === 'fix' && fork) {
      return {
        pr,
        action: 'skip',
        transition: `${pr.reviewState} -> Skip`,
        details: ['reason fork_pr'],
        skipReason: 'fork_pr',
      }
    }

    if (pr.nextAction === 'fix' && !hasUsableCurrentHeadReview(pr)) {
      return {
        pr,
        action: 'review',
        transition: 'PR -> CR',
        details: [`reviewer ${reviewerLabel(pr)}`],
        explanation: 'no_usable_review_comment',
      }
    }

    if (pr.nextAction === 'review') {
      return {
        pr,
        action: 'review',
        transition: 'PR -> CR',
        details: [`reviewer ${reviewerLabel(pr)}`],
      }
    }

    if (pr.nextAction === 'fix') {
      return {
        pr,
        action: 'fix',
        transition: chainRecheck
          ? `${pr.reviewState} -> fix→recheck${modeTag}`
          : `${pr.reviewState} -> fix`,
        details: [
          `fixer ${fixerLabel(pr)}`,
          `delivery ${fixDeliveryMode}`,
          ...(chainRecheck ? [] : ['recheck deferred']),
        ],
        chainRecheck,
      }
    }

    // nextAction === 'recheck' — fix was applied externally; close the loop with one recheck
    return {
      pr,
      action: 'recheck',
      transition: `${pr.reviewState} -> Recheck`,
      details: ['links latest review'],
    }
  })
}

function printCapturedOutput(label: string, output: string, log = console.log): void {
  const lines = output.trimEnd().split('\n')
  log(chalk.dim(`\n── ${label} ${'─'.repeat(Math.max(0, 48 - label.length))}`))
  for (const line of lines) log(`  ${line}`)
}

function printNoActionablePRsWarning(fromCache: boolean): void {
  console.log(chalk.dim('No actionable PRs found.'))
  if (fromCache) {
    console.log(chalk.yellow(`⚠ This result came from the scan cache. Rerun with --force to refresh the queue.`))
  }
}

function parseVerdictFromOutput(output: string | void): string | null {
  if (!output) return null
  // eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
  const plain = output.replace(/\x1B\[[0-9;]*m/g, '')
  const m = plain.match(/\bverdict\s+\S*\s*(APPROVE|NEEDS[\s_]+WORK|BLOCK)\b/i)
  if (!m) return null
  const raw = m[1].toUpperCase()
  return raw.startsWith('NEEDS') ? 'NEEDS WORK' : raw
}

export function verdictBoardUpdateForAction(action: KickassAction, verdict: string): { verdict?: string; recheckVerdict?: string } {
  return action === 'recheck' ? { recheckVerdict: verdict } : { verdict }
}

const TIMEOUT_PUMP_THRESHOLD = 3

export async function executeKickassPlan(
  plan: PreflightItem[],
  deps: ExecuteKickassDeps,
  concurrency = 1,
  staggerMs = 0,
): Promise<KickassExecutionResult[]> {
  const results: KickassExecutionResult[] = new Array(plan.length)

  const log = deps.log ?? console.log

  // Mutable timeout state: pumped by onTimeoutPump when failures accumulate.
  let effectiveTimeoutMs: number | undefined = undefined
  let timeoutFailures = 0
  let pumpLock: Promise<void> | null = null

  const checkAndPump = async (): Promise<void> => {
    if (timeoutFailures < TIMEOUT_PUMP_THRESHOLD) return
    if (!deps.onTimeoutPump) return
    if (pumpLock) { await pumpLock; return }
    pumpLock = (async () => {
      const newMs = await deps.onTimeoutPump!(effectiveTimeoutMs, timeoutFailures)
      if (newMs != null) effectiveTimeoutMs = newMs
      timeoutFailures = 0
    })().finally(() => { pumpLock = null })
    await pumpLock
  }

  const executeItem = async (item: PreflightItem, index: number, attempt = 1): Promise<void> => {
    if (item.action === 'skip') {
      log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  ${item.skipReason ?? 'skipped'}`))
      results[index] = { pr: item.pr, status: 'skipped', reason: item.skipReason }
      return
    }

    try {
      const currentHeadSha = await deps.getCurrentHeadSha(item)
      if (currentHeadSha !== item.pr.headSha) {
        log(chalk.yellow(`↷ skip ${formatPRSignature(item.pr)}  stale_signature`))
        results[index] = { pr: item.pr, status: 'skipped', reason: 'stale_signature' }
        return
      }

      const key = `${item.pr.owner}/${item.pr.repo}#${item.pr.number}@${item.pr.headSha}`
      const startedAt = Date.now()
      const attemptLabel = attempt > 1 ? ` (retry ${attempt - 1})` : ''
      log(chalk.cyan(`\n→ ${item.transition}  ${formatPRSignature(item.pr)}${attemptLabel}`))
      deps.onDispatchStart?.(item, key, startedAt)
      const output = await deps.dispatchRun(item, effectiveTimeoutMs)
      deps.onDispatchEnd?.(item, key, startedAt, parseVerdictFromOutput(output))
      if (typeof output === 'string' && output) printCapturedOutput(formatPRSignature(item.pr), output, log)

      if (item.action === 'fix' && item.chainRecheck === true) {
        const fixedHeadSha = await deps.getCurrentHeadSha(item)
        if (fixedHeadSha !== item.pr.headSha) {
          const recheckItem = buildPostFixRecheckItem(item, fixedHeadSha)
          const recheckKey = `${recheckItem.pr.owner}/${recheckItem.pr.repo}#${recheckItem.pr.number}@${recheckItem.pr.headSha}`
          const recheckStart = Date.now()
          log(chalk.cyan(`\n→ ${recheckItem.transition}  ${formatPRSignature(recheckItem.pr)}`))
          deps.onDispatchStart?.(recheckItem, recheckKey, recheckStart)
          const recheckOutput = await deps.dispatchRun(recheckItem, effectiveTimeoutMs)
          deps.onDispatchEnd?.(recheckItem, recheckKey, recheckStart, parseVerdictFromOutput(recheckOutput))
          if (typeof recheckOutput === 'string' && recheckOutput) printCapturedOutput(formatPRSignature(recheckItem.pr), recheckOutput, log)
        } else {
          log(chalk.dim(`  head SHA unchanged after fix — recheck deferred`))
        }
      }
      results[index] = { pr: item.pr, status: 'executed' }
    } catch (err: unknown) {
      logError({ event: 'kickass_pr_failed', owner: item.pr.owner, repo: item.pr.repo, pr: item.pr.number, ...(attempt > 1 && { attempt }) }, err)
      // Classify execa errors using structured fields, not the raw message.
      // The raw message includes the full CLI invocation (e.g. "Command failed with exit
      // code 1: node crosscheck run --timeout 300s --no-timeout"), so a text match against
      // `message` would misclassify ordinary subprocess failures as 'timeout' whenever the
      // command contains a --timeout flag.
      const maybeExeca = err as Record<string, unknown>
      let msgForClassify: string
      if (maybeExeca.timedOut === true) {
        // execa's structured timeout flag — reliable; bypass message matching entirely.
        msgForClassify = 'timed out'
      } else if (typeof maybeExeca.exitCode === 'number') {
        // Subprocess failure: prefer stderr (actual error output) over the message which
        // includes the full command string.  Strip the command suffix when stderr is absent.
        const stderr = typeof maybeExeca.stderr === 'string' ? maybeExeca.stderr.trim() : ''
        msgForClassify = stderr || (err instanceof Error ? err.message.replace(/:\s*\S.*$/, '') : String(err))
      } else {
        msgForClassify = err instanceof Error ? err.message : String(err)
      }
      const category = classifyError(msgForClassify)
      const hint = hintForError(category, msgForClassify)
      const hintLine = hint ? `\n    ${chalk.yellow('→')} ${hint}` : ''
      log(chalk.red(`✗ failed ${formatPRSignature(item.pr)}`) + chalk.dim(` [${category}]`) + hintLine)
      const failKey = `${item.pr.owner}/${item.pr.repo}#${item.pr.number}@${item.pr.headSha}`
      deps.onDispatchFail?.(item, failKey, err)
      results[index] = { pr: item.pr, status: 'failed', reason: category }
      if (category === 'timeout') {
        timeoutFailures++
        await checkAndPump()
      }
    }
  }

  if (concurrency <= 1) {
    for (let i = 0; i < plan.length; i++) await executeItem(plan[i], i)
  } else {
    // Worker-pool: up to `concurrency` PRs run in parallel.
    // staggerMs > 0 delays each worker's start by (workerIdx * staggerMs) to spread
    // concurrent subprocess startup API calls over time rather than hitting GitHub simultaneously.
    let ptr = 0
    const makeWorker = (workerIdx: number) => async (): Promise<void> => {
      if (staggerMs > 0 && workerIdx > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, workerIdx * staggerMs))
      }
      while (ptr < plan.length) {
        const i = ptr++
        await executeItem(plan[i], i)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, plan.length) },
      (_, idx) => makeWorker(idx)(),
    ))
  }

  // Retry transient failures up to 4 times with escalating delays.
  // Auth and permission failures are operator issues that won't self-heal.
  const RETRYABLE = new Set<string>(['network', 'timeout'])
  const RETRY_DELAYS_MS = [60_000, 120_000, 300_000, 600_000]

  for (let attempt = 2; attempt <= RETRY_DELAYS_MS.length + 1; attempt++) {
    const delayMs = RETRY_DELAYS_MS[attempt - 2]
    const retryItems = results
      .map((r, i) => ({ r, i }))
      .filter(({ r }) => r.status === 'failed' && RETRYABLE.has(r.reason as string))
    if (retryItems.length === 0) break

    const delaySec = delayMs / 1000
    const delayLabel = delaySec >= 60 ? `${delaySec / 60}m` : `${delaySec}s`
    log(chalk.dim(`\n  ${retryItems.length} transient failure(s) — retry ${attempt - 1}/${RETRY_DELAYS_MS.length} in ${delayLabel}...`))
    await new Promise(resolve => setTimeout(resolve, delayMs))
    for (const { i } of retryItems) {
      const priorResult = results[i]
      await executeItem(plan[i], i, attempt)
      // Stale-signature means the fix already committed in a prior attempt but the
      // chained recheck failed transiently.  Instead of reporting that failure as
      // final, fetch the current head and run a bare recheck to actually retry it.
      if (results[i].status === 'skipped' && results[i].reason === 'stale_signature'
          && plan[i].action === 'fix' && plan[i].chainRecheck === true) {
        try {
          const currentHead = await deps.getCurrentHeadSha(plan[i])
          const recheckItem = buildPostFixRecheckItem(plan[i], currentHead)
          await executeItem(recheckItem, i, attempt)
        } catch {
          // If we cannot fetch the head (network failure), preserve the original failure.
          results[i] = priorResult
        }
      }
    }
  }

  return results
}

function buildPostFixRecheckItem(item: PreflightItem, headSha: string): PreflightItem {
  return {
    pr: { ...item.pr, headSha, nextAction: 'recheck', reviewState: 'NEEDS_RECHECK' },
    action: 'recheck',
    transition: 'fix -> Recheck',
    details: ['links latest review', `head ${headSha.slice(0, 7)}`],
  }
}

export function printPreflight(plan: PreflightItem[], mergeReady: PRStatus[] = []): void {
  console.log('\nPreflight')
  const grouped = groupPreflight(plan)
  for (const [transition, items] of grouped) {
    console.log(`\n${transition}`)
    for (const item of items) {
      const explanation = item.explanation ? `  ${chalk.dim(item.explanation)}` : ''
      console.log(`  ${formatPRSignature(item.pr)}  ${item.details.join('  ')}${explanation}`)
    }
  }
  if (mergeReady.length > 0) printMergeReady(mergeReady)
}

export function printMergeReady(prs: PRStatus[]): void {
  console.log(chalk.dim('\nneeds merge (manual — not selected)'))
  for (const pr of prs) {
    console.log(chalk.dim(`  ${formatPRSignature(pr)}  APPROVE`))
  }
}

export function summarizeExecutionResults(results: KickassExecutionResult[]): string {
  const executed = results.filter(result => result.status === 'executed').length
  const skipped = results.filter(result => result.status === 'skipped').length
  const failed = results.filter(result => result.status === 'failed').length
  return `Execution summary: ${executed} executed, ${skipped} skipped, ${failed} failed`
}

export function printExecutionSummary(results: KickassExecutionResult[]): void {
  console.log(chalk.dim(`\n${summarizeExecutionResults(results)}`))
  const failures = results.filter(r => r.status === 'failed')
  if (failures.length === 0) return
  const seenHints = new Set<string>()
  for (const r of failures) {
    const category = (r.reason as ErrorCategory | undefined) ?? 'unknown'
    const hint = hintForError(category, category)
    const sig = `${r.pr.owner}/${r.pr.repo}#${r.pr.number}`
    console.log(chalk.red(`  ✗ ${sig}`) + chalk.dim(` [${category}]`))
    if (hint && !seenHints.has(hint)) {
      seenHints.add(hint)
      console.log(`    ${chalk.yellow('→')} ${hint}`)
    }
  }
}

export function buildKickassRunArgs(
  itemOrPR: PreflightItem | PRStatus,
  roundMode?: 'crazy' | 'halfcrazy',
  timeout?: string,
): string[] {
  const item = 'action' in itemOrPR ? itemOrPR : buildPreflightPlan([itemOrPR])[0]
  if (item.action === 'skip') return []
  const args = ['run', item.pr.url]
  // No --steps for normal review/recheck/fix actions: run.ts calls
  // identifyNextWorkflowStep against live PR history to determine the correct
  // next step. Exception: when kickass demoted a fix action to review because the
  // latest annotation covers an older SHA (no_usable_review_comment), we must
  // force --steps review so run.ts doesn't re-detect from live history and choose
  // the stale review's fix step, applying fixes to the unreviewed new diff.
  if (item.action === 'review' && item.explanation === 'no_usable_review_comment') {
    args.push('--steps', 'review')
  }
  // A resolve dispatch is one step only. Live detection would agree (a conflicted PR
  // routes to conflict-resolve), but pinning it keeps the leg honest if GitHub's
  // mergeable flips to null between the scan and the run — the step's own no_conflicts
  // pre-check is what decides whether there is anything to do.
  if (item.action === 'resolve') {
    args.push('--steps', 'conflict-resolve')
  }
  args.push('--expected-head-sha', item.pr.headSha)
  if (item.action !== 'fix' && item.action !== 'resolve') {
    if (roundMode === 'crazy') args.push('--crazy')
    else if (roundMode === 'halfcrazy') args.push('--half-crazy')
  } else if (roundMode) {
    // fix and resolve legs don't loop, but still need the no-timeout constraint lifted
    args.push('--no-timeout')
  }
  // forward user-specified --timeout for runs that aren't already in a round mode
  if (timeout && !roundMode) args.push('--timeout', timeout)
  args.push('--trigger', 'kickass')
  return args
}

// Re-exported for backward compatibility — the implementation now lives in lib/cli-invocation.
export { resolveCliInvocation, type CliInvocation } from '../lib/cli-invocation.js'

function defaultKickassDeps(opts: KickassOpts = {}, board?: PRBoard): KickassDeps {
  let cli: CliInvocation | undefined
  const getCli = (): CliInvocation => {
    cli ??= resolveCliInvocation()
    return cli
  }

  const dispatchRun = async (item: PreflightItem, timeoutMs?: number): Promise<string | void> => {
    const invocation = getCli()
    // If a pumped timeout is active, convert it to a "Xs" string and forward it.
    // Otherwise fall back to the user's --timeout flag (or no override).
    const timeoutArg = timeoutMs != null ? `${Math.round(timeoutMs / 1000)}s` : opts.timeout
    const args = [...invocation.args, ...buildKickassRunArgs(item, opts.roundMode, timeoutArg)]
    // When board is active always pipe so output routes through board.log scrollback.
    // Without board, pipe for all modes except explicit sequential (--sequential or --concurrent 1).
    if (board || !(opts.sequential || opts.concurrent === 1)) {
      try {
        const result = await execa(invocation.command, args, { stdio: 'pipe', all: true })
        return result.all ?? ''
      } catch (err: unknown) {
        // Surface captured output before re-throwing so the board log includes
        // the child's stdout/stderr (auth errors, model failures, etc.) that were
        // previously visible via inherited stdio.
        const e = err as Record<string, unknown>
        const captured = typeof e.all === 'string' ? e.all.trim()
          : typeof e.stderr === 'string' ? e.stderr.trim() : ''
        if (captured) {
          if (board) board.log(captured)
          else console.error(captured)
        }
        throw err
      }
    }
    await execa(invocation.command, args, { stdio: 'inherit' })
  }

  const actionPhase = (action: string) =>
    action === 'fix' ? 'fixing' : action === 'recheck' ? 'rechecking' : action === 'resolve' ? 'fixing' : 'reviewing'
  const actionLabel = (action: string) =>
    action === 'fix' ? 'applying fix...' : action === 'recheck' ? 'rechecking...' : action === 'resolve' ? 'resolving conflicts...' : 'reviewing...'
  const donePhase = (action: string) =>
    action === 'fix' ? 'fixed' : action === 'recheck' ? 'rechecked' : action === 'resolve' ? 'fixed' : 'reviewed'

  return {
    loadScanResult,
    pickPRs,
    confirm: confirmMutation,
    getFixDeliveryMode: () => loadConfig().post_review.auto_fix.delivery.mode,
    getCurrentHeadSha: async (item) => {
      const token = getGithubToken()
      const octokit = createGithubClient(token)
      const { data } = await octokit.rest.pulls.get({
        owner: item.pr.owner,
        repo: item.pr.repo,
        pull_number: item.pr.number,
      })
      return data.head.sha
    },
    dispatchRun,
    ...(board && {
      log: (msg: string) => board.log(msg),
      onDispatchStart: (item: PreflightItem, key: string, _startedAt: number) => {
        board.addPR(key, item.pr.number, `${item.pr.owner}/${item.pr.repo}`, item.pr.headRef)
        board.updatePR(key, { phase: actionPhase(item.action) as import('../lib/board.js').PRPhase, label: actionLabel(item.action) })
      },
      onDispatchEnd: (item: PreflightItem, key: string, startedAt: number, verdict?: string | null) => {
        if (verdict != null) {
          board.updatePR(key, verdictBoardUpdateForAction(item.action, verdict))
        }
        board.updatePR(key, { phase: donePhase(item.action) as import('../lib/board.js').PRPhase })
        board.completePR(key, { elapsedMs: Date.now() - startedAt, url: item.pr.url })
      },
      onDispatchFail: (_item: PreflightItem, key: string, err: unknown) => {
        const msg = err instanceof Error ? err.message : String(err)
        board.failPR(key, msg)
      },
      onBeforeExecute: () => board.start(),
      onAfterExecute: () => board.stop(),
    }),
    onTimeoutPump: async (currentMs, failures) => {
      if (board) board.stop()
      try {
        const activeMs = currentMs ?? (opts.timeout ? parseDuration(opts.timeout) : undefined)
        return await promptTimeoutPump(activeMs, failures)
      } finally {
        if (board) board.start()
      }
    },
  }
}

async function confirmMutation(message: string): Promise<boolean> {
  const rl = createInterface({ input, output })
  try {
    const answer = await rl.question(`${message} [y/N] `)
    return answer.trim().toLowerCase() === 'y' || answer.trim().toLowerCase() === 'yes'
  } finally {
    rl.close()
  }
}

async function promptTimeoutPump(currentMs: number | undefined, failures: number): Promise<number | null> {
  const currentSec = Math.round((currentMs ?? 180_000) / 1000)
  const bumpSec = currentSec + 120
  process.stderr.write(
    chalk.yellow(`\n  ⚠  Timeout hit ${failures} time(s). Current timeout: ${currentSec}s\n`) +
    chalk.dim(`     Bump to ${bumpSec}s? [Y/n]  or enter a specific value (e.g. 600s, 10m):\n`) +
    '  > ',
  )
  const rl = createInterface({ input, output })
  try {
    const raw = (await rl.question('')).trim()
    const lower = raw.toLowerCase()
    if (lower === 'n' || lower === 'no') {
      process.stderr.write(chalk.dim('  Timeout unchanged.\n\n'))
      return null
    }
    if (raw === '' || lower === 'y' || lower === 'yes') {
      process.stderr.write(chalk.green(`  Timeout bumped to ${bumpSec}s.\n\n`))
      return bumpSec * 1000
    }
    // Accept bare integers as seconds, otherwise try parseDuration.
    const asSeconds = /^\d+$/.test(raw) ? `${raw}s` : raw
    try {
      const parsed = parseDuration(asSeconds)
      process.stderr.write(chalk.green(`  Timeout set to ${Math.round(parsed / 1000)}s.\n\n`))
      return parsed
    } catch {
      process.stderr.write(chalk.red(`  Invalid value "${raw}" — timeout unchanged.\n\n`))
      return null
    }
  } finally {
    rl.close()
  }
}

function groupPreflight(plan: PreflightItem[]): Array<[string, PreflightItem[]]> {
  const groups = new Map<string, PreflightItem[]>()
  for (const item of plan) {
    const current = groups.get(item.transition) ?? []
    current.push(item)
    groups.set(item.transition, current)
  }
  return [...groups.entries()]
}

function hasUsableCurrentHeadReview(pr: PRStatus): boolean {
  const annotation = pr.latestAnnotation
  if (!annotation || annotation.type !== 'review') return false
  return shaCovers(annotation.sha, pr.headSha)
}

function isForkPR(pr: PRStatus): boolean {
  return pr.headRepo !== undefined
    && pr.headRepo !== null
    && pr.headRepo.toLowerCase() !== `${pr.owner}/${pr.repo}`.toLowerCase()
}

function reviewerLabel(pr: PRStatus): string {
  return pr.latestAnnotation?.reviewer ?? 'auto'
}

function fixerLabel(pr: PRStatus): string {
  return pr.latestAnnotation?.origin ?? 'origin'
}

function formatPRSignature(pr: PRStatus): string {
  return `${pr.owner}/${pr.repo}#${pr.number}@${pr.headSha.slice(0, 7)}`
}
