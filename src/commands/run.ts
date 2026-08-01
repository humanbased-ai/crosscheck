import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { execa } from 'execa'
import { parseDuration } from '../lib/durations.js'
import ora from 'ora'
import { createGithubClient } from '../github/client.js'
import { fetchStepHistory, identifyNextWorkflowStep } from '../lib/pr-workflow-state.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import { loadConfig, getGithubToken, getLinearApiKey, getLinearCredentials } from '../config/loader.js'
import { enrichIssueContext } from '../issues/enrich.js'
import { normalizeVendor, VENDOR_ALIAS_HINT, type Vendor } from '../lib/vendor.js'
import { initLogger, log as fileLog, logError, classifyError } from '../lib/logger.js'
import { hintForError } from '../lib/remediation.js'
import { runWorkflow } from '../lib/runner.js'
import { isLinearConfigError, resolveLinearAuth } from '../linear/identity.js'
import { DEFAULT_RECHECK_INSTRUCTIONS, DEFAULT_CONFLICT_RESOLVE_INSTRUCTIONS, loadWorkflow, canWriteVerdict, type WorkflowStep } from '../lib/workflow.js'
import { formatRepoWorkflowSteps, readRepoWorkflowStepTypes, resolveRepoWorkflowSteps } from '../lib/repo-workflow.js'
import { parsePRSpec, type PRRef } from '../lib/pr-spec.js'
import { closedPRSkip } from '../lib/pr-state.js'
import { resolveCliInvocation } from '../lib/cli-invocation.js'
import { executeMultiPR, resolveRunConcurrency, printMultiPRSummary, concurrencyError, aggregateExitCode, type ConcurrencyOpts } from '../lib/multi-run.js'
import { formatVerdict, type Verdict } from '../lib/verdict.js'
import { clonePRForReview } from '../lib/clone.js'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'
import { checkRemoteLock, acquireRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'
import type { PREvent } from '../github/webhook.js'

export interface RunOpts {
  config?: string
  reviewer?: string
  fixer?: string
  vendor?: string
  steps?: string
  dryRun?: boolean
  roundMode?: 'crazy' | 'halfcrazy'
  initialReviewComment?: {
    id?: number
    body: string
  }
  expectedHeadSha?: string
  timeout?: string
  noTimeout?: boolean
  trigger?: import('../lib/runner.js').WorkflowTrigger
}


function meetsCrazyStopCondition(verdict: string | null, mode: 'crazy' | 'halfcrazy'): boolean {
  if (verdict === null) return false
  if (mode === 'crazy') return verdict === 'APPROVE'
  // halfcrazy: any non-BLOCK verdict (APPROVE or NEEDS_WORK) is acceptable
  return verdict !== 'BLOCK'
}

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export interface StepVendorOverrides {
  reviewer?: Vendor
  fixer?: Vendor
  vendor?: Vendor
}

function applyStepVendorOverrides(
  steps: WorkflowStep[],
  assignedReviewer: Vendor,
  overrides: StepVendorOverrides = {},
): WorkflowStep[] {
  const reviewVendor = overrides.vendor ?? overrides.reviewer ?? assignedReviewer
  const fixVendor = overrides.vendor ?? overrides.fixer
  return steps.map(s => {
    if (s.type === 'review' || s.type === 'recheck') return { ...s, reviewer: reviewVendor }
    if (s.type === 'fix' && fixVendor !== undefined) return { ...s, reviewer: fixVendor }
    if (s.type === 'conflict-resolve' && overrides.vendor !== undefined) return { ...s, reviewer: overrides.vendor }
    return s
  })
}

function synthesizeRecheckStep(allSteps: WorkflowStep[], assignedReviewer: 'claude' | 'codex'): WorkflowStep | null {
  const reviewStep = allSteps.find(s => s.type === 'review')
  if (!reviewStep) return null
  return {
    ...reviewStep,
    name: 'recheck',
    type: 'recheck',
    reviewer: assignedReviewer,
    when: undefined,
    max_rounds: reviewStep.max_rounds,
    instructions: DEFAULT_RECHECK_INSTRUCTIONS,
  }
}

// conflict-resolve only resolves git conflict markers — it needs no prior review
// step, so (unlike recheck) it can be synthesized from scratch when the workflow
// has no conflict-resolve step but `ck resolve` / `--steps conflict-resolve` asks for one.
function synthesizeConflictResolveStep(assignedReviewer: 'claude' | 'codex', vendorOverride?: Vendor): WorkflowStep {
  return {
    name: 'conflict-resolve',
    type: 'conflict-resolve',
    reviewer: vendorOverride ?? assignedReviewer,
    max_rounds: 1,
    instructions: DEFAULT_CONFLICT_RESOLVE_INSTRUCTIONS,
  }
}

function appendAfterLastFix(steps: WorkflowStep[], step: WorkflowStep): WorkflowStep[] {
  const lastFix = steps.map(s => s.type).lastIndexOf('fix')
  if (lastFix === -1) return [...steps, step]
  return [...steps.slice(0, lastFix + 1), step, ...steps.slice(lastFix + 1)]
}

export function resolveWorkflowSteps(
  allSteps: WorkflowStep[],
  stepFilter: string[] | undefined,
  assignedReviewer: 'claude' | 'codex',
  overrides: StepVendorOverrides = {},
): WorkflowStep[] {
  const selected = stepFilter
    ? allSteps.filter(s => stepFilter.includes(s.type) || stepFilter.includes(s.name))
    : allSteps
  let steps = applyStepVendorOverrides(selected, assignedReviewer, overrides)

  if (stepFilter?.includes('recheck') && !steps.some(s => s.type === 'recheck')) {
    const synthetic = synthesizeRecheckStep(allSteps, assignedReviewer)
    if (synthetic) steps = appendAfterLastFix(steps, synthetic)
  }

  if (stepFilter?.includes('conflict-resolve') && !steps.some(s => s.type === 'conflict-resolve')) {
    steps = [...steps, synthesizeConflictResolveStep(assignedReviewer, overrides.vendor)]
  }

  return steps
}

export function buildFixRecheckSteps(
  steps: WorkflowStep[],
  allSteps: WorkflowStep[],
  assignedReviewer: 'claude' | 'codex',
  overrides: StepVendorOverrides = {},
): WorkflowStep[] {
  const selectedFixRecheckSteps = steps.filter(s => s.type === 'fix' || s.type === 'recheck')
  const sourceSteps = selectedFixRecheckSteps.length > 0
    ? selectedFixRecheckSteps
    : applyStepVendorOverrides(allSteps.filter(s => s.type === 'fix' || s.type === 'recheck'), assignedReviewer, overrides)
  let fixRecheckSteps = [...sourceSteps]
  if (!fixRecheckSteps.some(s => s.type === 'fix')) {
    const fixStep = allSteps.find(s => s.type === 'fix')
    if (fixStep) fixRecheckSteps = [fixStep, ...fixRecheckSteps]
  }
  if (!fixRecheckSteps.some(s => s.type === 'recheck')) {
    const synthetic = synthesizeRecheckStep(allSteps, assignedReviewer)
    if (synthetic) fixRecheckSteps = appendAfterLastFix(fixRecheckSteps, synthetic)
  }
  return fixRecheckSteps
}

function printRoundModeBanner(mode: 'crazy' | 'halfcrazy'): void {
  const BLINK = '\x1b[5m'
  const RESET = '\x1b[0m'
  if (mode === 'crazy') {
    const label = chalk.bold.white.bgRed(' CRAZY ') + ' ' + chalk.red.bold('MODE')
    console.log(`\n ${label} ${BLINK}🔥🔥${RESET}  ${chalk.dim('fix→recheck until APPROVE')}`)
    console.log(` ${chalk.yellow('⚠')}  ${chalk.yellow('Token consumption may skyrocket 🚀 — use with caution.')}\n`)
  } else {
    const label = chalk.bold.yellow('half') + chalk.bold.white.bgRed('-CRAZY') + ' ' + chalk.red.bold('MODE')
    console.log(`\n ${label} ${BLINK}🔥${RESET}  ${chalk.dim('fix→recheck until not BLOCK')}`)
    console.log(` ${chalk.yellow('⚠')}  ${chalk.yellow('Token consumption may skyrocket 🚀 — use with caution.')}\n`)
  }
}

export async function runRun(prUrl: string, opts: RunOpts = {}) {
  if (opts.roundMode && opts.dryRun) {
    console.error(chalk.red(`✗ --${opts.roundMode} and --dry-run are mutually exclusive`))
    process.exit(1)
  }

  if (opts.roundMode) printRoundModeBanner(opts.roundMode)

  // crazy/halfcrazy (or --no-timeout) lift all constraints including the reviewer timeout (0 = no cap).
  // Otherwise parse the user-supplied --timeout value; undefined keeps each reviewer's default.
  let reviewerTimeoutMs: number | undefined
  if (opts.roundMode || opts.noTimeout) {
    reviewerTimeoutMs = 0
  } else if (opts.timeout) {
    try {
      reviewerTimeoutMs = parseDuration(opts.timeout)
    } catch {
      console.error(chalk.red(`✗ Invalid --timeout value "${opts.timeout}". Use a duration like 300s or 10m.`))
      process.exit(1)
    }
  }

  const config = loadConfig(opts.config)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'run', pr_url: prUrl, ...(opts.roundMode && { round_mode: opts.roundMode }) })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'run', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const parsed = parsePRUrl(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed

  const spinner = ora(`Fetching PR #${number}...`).start()
  const octokit = createGithubClient(token)
  const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
  const closedSkip = closedPRSkip(prData)
  if (closedSkip) {
    spinner.info(`PR #${number} is ${closedSkip.status} — nothing to do`)
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: closedSkip.reason })
    return
  }
  if (opts.expectedHeadSha !== undefined && prData.head.sha !== opts.expectedHeadSha) {
    spinner.warn(`PR #${number} head changed since selection — skipping stale_signature`)
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'stale_signature', expected_sha: opts.expectedHeadSha, actual_sha: prData.head.sha })
    return
  }
  spinner.succeed(`PR #${number}: ${prData.title}`)
  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repo}`, pr: number, sha: prData.head.sha })

  // Early signal handler: covers the window between pr_received and the full
  // onSignal handler installed below (after acquirePRLock + acquireRemoteLock).
  // Without this, a SIGINT/SIGTERM during origin detection or step resolution
  // exits Node silently with no fileLog event.
  const earlySignalHandler = (signal: NodeJS.Signals): void => {
    fileLog({ level: 'info', event: 'session_killed', repo: `${owner}/${repo}`, pr: number, phase: 'setup', signal })
    process.exit(signal === 'SIGTERM' ? 143 : 130)
  }
  process.once('SIGINT', earlySignalHandler)
  process.once('SIGTERM', earlySignalHandler)

  // Resolve origin plus any explicit per-step vendor overrides.
  const normalizedReviewer = normalizeVendor(opts.reviewer)
  const normalizedFixer = normalizeVendor(opts.fixer)
  const normalizedVendor = normalizeVendor(opts.vendor)
  if (opts.reviewer !== undefined && normalizedReviewer === null) {
    console.error(chalk.red(`✗ Unknown reviewer "${opts.reviewer}". Expected: ${VENDOR_ALIAS_HINT}`))
    process.exit(1)
  }
  if (opts.fixer !== undefined && normalizedFixer === null) {
    console.error(chalk.red(`✗ Unknown fixer "${opts.fixer}". Expected: ${VENDOR_ALIAS_HINT}`))
    process.exit(1)
  }
  if (opts.vendor !== undefined && normalizedVendor === null) {
    console.error(chalk.red(`✗ Unknown vendor "${opts.vendor}". Expected: ${VENDOR_ALIAS_HINT}`))
    process.exit(1)
  }
  if (normalizedReviewer !== null && normalizedVendor !== null && normalizedReviewer !== normalizedVendor) {
    console.error(chalk.red(`✗ --reviewer and --vendor disagree (${normalizedReviewer} vs ${normalizedVendor})`))
    process.exit(1)
  }
  if (normalizedFixer !== null && normalizedVendor !== null && normalizedFixer !== normalizedVendor) {
    console.error(chalk.red(`✗ --fixer and --vendor disagree (${normalizedFixer} vs ${normalizedVendor})`))
    process.exit(1)
  }

  let origin: import('../github/detector.js').PROrigin
  if (normalizedReviewer !== null) {
    // --reviewer forces the origin to the opposite vendor (cross-vendor semantics)
    origin = normalizedReviewer === 'codex' ? 'claude' : 'codex'
    console.log(chalk.dim(`  reviewer: ${normalizedReviewer} (forced)`))
  } else {
    const { origin: detectedOrigin, method } = await detectOriginFull(
      prData.body ?? '',
      prData.head.ref,
      owner,
      repo,
      number,
      config,
      token,
      prData.user?.login,
    )
    origin = detectedOrigin
    console.log(chalk.dim(`  PR origin: ${origin} (via ${method})`))
  }

  const forcedReviewer = normalizedVendor ?? normalizedReviewer
  const assignedReviewer = forcedReviewer ?? await assignReviewer(origin, config)

  if (!assignedReviewer) {
    console.log(chalk.dim(`  no reviewer assigned for origin "${origin}" — use --reviewer ${VENDOR_ALIAS_HINT} to force`))
    return
  }
  if (normalizedVendor !== null) {
    console.log(chalk.dim(`  vendor: ${assignedReviewer} (forced for all workflow steps)`))
  } else if (normalizedReviewer === null) {
    console.log(chalk.dim(`  assigned reviewer: ${assignedReviewer}`))
  }
  if (normalizedFixer !== null && normalizedVendor === null) {
    console.log(chalk.dim(`  fixer: ${normalizedFixer} (forced for fix steps)`))
  }

  // Resolve steps — a per-repo override file narrows workflow.yml by default. An
  // explicit --steps flag is a one-shot override and wins over the repo default.
  const baseSteps = loadWorkflow(process.cwd())
  const repoStepOverride = !opts.steps ? readRepoWorkflowStepTypes(owner, repo) : undefined
  const allSteps = repoStepOverride ? resolveRepoWorkflowSteps(owner, repo, baseSteps) : baseSteps
  if (repoStepOverride) {
    console.log(chalk.dim(`  repo workflow: ${formatRepoWorkflowSteps(repoStepOverride)}`))
  }
  let stepFilter = opts.steps?.split(',').map(s => s.trim().toLowerCase())
  let initialReviewComment = opts.initialReviewComment

  // When running without an explicit --steps flag, detect the next step from live
  // PR comment history. When triggered by kickass the dispatch is intentionally
  // one-step-at-a-time (watch owns continuation via webhooks). For all other
  // triggers (direct user invocation, backtrace, etc.) run all remaining steps
  // from the detected starting point so a standalone `ck run` still works end-to-end.
  if (!opts.steps) {
    try {
      const history = await fetchStepHistory(owner, repo, number, token)
      const nextResult = identifyNextWorkflowStep(history, allSteps, prData.head.sha)
      if (nextResult.step === null) {
        // Workflow already complete for this SHA
        console.log(chalk.dim('  workflow already complete for this SHA — nothing to do'))
        return
      }
      if (opts.trigger === 'kickass') {
        // One step only — watch picks up continuation via issue_comment / synchronize.
        stepFilter = [nextResult.step.type]
        console.log(chalk.dim(`  detected next step: ${nextResult.step.type}`))
      } else if (nextResult.hasExistingReview && nextResult.step.type !== 'review') {
        // Resume from the identified step and run all remaining steps.
        const nextStepIdx = allSteps.findIndex(s => s.type === nextResult.step!.type)
        stepFilter = nextStepIdx >= 0
          ? allSteps.slice(nextStepIdx).map(s => s.name)
          : [nextResult.step.type]
        console.log(chalk.dim(`  existing review found — resuming from ${nextResult.step.type} step`))
      }
      if (nextResult.hasExistingReview && nextResult.step.type !== 'review') {
        initialReviewComment = nextResult.reviewComment
      }
    } catch (err: unknown) {
      if (opts.trigger === 'kickass') {
        // Fail closed for kickass dispatches: running more steps than intended
        // (full pipeline instead of one step) is worse than aborting. Re-throw
        // so the subprocess exits non-zero and kickass records a retryable failure.
        throw err
      }
      /* best-effort for other triggers — fall through to normal review flow */
    }
  }

  const stepVendorOverrides: StepVendorOverrides = {
    ...(normalizedReviewer !== null && { reviewer: normalizedReviewer }),
    ...(normalizedFixer !== null && { fixer: normalizedFixer }),
    ...(normalizedVendor !== null && { vendor: normalizedVendor }),
  }
  const filteredSteps = resolveWorkflowSteps(allSteps, stepFilter, assignedReviewer, stepVendorOverrides)

  if (opts.dryRun) {
    console.log(chalk.dim('  dry-run: review will run but no comment will be posted; fix step skipped'))
  }

  // Build the PREvent['pull_request'] shape from the GitHub API response
  const pr: PREvent['pull_request'] = {
    title: prData.title,
    body: prData.body ?? '',
    head: {
      ref: prData.head.ref,
      sha: prData.head.sha,
      repo: prData.head.repo ? { full_name: prData.head.repo.full_name } : null,
    },
    base: {
      ref: prData.base.ref,
      repo: { full_name: `${owner}/${repo}` },
    },
    html_url: prData.html_url,
    user: { login: prData.user?.login ?? '' },
  }

  const { sha } = prData.head

  if (!acquirePRLock(owner, repo, number, sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_local' })
    console.log(chalk.yellow(`⚠  PR #${number} is already being reviewed by another process on this machine — skipping`))
    return
  }

  // Track which resources have actually been allocated so the SIGINT/SIGTERM
  // handler only releases what exists. The handler must be installed BEFORE
  // calling acquireRemoteLock: GitHub may create the pending status server-side
  // even if the network round-trip is interrupted, and without an installed
  // listener pr-lock would re-raise the signal and orphan the pending status
  // until it goes stale.
  let lockAttemptStarted = false
  let acquiredTmpDir: string | undefined
  let stopHeartbeat = () => {}
  // Shared with runWorkflow — the runner appends every sha for which it set
  // a remote pending status (e.g. after a conflict-resolve push). On normal
  // completion or workflow error, the runner's own finally releases them;
  // but if a signal fires mid-workflow we exit via process.exit and bypass
  // that finally, so the signal handler iterates this array too.
  const pushedShas: string[] = []
  const loopLockShas: string[] = []

  const rememberLoopLock = (lockSha: string): void => {
    if (!loopLockShas.includes(lockSha)) loopLockShas.push(lockSha)
  }
  const releaseRememberedLoopLock = async (lockSha: string, outcome: 'success' | 'failure'): Promise<void> => {
    const idx = loopLockShas.indexOf(lockSha)
    if (idx !== -1) loopLockShas.splice(idx, 1)
    try {
      await releaseRemoteLock(octokit, owner, repo, lockSha, outcome)
    } catch (err) {
      rememberLoopLock(lockSha)
      throw err
    }
  }
  const drainLoopLocks = async (outcome: 'success' | 'failure'): Promise<void> => {
    while (loopLockShas.length > 0) {
      const s = loopLockShas.shift()!
      try { await releaseRemoteLock(octokit, owner, repo, s, outcome) } catch { /* best-effort per sha */ }
    }
  }

  const onSignal = (signal: NodeJS.Signals): void => {
    void (async () => {
      try {
        stopHeartbeat()
        if (!opts.dryRun && lockAttemptStarted) {
          await releaseRemoteLock(octokit, owner, repo, sha, 'failure')
          await drainLoopLocks('failure')
          // Drain the shared array via shift() so the runner's finally (which
          // also drains via shift) doesn't double-release. Whichever loop
          // shifts a sha first owns its release; the other sees a shorter
          // array. This also prevents the reverse race — a signal arriving
          // after the runner has already released a sha as 'success' would
          // otherwise overwrite it with 'failure' here.
          while (pushedShas.length > 0) {
            const s = pushedShas.shift()!
            try { await releaseRemoteLock(octokit, owner, repo, s, 'failure') } catch { /* best-effort per sha */ }
          }
        }
      } catch { /* best-effort — must still exit even if remote release fails */ }
      try { releasePRLock(owner, repo, number, sha) } catch { /* ignore */ }
      if (acquiredTmpDir) try { rmSync(acquiredTmpDir, { force: true, recursive: true }) } catch { /* ignore */ }
      // 128 + signal number (SIGINT=2 → 130, SIGTERM=15 → 143) per POSIX convention
      process.exit(signal === 'SIGTERM' ? 143 : 130)
    })()
  }
  process.removeListener('SIGINT', earlySignalHandler)
  process.removeListener('SIGTERM', earlySignalHandler)
  process.on('SIGINT', onSignal)
  process.on('SIGTERM', onSignal)

  try {
    if (!opts.dryRun) {
      if (await checkRemoteLock(octokit, owner, repo, sha)) {
        releasePRLock(owner, repo, number, sha)
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote' })
        fileLog({ level: 'warn', event: 'lock_busy', repo: `${owner}/${repo}`, pr: number, sha })
        console.log(chalk.yellow(`⚠  PR #${number} is already being reviewed on another machine — skipping`))
        return
      }
      try {
        // Set the flag BEFORE the await so a signal that interrupts the in-flight
        // request still triggers releaseRemoteLock (GitHub may have already
        // created the pending status server-side).
        lockAttemptStarted = true
        await acquireRemoteLock(octokit, owner, repo, sha)
      } catch (err: unknown) {
        releasePRLock(owner, repo, number, sha)
        throw err
      }
    }

    // Clone the repo
    const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-run-'))
    acquiredTmpDir = tmpDir
    const cloneSpinner = ora('Cloning repo...').start()

    let workflowError: unknown
    try {
      // One token for the whole command run, resolved before the clone: a
      // misconfiguration should fail without spending a clone, and runWorkflow is
      // re-entered per fix/recheck round so resolving inside it would mint every
      // round. Inside the try, so a failure still reaches the completion handler.
      // Only when the selected workflow can actually write a verdict — the public
      // `fix` and `resolve` aliases run steps that never call notifyLinear, and a
      // missing credential must not abort work that was never going to write.
      const linearAuth = config.linear.enabled && !opts.dryRun && canWriteVerdict(filteredSteps)
        ? await resolveLinearAuth(config.linear, getLinearCredentials(config.linear.auth))
        : null

      await clonePRForReview({
        owner, repo, prNumber: number, baseRef: prData.base.ref,
        tmpDir, token, protocol: config.clone_protocol,
        onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: prData.base.ref }),
      })
      cloneSpinner.succeed('Repo ready')

      // Recover the linked tracker issue (if enabled) so the review is anchored
      // to the stated goal, not just the diff. Done here — after the PR and
      // remote locks are secured — so a PR that gets skipped (already under
      // review elsewhere) never triggers a throwaway tracker fetch. Fail-soft:
      // a miss degrades to a diff-only review.
      const issueContext = (await enrichIssueContext(
        { title: pr.title, branch: pr.head.ref, body: pr.body },
        config.issue_enrichment,
        getLinearApiKey(),
        (e) => fileLog({ level: e.level, event: e.event, repo: `${owner}/${repo}`, pr: number, ref: e.ref, reason: e.reason }),
      )) ?? undefined
      if (issueContext) console.log(chalk.dim('  issue enrichment: linked tracker issue attached'))

      if (!opts.dryRun) stopHeartbeat = startRemoteLockHeartbeat(octokit, owner, repo, sha)
      let activeSpinner = ora('').start()

      const sharedCtx = {
        owner, repoName: repo, prNumber: number, token, config, origin,
        linearAuth,
        log: (msg: string) => { activeSpinner.stop(); console.log(msg); activeSpinner = ora('').start() },
        onPhaseChange: (label: string) => { activeSpinner.text = label },
        crosscheckShas: new Set<string>(),
        pushedShas,
        dryRun: opts.dryRun,
        // crazy/halfcrazy bypass per-step max_rounds; loop runs until stop condition or no-progress guard
        overrideMaxRounds: opts.roundMode ? Infinity : undefined,
        roundMode: opts.roundMode,
        overrideTimeoutMs: reviewerTimeoutMs,
        trigger: opts.trigger ?? 'run',
        issueContext,
      }

      let workflowResult = await runWorkflow({
        ...sharedCtx,
        pr,
        tmpDir,
        reviewStart: Date.now(),
        steps: filteredSteps,
        initialReviewComment,
      })
      let { verdict, fixAppliedCount } = workflowResult
      let latestReviewComment = workflowResult.latestReviewComment ?? initialReviewComment

      // Autonomous fix→recheck loop for --crazy / --halfcrazy
      if (opts.roundMode) {
        const mode = opts.roundMode
        const fixRecheckSteps = buildFixRecheckSteps(filteredSteps, allSteps, assignedReviewer, stepVendorOverrides)
        let activeFixRecheckSteps = fixRecheckSteps
        let loopRound = 1
        let loopSha = sha
        let consecutiveNoProgress = 0
        let consecutiveFixErrors = 0

        // Continue when the verdict hasn't met the stop condition OR when the
        // initial workflow applied fixes that still need a follow-up recheck.
        // Without the fixAppliedCount clause, --half-crazy stops after a
        // NEEDS_WORK review (which is its stop condition) even when the workflow's
        // fix step already pushed a commit — leaving the new head unrechecked.
        while (!meetsCrazyStopCondition(verdict, mode) || (fixAppliedCount !== undefined && fixAppliedCount > 0)) {
          // No-progress guard: fix ran but applied nothing.
          // First occurrence: escalate fix instructions and retry.
          // Second consecutive occurrence: give up — reviewer issues are beyond fix capability.
          if (fixAppliedCount === 0) {
            consecutiveNoProgress++
            if (consecutiveNoProgress >= 2) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress', mode, round: loopRound })
              console.log(chalk.dim(`  no progress in round ${loopRound} — stopping`))
              break
            }
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress_escalate', mode, round: loopRound })
            console.log(chalk.yellow(`⚠  no progress in round ${loopRound} — escalating fix instructions...`))
            activeFixRecheckSteps = activeFixRecheckSteps.map(s => s.type !== 'fix' ? s : {
              ...s,
              instructions: (s.instructions ?? '') +
                '\n\nEscalation: the previous fix attempt made no changes. You MUST modify at least one file. Address all issues from the review, including those requiring business logic understanding. Do not skip any item.',
            })
          } else if (fixAppliedCount !== undefined) {
            consecutiveNoProgress = 0
          }

          loopRound++
          console.log(chalk.dim(`\n  round ${loopRound}  previous verdict ${verdict ?? '--'} — continuing...`))

          // Refresh head SHA so the remote lock targets the commit fix pushed.
          // A review-only first round has no fix count and no new head yet; in
          // that case continue on the existing lock so round 2 can actually run
          // the synthesized fix/recheck follow-up.
          const { data: freshPR } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
          const freshSha = freshPR.head.sha
          const priorRoundRanFix = fixAppliedCount !== undefined
          if (freshSha === loopSha && priorRoundRanFix && fixAppliedCount !== 0) {
            // Head didn't advance — fix made no changes despite applied_count > 0 (edge case)
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress', mode, round: loopRound })
            console.log(chalk.dim(`  head SHA unchanged — no progress, stopping`))
            break
          }
          const acquiredLoopLock = freshSha !== loopSha
          if (acquiredLoopLock) {
            loopSha = freshSha
            stopHeartbeat()
            if (await checkRemoteLock(octokit, owner, repo, loopSha)) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote', mode, round: loopRound })
              fileLog({ level: 'warn', event: 'lock_busy', repo: `${owner}/${repo}`, pr: number, sha: loopSha, round: loopRound })
              console.log(chalk.yellow(`⚠  PR #${number} head ${loopSha.slice(0, 7)} is already locked — stopping loop`))
              break
            }
            rememberLoopLock(loopSha)
            await acquireRemoteLock(octokit, owner, repo, loopSha)
            stopHeartbeat = startRemoteLockHeartbeat(octokit, owner, repo, loopSha)
          }

          const loopPR = { ...pr, head: { ...pr.head, sha: loopSha } }
          workflowResult = await runWorkflow({
            ...sharedCtx,
            pr: loopPR,
            tmpDir,
            reviewStart: Date.now(),
            steps: activeFixRecheckSteps,
            initialReviewComment: latestReviewComment,
            round: loopRound,
          })
          ;({ verdict, fixAppliedCount } = workflowResult)
          latestReviewComment = workflowResult.latestReviewComment ?? latestReviewComment

          if (acquiredLoopLock) await releaseRememberedLoopLock(loopSha, 'success')

          // Fix step was structurally skipped — head won't advance so looping cannot make progress.
          // Transient errors (fix_error, vendor_limit) are retried on the next round up to 3 times;
          // structural skips (fork_pr, commit_limit_reached, no_vendor) stop the loop immediately.
          if (fixAppliedCount === undefined) {
            const transientSkip = ['fix_error', 'vendor_limit'].includes(workflowResult.fixSkipReason ?? '')
            if (!transientSkip) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_fix_step', mode, round: loopRound })
              console.log(chalk.dim(`  fix step did not run in round ${loopRound} — stopping`))
              break
            }
            // fix_error can leave partial file edits; reset before retrying so the
            // next attempt starts from a clean state. vendor_limit never touches files.
            if (workflowResult.fixSkipReason === 'fix_error') {
              try {
                execFileSync('git', ['reset', '--hard', 'HEAD'], { cwd: tmpDir, stdio: 'pipe' })
                execFileSync('git', ['clean', '-fd'], { cwd: tmpDir, stdio: 'pipe' })
              } catch (resetErr) {
                fileLog({ level: 'warn', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'worktree_reset_failed', mode, round: loopRound })
                console.log(chalk.red(`✗  could not reset worktree after fix_error — stopping`))
                break
              }
            }
            consecutiveFixErrors++
            if (consecutiveFixErrors >= 3) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'fix_error_limit', mode, round: loopRound, skip_reason: workflowResult.fixSkipReason })
              console.log(chalk.red(`✗  fix errored ${consecutiveFixErrors} consecutive rounds (${workflowResult.fixSkipReason}) — stopping`))
              break
            }
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'fix_error_transient', mode, round: loopRound, skip_reason: workflowResult.fixSkipReason })
            console.log(chalk.yellow(`⚠  fix errored in round ${loopRound} (${workflowResult.fixSkipReason}) — retrying (${consecutiveFixErrors}/3)`))
          } else {
            consecutiveFixErrors = 0
          }

          // Explicit stop when the recheck satisfies the condition, so the
          // fixAppliedCount > 0 clause in the while predicate doesn't cause an
          // unnecessary extra fix/recheck round against an already-approving verdict.
          if (meetsCrazyStopCondition(verdict, mode)) {
            fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'stop_condition_met', mode, round: loopRound })
            console.log(`  round ${loopRound}  verdict ${verdict ?? '--'} — done`)
            break
          }
          console.log(`  round ${loopRound}  verdict ${verdict ?? '--'} — continuing...`)
        }

      } else {
        // Autonomous fix→recheck cycling based on max_rounds from workflow.yml
        const allFixRecheckSteps = allSteps.filter(s => s.type === 'fix' || s.type === 'recheck')
        const maxRounds = allFixRecheckSteps.length > 0
          ? Math.min(...allFixRecheckSteps.map(s => s.max_rounds ?? 1))
          : 1
        const ranRecheck = filteredSteps.some(s => s.type === 'recheck')

        if (maxRounds > 1 || !ranRecheck) {
          const fixRecheckSteps = buildFixRecheckSteps(filteredSteps, allSteps, assignedReviewer, stepVendorOverrides)
          let loopRound = 1
          let loopSha = sha
          let hasRechecked = ranRecheck

          while (
            verdict && verdict !== 'APPROVE' &&
            fixAppliedCount !== undefined && fixAppliedCount > 0 &&
            (loopRound < maxRounds || !hasRechecked)
          ) {
            loopRound++
            console.log(chalk.dim(`\n  round ${loopRound}  previous verdict ${verdict ?? '--'} — continuing (max_rounds ${maxRounds})...`))

            const { data: freshPR } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
            const freshSha = freshPR.head.sha
            if (freshSha === loopSha && fixAppliedCount !== undefined && fixAppliedCount !== 0) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_progress', round: loopRound })
              console.log(chalk.dim(`  head SHA unchanged — no progress, stopping`))
              break
            }
            const acquiredLoopLock = freshSha !== loopSha
            if (acquiredLoopLock) {
              loopSha = freshSha
              stopHeartbeat()
              if (await checkRemoteLock(octokit, owner, repo, loopSha)) {
                fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote', round: loopRound })
                fileLog({ level: 'warn', event: 'lock_busy', repo: `${owner}/${repo}`, pr: number, sha: loopSha, round: loopRound })
                console.log(chalk.yellow(`⚠  PR #${number} head ${loopSha.slice(0, 7)} is already locked — stopping loop`))
                break
              }
              rememberLoopLock(loopSha)
              await acquireRemoteLock(octokit, owner, repo, loopSha)
              stopHeartbeat = startRemoteLockHeartbeat(octokit, owner, repo, loopSha)
            }

            const loopPR = { ...pr, head: { ...pr.head, sha: loopSha } }
            workflowResult = await runWorkflow({
              ...sharedCtx,
              pr: loopPR,
              tmpDir,
              reviewStart: Date.now(),
              steps: fixRecheckSteps,
              initialReviewComment: latestReviewComment,
              round: loopRound,
            })
            ;({ verdict, fixAppliedCount } = workflowResult)
            latestReviewComment = workflowResult.latestReviewComment ?? latestReviewComment
            hasRechecked = true

            if (acquiredLoopLock) await releaseRememberedLoopLock(loopSha, 'success')

            if (fixAppliedCount === undefined) {
              fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'no_fix_step', round: loopRound })
              console.log(chalk.dim(`  fix step did not run in round ${loopRound} — stopping`))
              break
            }
          }
        }
      }

      activeSpinner.stop()
      console.log(`\n  ${formatVerdict(verdict as Verdict | null)}`)

      console.log(chalk.green(`\n✓ Workflow complete — ${prUrl}\n`))
    } catch (err: unknown) {
      workflowError = err
      logError({ repo: `${owner}/${repo}`, pr: number, phase: 'run' }, err)
      const errMsg = err instanceof Error ? err.message : String(err)
      const category = classifyError(errMsg)
      const hint = hintForError(category, errMsg)
      console.error(chalk.red(`\n✗ ${errMsg}`) + chalk.dim(` [${category}]`) + (hint ? `\n  ${chalk.yellow('→')} ${hint}` : '') + '\n')
    } finally {
      stopHeartbeat()
      if (!opts.dryRun && lockAttemptStarted) {
        try { await releaseRemoteLock(octokit, owner, repo, sha, workflowError ? 'failure' : 'success') } catch { /* best-effort */ }
        await drainLoopLocks(workflowError ? 'failure' : 'success')
      }
      releasePRLock(owner, repo, number, sha)
      if (acquiredTmpDir) rmSync(acquiredTmpDir, { force: true, recursive: true })
    }
    // Exit 1 for a Linear misconfiguration — a user error under the CLI contract,
    // and what `crosscheck review` already returns for the same condition.
    if (workflowError) process.exit(isLinearConfigError(workflowError) ? 1 : 2)
  } finally {
    process.removeListener('SIGINT', earlySignalHandler)
    process.removeListener('SIGTERM', earlySignalHandler)
    process.removeListener('SIGINT', onSignal)
    process.removeListener('SIGTERM', onSignal)
  }
}

export type RunSpecOpts = RunOpts & ConcurrencyOpts

// Builds the argv for a `crosscheck run <url>` child process from the resolved
// RunOpts. Used by the multi-PR dispatcher to fan out one subprocess per PR,
// isolating each PR's locking, signal handling, and process.exit.
export function buildRunChildArgs(ref: PRRef, opts: RunOpts): string[] {
  const args = ['run', ref.url]
  if (opts.config) args.push('-c', opts.config)
  if (opts.reviewer) args.push('--reviewer', opts.reviewer)
  if (opts.fixer) args.push('--fixer', opts.fixer)
  if (opts.vendor) args.push('--vendor', opts.vendor)
  if (opts.steps) args.push('--steps', opts.steps)
  if (opts.dryRun) args.push('--dry-run')
  // --crazy/--half-crazy already imply --no-timeout; don't also pass a timeout flag.
  if (opts.roundMode === 'crazy') args.push('--crazy')
  else if (opts.roundMode === 'halfcrazy') args.push('--half-crazy')
  else if (opts.noTimeout) args.push('--no-timeout')
  else if (opts.timeout) args.push('--timeout', opts.timeout)
  args.push('--trigger', opts.trigger ?? 'run')
  return args
}

// Entry point for the `run` command (and the recheck/fix/resolve aliases). Expands
// the PR spec; a single PR runs in-process (preserving exit codes and signal
// handling); multiple PRs fan out to concurrent `crosscheck run` subprocesses.
export async function runRunSpec(spec: string, opts: RunSpecOpts = {}): Promise<void> {
  const concErr = concurrencyError(opts)
  if (concErr) {
    console.error(chalk.red(`✗ ${concErr}`))
    process.exit(1)
  }

  let refs: PRRef[]
  try {
    refs = parsePRSpec(spec)
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (refs.length === 1) {
    await runRun(refs[0].url, opts)
    return
  }

  // expected-head-sha is a single-PR guard (set by kickass dispatch); it can't
  // apply to a fan-out across many heads.
  if (opts.expectedHeadSha !== undefined) {
    console.error(chalk.red('✗ --expected-head-sha cannot be combined with multiple PRs'))
    process.exit(1)
  }

  const { concurrency, staggerMs } = resolveRunConcurrency(refs.length, opts)
  if (concurrency > 1) {
    console.log(chalk.dim(`\n  running ${Math.min(concurrency, refs.length)} agents in parallel across ${refs.length} PRs (${staggerMs}ms stagger)`))
  } else {
    console.log(chalk.dim(`\n  running ${refs.length} PRs sequentially`))
  }

  const invocation = resolveCliInvocation()
  const capture = concurrency > 1
  const dispatch = async (ref: PRRef): Promise<string | void> => {
    const args = [...invocation.args, ...buildRunChildArgs(ref, opts)]
    if (!capture) {
      // Sequential: stream child output live for an interactive single-stream feel.
      await execa(invocation.command, args, { stdio: 'inherit' })
      return
    }
    // Concurrent: capture combined output so executeMultiPR can print it per-PR
    // without interleaving. On failure, execa attaches captured output as err.all.
    const result = await execa(invocation.command, args, { stdio: 'pipe', all: true })
    return result.all ?? ''
  }

  const results = await executeMultiPR(refs, { dispatch }, concurrency, staggerMs)
  printMultiPRSummary(results)
  process.exitCode = aggregateExitCode(results)
}

// Step-forcing aliases: run only the named step against the PR spec, bypassing
// next-step auto-detection. Mirrors `ck run --steps <type>` but as first-class commands.
export function runRecheckSpec(spec: string, opts: RunSpecOpts = {}): Promise<void> {
  return runRunSpec(spec, { ...opts, steps: 'recheck' })
}

export function runFixSpec(spec: string, opts: RunSpecOpts = {}): Promise<void> {
  return runRunSpec(spec, { ...opts, steps: 'fix' })
}

export function runResolveSpec(spec: string, opts: RunSpecOpts = {}): Promise<void> {
  return runRunSpec(spec, { ...opts, steps: 'conflict-resolve' })
}
