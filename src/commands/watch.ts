import { execSync, spawn } from 'child_process'
import type { ChildProcess } from 'child_process'
import chalk from 'chalk'
import { createWebhookServer, type PREvent, type IssueCommentEvent } from '../github/webhook.js'
import {
  createGithubClient,
  getCommitMessage,
  registerOrgWebhook,
  deleteOrgWebhook,
  registerRepoWebhook,
  deleteRepoWebhook,
  patchOrgWebhookEvents,
  patchRepoWebhookEvents,
  findOrgWebhook,
  findRepoWebhook,
  listUserRepos,
  checkRepoAccessible,
} from '../github/client.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import {
  loadConfig,
  getGithubToken,
  getWebhookSecret,
  resolveConfigPath,
  promptDeploymentMode,
  detectScopesForDeployment,
  patchDeploymentConfig,
  detectGitHubLogin,
} from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { scanUnreviewedPRs } from '../lib/backtrace.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow, DEFAULT_RECHECK_INSTRUCTIONS, type WorkflowStep } from '../lib/workflow.js'
import { fetchStepHistory, identifyNextWorkflowStep } from '../lib/pr-workflow-state.js'
import { parseAnnotation } from '../lib/annotation.js'
import { PRBoard, fmtTime, FMT_TIME_WIDTH } from '../lib/board.js'
import { clonePRForReview } from '../lib/clone.js'
import {
  getSmartSwitch,
  isSubscriptionLimitError,
  detectFailedVendor,
  triggerSwitch,
  notifyReviewSuccess,
  stopSmartSwitch,
} from '../lib/smart-switch.js'
import type { Config } from '../config/schema.js'
import { buildReviewFailedCommentBody } from '../lib/comment-bodies.js'
import { classifyReviewerError } from '../lib/reviewer-error.js'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { runIssueFromWatchIdle } from './issue.js'
import { PersistentShaSet } from '../lib/sha-cache.js'
import { PersistentDiffHashMap, computeDiffHash } from '../lib/diff-hash.js'
import { dedupScopes, type Scope } from '../lib/scopes.js'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'
import { checkRemoteLock, acquireRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'
import { isCrosscheckCommitMessage } from '../lib/crosscheck-commit.js'

const WEBHOOK_EVENTS = ['pull_request', 'issue_comment']

function buildFallbackConfig(config: Config, fallbackVendor: 'claude' | 'codex'): Config {
  return {
    ...config,
    mode: 'single-vendor',
    vendors: {
      codex: { ...config.vendors.codex, enabled: fallbackVendor === 'codex' },
      claude: { ...config.vendors.claude, enabled: fallbackVendor === 'claude' },
    },
  }
}

// Compute PR diff size in lines, excluding noise (lockfiles, binaries, data files)
const NOISE_EXT = /\.(lock|snap|min\.js|min\.css|csv|json|png|jpg|jpeg|gif|svg|mp4|woff2?|ttf|eot|ico|pdf)$/i

function computePRLoc(tmpDir: string, baseBranch: string): number {
  try {
    const stat = execSync(`git diff --stat origin/${baseBranch}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
    let total = 0
    for (const line of stat.split('\n')) {
      const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)/)
      if (!m) continue
      const file = m[1].trim().replace(/\{.*?=> /, '').replace('}', '')  // handle rename notation
      if (!NOISE_EXT.test(file)) total += parseInt(m[2], 10)
    }
    return total
  } catch {
    return 0
  }
}

function detectCurrentRepo(): { owner: string; repo: string } | null {
  try {
    const remote = execSync('git remote get-url origin 2>/dev/null', { encoding: 'utf8' }).trim()
    const m = remote.match(/github\.com[:/]([^/]+)\/([^/.]+)/)
    if (m) return { owner: m[1], repo: m[2] }
  } catch { /* ignore */ }
  return null
}

// lhr.life tunnels can go dead (503) without the SSH process exiting.
// Polls every 60s and kills the proc after 2 consecutive failures (~2 min detection).
function waitForTunnelEnd(tunnelProc: ChildProcess, tunnelUrl: string): Promise<void> {
  return new Promise<void>(resolve => {
    let failCount = 0

    const check = setInterval(async () => {
      let alive = false
      try {
        const res = await fetch(tunnelUrl, { signal: AbortSignal.timeout(8000) })
        alive = res.status !== 503
      } catch { /* network error = dead */ }

      if (!alive) {
        if (++failCount >= 2) {
          clearInterval(check)
          tunnelProc.kill()
        }
      } else {
        failCount = 0
      }
    }, 60_000)

    tunnelProc.on('exit', () => { clearInterval(check); resolve() })
    tunnelProc.on('error', () => { clearInterval(check); resolve() })
  })
}

// Opens a localhost.run SSH tunnel. Resolves with the public base URL once
// the tunnel is ready. Rejects after 20s if no URL appears in the output.
function openTunnel(localPort: number): Promise<{ url: string; proc: ChildProcess }> {
  return new Promise((resolve, reject) => {
    const proc = spawn('ssh', [
      '-R', `80:localhost:${localPort}`,
      '-o', 'StrictHostKeyChecking=no',
      '-o', 'ServerAliveInterval=30',
      '-o', 'LogLevel=ERROR',
      'nokey@localhost.run',
    ], { stdio: ['ignore', 'pipe', 'pipe'] })

    const timer = setTimeout(() => {
      proc.kill()
      reject(new Error('Tunnel did not start within 20s — check your internet connection'))
    }, 20000)

    const onData = (data: Buffer) => {
      const text = data.toString()
      const match = text.match(/https:\/\/[a-zA-Z0-9.-]+\.(?:localhost\.run|lhr\.life)[^\s]*/i)
      if (match) {
        clearTimeout(timer)
        resolve({ url: match[0].replace(/\/$/, ''), proc })
      }
    }

    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)

    proc.on('exit', (code) => {
      clearTimeout(timer)
      if (code !== 0 && code !== null) {
        reject(new Error(`SSH tunnel exited (code ${code})`))
      }
    })
  })
}

export interface WatchOpts {
  config?: string
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
  backtrace?: boolean
}

export async function runWatch(opts: WatchOpts = {}) {
  const configPath = opts.config
  let config = loadConfig(configPath)
  initLogger(config.logs)

  process.on('uncaughtException', (err) => {
    logUncaught('uncaughtException', err)
    console.error(chalk.red(`\n✗ Uncaught exception: ${err.message}`))
    process.exit(2)
  })
  process.on('unhandledRejection', (reason) => {
    logUncaught('unhandledRejection', reason)
    console.error(chalk.red(`\n✗ Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`))
    process.exit(2)
  })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'watch', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  fileLog({ level: 'info', event: 'session_start', command: 'watch' })

  // Fetch the authenticated user so the onComment handler can reject annotation
  // injection from non-token accounts. If this fails, the handler is disabled
  // entirely (fail closed) — allowing unknown authors would defeat the guard.
  let authenticatedLogin: string | null = null
  try {
    const { data: me } = await createGithubClient(token).rest.users.getAuthenticated()
    authenticatedLogin = me.login
  } catch {
    fileLog({ level: 'warn', event: 'authenticated_login_unavailable', message: 'issue_comment bridge disabled — could not determine token owner' })
  }

  const webhookSecret = getWebhookSecret()
  const webhookPath = config.server.webhook_path

  // Board manages all terminal output after startup
  const board = new PRBoard()
  const workflow = loadWorkflow(process.cwd())
  board.setConfig(config, workflow)

  // Thin wrapper: routes important messages to both terminal and file log
  const bLog = (line1: string, line2?: string) => {
    board.log(line1, line2)
    fileLog({ level: 'info', event: 'message', message: line2 ? `${line1} ${line2}` : line1 })
  }

  // Connectivity events (tunnel/webhook) go into the live connectivity section
  const cLog = (line: string) => {
    board.logConnectivity(line)
    fileLog({ level: 'info', event: 'message', message: line })
  }

  // PR deduplication — skip if already reviewing this PR+SHA
  const inFlight = new Set<string>()
  // SHAs pushed by the fix step — persisted to disk so restarts don't re-review our own commits
  const crosscheckShas = new PersistentShaSet()
  // Last-reviewed diff hash per PR — skip reviews when a new SHA has identical diff vs base
  // (force-push, amend, no-op rebase). Persisted so restarts don't re-review unchanged content.
  const diffHashes = new PersistentDiffHashMap()
  // PRs reviewed at least once this session — synchronize events on these run as recheck rounds
  const reviewedPRKeys = new Set<string>()
  const prRoundCounts = new Map<string, number>()
  // PR+sha pairs completed by this watch session — used to suppress issue_comment
  // re-entries for reviews that watch posted itself (as opposed to kickass).
  const reviewedPRShaKeys = new Set<string>()

  // Idle tracking — reset on any PR activity; used by the idle-issue timer.
  let lastActivityAt = Date.now()
  let idleAnalysisRunning = false
  let idleIntervalRef: ReturnType<typeof setInterval> | null = null

  async function reviewPR(params: {
    owner: string; repoName: string; prNumber: number; title: string;
    body: string | null; author: string; headSha: string; headRef: string;
    headRepo: string | null; baseRef: string; action: string;
  }): Promise<void> {
    lastActivityAt = Date.now()  // reset idle timer on any PR event
    const { owner, repoName, prNumber } = params
    const key = `${owner}/${repoName}#${prNumber}@${params.headSha}`
    if (inFlight.has(key)) return
    inFlight.add(key)

    // Outer try/finally ensures the inFlight key is always released, even if
    // detectOriginFull / assignReviewer throw before the inner try block starts.
    try {
      if (!isAuthorAllowed(config.routing.allowed_authors, params.author)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author: params.author })
        return
      }

      const { origin, method: originMethod } = await detectOriginFull(
        params.body ?? '', params.headRef,
        owner, repoName, prNumber,
        config, token, params.author,
      )

      // Smart-switch: when cross-vendor is degraded, override to single-vendor with the healthy vendor
      const ss = getSmartSwitch()
      const effectiveConfig = (config.mode === 'cross-vendor' && ss.active && ss.fallbackVendor)
        ? buildFallbackConfig(config, ss.fallbackVendor)
        : config

      const reviewer = await assignReviewer(origin, effectiveConfig)

      fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: params.headSha, action: params.action, origin, origin_method: originMethod, author: params.author, smart_switch_active: ss.active })

      if (!reviewer) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'no_reviewer', origin })
        return
      }

      const ts = chalk.dim(fmtTime())
      const tsIndent = ' '.repeat(FMT_TIME_WIDTH + 2)
      const modeNote = ss.active ? chalk.yellow(' [smart-switch]') : ''
      bLog(
        `${ts}  PR #${prNumber} ${params.action}  ${chalk.dim(params.title)}`,
        `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  reviewer=${chalk.cyan(reviewer)}${modeNote}`
      )

      const pr: PREvent['pull_request'] = {
        title: params.title,
        body: params.body ?? '',
        head: { ref: params.headRef, sha: params.headSha, repo: params.headRepo ? { full_name: params.headRepo } : null },
        base: { ref: params.baseRef, repo: { full_name: `${owner}/${repoName}` } },
        html_url: `https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        user: { login: params.author },
      }

      if (!acquirePRLock(owner, repoName, prNumber, params.headSha)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'in_progress_local' })
        return
      }

      const lockOctokit = createGithubClient(token)
      if (await checkRemoteLock(lockOctokit, owner, repoName, params.headSha)) {
        releasePRLock(owner, repoName, prNumber, params.headSha)
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'in_progress_remote' })
        return
      }
      try {
        await acquireRemoteLock(lockOctokit, owner, repoName, params.headSha)
      } catch (err: unknown) {
        releasePRLock(owner, repoName, prNumber, params.headSha)
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'lock' }, err)
        return
      }

      const prKey = `${owner}/${repoName}#${prNumber}`

      // Determine the correct starting step from PR comment history so watch
      // behaves correctly after a restart (reviewedPRKeys is in-memory only).
      // Fast-path: if the PR was reviewed in this session, skip the API call.
      // Exception: comment-triggered runs must always do live detection —
      // reviewedPRKeys is SHA-agnostic and would misroute a kickass review
      // annotation for a new SHA as a recheck run instead of routing to fix.
      // auto_loop runs also skip the session fast-path so history detection
      // picks the correct starting step (fix, not recheck); round is instead
      // incremented from prRoundCounts to match the completed round count.
      let isRecheckRun = params.action === 'comment'
        ? reviewedPRShaKeys.has(key)    // SHA-specific: already processed this exact sha
        : params.action === 'auto_loop'
        ? false                          // always use history detection for auto-loop rounds
        : reviewedPRKeys.has(prKey)     // session fast-path for webhook/backtrace events
      let round = params.action === 'auto_loop'
        ? (prRoundCounts.get(prKey) ?? 1) + 1
        : isRecheckRun ? (prRoundCounts.get(prKey) ?? 1) + 1 : 1
      let resolvedSteps: WorkflowStep[] | undefined
      let detectedReviewComment: { id?: number; body: string } | undefined

      if (!isRecheckRun) {
        try {
          const allSteps = loadWorkflow(process.cwd())
          const history = await fetchStepHistory(owner, repoName, prNumber, token)
          const nextResult = identifyNextWorkflowStep(history, allSteps, params.headSha)
          if (nextResult.step === null) {
            // Workflow already complete for this HEAD sha — release lock and skip.
            // Happens when a synchronize event fires after all steps are done.
            await releaseRemoteLock(lockOctokit, owner, repoName, params.headSha, 'success')
            releasePRLock(owner, repoName, prNumber, params.headSha)
            fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'workflow_complete', sha: params.headSha })
            return
          }
          if (nextResult.hasExistingReview) {
            isRecheckRun = nextResult.step.type !== 'review'
            // auto_loop pre-computed the correct incremented round from prRoundCounts;
            // history detection returns the last recheck's round (unchanged across
            // iterations), so overwriting here would defeat the max_rounds cap.
            if (params.action !== 'auto_loop') round = nextResult.round
            detectedReviewComment = nextResult.reviewComment
            const nextStepIdx = allSteps.findIndex(s => s.type === nextResult.step!.type)
            if (nextStepIdx >= 0) {
              let steps = allSteps.slice(nextStepIdx)
              // Synthesize a recheck step when one isn't explicitly in workflow.yml,
              // but only for commit delivery mode. Under pull_request/comment delivery
              // the fix does not push to the PR head, so a recheck would evaluate the
              // un-fixed diff and post an incorrect verdict on the original PR.
              const deliveryMode = config.post_review.auto_fix.delivery.mode
              if (deliveryMode === 'commit' && !steps.some(s => s.type === 'recheck')) {
                const reviewStep = allSteps.find(s => s.type === 'review')
                if (reviewStep) {
                  const synthetic: WorkflowStep = {
                    ...reviewStep, name: 'recheck', type: 'recheck', reviewer,
                    when: undefined, instructions: DEFAULT_RECHECK_INSTRUCTIONS,
                  }
                  const lastFix = steps.map(s => s.type).lastIndexOf('fix')
                  steps = lastFix >= 0
                    ? [...steps.slice(0, lastFix + 1), synthetic, ...steps.slice(lastFix + 1)]
                    : [...steps, synthetic]
                }
              }
              resolvedSteps = steps
            } else if (nextResult.step.type === 'recheck') {
              // identifyNextWorkflowStep returned a synthetic recheck (fixedCurrentSha
              // path) but the type 'recheck' is not in allSteps, so nextStepIdx === -1.
              // Build resolvedSteps directly here so runWorkflow uses
              // DEFAULT_RECHECK_INSTRUCTIONS rather than falling back to a coerced
              // review step with review instructions.
              const deliveryMode = config.post_review.auto_fix.delivery.mode
              if (deliveryMode === 'commit') {
                const reviewStep = allSteps.find(s => s.type === 'review')
                if (reviewStep) {
                  resolvedSteps = [{
                    ...reviewStep, name: 'recheck', type: 'recheck' as const, reviewer,
                    when: undefined, instructions: DEFAULT_RECHECK_INSTRUCTIONS,
                  }]
                }
              }
            }
          }
        } catch {
          // best-effort — fall back to session-based detection.
          // For auto_loop, force isRecheckRun=true so a transient history-fetch
          // failure does not restart the workflow from the review step.
          if (params.action === 'auto_loop') isRecheckRun = true
        }
      }

      const reviewStart = Date.now()
      const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
      let stopHeartbeat = () => {}
      let boardAdded = false

      try {
        clonePRForReview({
          owner, repo: repoName, prNumber, baseRef: params.baseRef,
          tmpDir, token, protocol: config.clone_protocol,
          onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: params.baseRef }),
        })

        // Diff-aware skip: a new HEAD SHA with the same patch vs base as the last
        // successfully-reviewed SHA (force-push, amend, no-op rebase) doesn't need
        // a fresh review. Post a one-line acknowledgement so the PR author sees we noticed.
        // When the base ref fetch failed earlier, the diff vs base is not measurable;
        // skip the dedup check entirely and don't update the cache after this review.
        let newDiffHash: string | null = null
        try {
          newDiffHash = computeDiffHash(tmpDir, params.baseRef)
        } catch { /* base unavailable — proceed with full review, skip cache update */ }

        const prev = newDiffHash ? diffHashes.get(prKey) : undefined
        // Comment-triggered runs (issue_comment bridge) must bypass the diff-hash skip:
        // the annotation is the explicit signal to advance to fix, regardless of whether
        // the diff changed since the last review (e.g. no-op rebase/amend).
        if (newDiffHash && prev && prev.hash === newDiffHash && prev.sha !== params.headSha && params.action !== 'comment') {
          const prevShort = prev.sha.slice(0, 7)
          const nowShort = params.headSha.slice(0, 7)
          fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'no_diff_change', sha: params.headSha, prev_sha: prev.sha })
          bLog(
            `${chalk.dim(fmtTime())}  PR #${prNumber} ${params.action}  ${chalk.dim('no diff change since last review')}`,
            `${' '.repeat(FMT_TIME_WIDTH + 2)}prev=${chalk.dim(prevShort)} → ${chalk.dim(nowShort)}  ${chalk.dim('(skipped)')}`,
          )
          try {
            await lockOctokit.rest.issues.createComment({
              owner, repo: repoName, issue_number: prNumber,
              body: `✓ No diff change since the last review (was \`${prevShort}\`, now \`${nowShort}\`). Skipping re-review.\n\n<!-- crosscheck: no_diff_change prev_sha=${prev.sha} sha=${params.headSha} -->`,
            })
            fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, kind: 'no_diff_change' })
          } catch (err: unknown) {
            logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'no_diff_comment' }, err)
          }
          await releaseRemoteLock(lockOctokit, owner, repoName, params.headSha, 'success')
          return
        }

        board.addPR(key, prNumber, `${owner}/${repoName}`, params.headRef, round)
        boardAdded = true

        const prLoc = computePRLoc(tmpDir, params.baseRef)
        board.updatePR(key, { prLoc })
        stopHeartbeat = startRemoteLockHeartbeat(lockOctokit, owner, repoName, params.headSha)

        const { verdict, fixAppliedCount } = await runWorkflow({
          owner, repoName, prNumber, pr,
          tmpDir, token, config: effectiveConfig, origin,
          reviewStart,
          log: (msg: string) => bLog(`${chalk.dim(fmtTime())}  ${msg}`),
          onPhaseChange: (label, data) => board.updatePR(key, { label, ...data }),
          crosscheckShas,
          smartSwitchFallback: (ss.active && ss.fallbackVendor) ? ss.fallbackVendor : undefined,
          onVendorLimit: (failedVendor, fallbackVendor, reason) => {
            if (config.mode === 'cross-vendor' && fallbackVendor !== null && !getSmartSwitch().active) {
              triggerSwitch(failedVendor, reason, bLog)
            }
          },
          ...(resolvedSteps !== undefined && { steps: resolvedSteps }),
          ...(detectedReviewComment !== undefined && { initialReviewComment: detectedReviewComment }),
          isRecheckRun,
          round,
          trigger: params.action === 'backtrace' ? 'backtrace' : params.action === 'comment' ? 'comment' : 'watch',
        })

        void verdict
        reviewedPRKeys.add(prKey)
        reviewedPRShaKeys.add(key)  // key = "owner/repo#pr@sha"
        prRoundCounts.set(prKey, round)
        // Recompute the diff hash AFTER runWorkflow — workflow steps such as
        // `conflict-resolve` or `fix` followed by `recheck` can mutate the checkout,
        // so the pre-workflow hash may not represent the content that was actually
        // reviewed. Caching the stale hash would cause a later force-push back to
        // the pre-mutation diff to be skipped incorrectly as `no_diff_change`.
        // Capture the fix commit SHA independently of diff-hash availability.
        // fixCommitSha must be set even when newDiffHash is null (e.g. shallow
        // clone, base-branch fetch skipped) so the auto-loop can still fire after
        // a successful commit-mode fix in those environments.
        const deliveryMode = effectiveConfig.post_review.auto_fix.delivery.mode
        let fixCommitSha: string | null = null
        if (fixAppliedCount && deliveryMode === 'commit') {
          try {
            const headSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
            if (headSha !== params.headSha) fixCommitSha = headSha
          } catch { /* fall back — skip auto-loop this cycle */ }
        }
        if (newDiffHash) {
          // For non-commit delivery with an applied fix the checkout may be on a fix
          // branch; computeDiffHash would return the post-fix diff, not the original PR
          // diff. Caching that under prKey corrupts future no_diff_change checks for the
          // original PR. Only update the cache when no fix was applied, or delivery is
          // commit (fix stays on the same branch/checkout).
          if (!fixAppliedCount || deliveryMode === 'commit') {
            let reviewedHash: string | null = null
            try {
              reviewedHash = computeDiffHash(tmpDir, params.baseRef)
            } catch { /* base unavailable post-workflow — skip cache update */ }
            if (reviewedHash) {
              // When a fix was applied the HEAD advanced; cache the new SHA so the
              // auto-loop call on that SHA correctly sees prev.sha === headSha and
              // skips the no_diff_change guard (which would otherwise block round 2+).
              const reviewedSha = fixCommitSha ?? params.headSha
              diffHashes.upsert(prKey, { sha: reviewedSha, hash: reviewedHash })
            }
          }
        }
        board.completePR(key, {
          elapsedMs: Date.now() - reviewStart,
          url: `github.com/${owner}/${repoName}/pull/${prNumber}`,
        })
        // Smart-switch recovery confirmation: if a restore attempt is pending and
        // this reviewer matches the previously-degraded vendor, announce full restoration.
        notifyReviewSuccess(reviewer, bLog)
        stopHeartbeat()
        await releaseRemoteLock(lockOctokit, owner, repoName, params.headSha, 'success')
        // Auto-loop: if verdict is non-APPROVE, fixes were applied, and max_rounds
        // allows another iteration, trigger the next round directly. This makes
        // max_rounds behave as an autonomous fix→recheck cycle count rather than
        // requiring a human push to start each subsequent round.
        // Only safe under commit delivery — pull_request delivery leaves the local
        // checkout on a separate fix branch, so git rev-parse HEAD is not the PR
        // head and fixCommitSha would be wrong. Also verify the live PR head on
        // GitHub matches before scheduling to guard against the PR advancing
        // concurrently while the recheck was running.
        if (verdict && verdict !== 'APPROVE' && fixCommitSha) {
          if (deliveryMode === 'commit') {
            const allSteps = loadWorkflow(process.cwd())
            const fixRecheckSteps = allSteps.filter(s => s.type === 'fix' || s.type === 'recheck')
            const maxRounds = fixRecheckSteps.length > 0
              ? Math.min(...fixRecheckSteps.map(s => s.max_rounds ?? 1))
              : 1
            // Also allow when round === maxRounds but the current run had no recheck
            // step (workflow.yml has fix but not recheck). The next auto_loop invocation
            // will run only the synthetic recheck; it pushes no new commit so the outer
            // fixCommitSha guard prevents any further scheduling after that recheck.
            const effectiveSteps = resolvedSteps ?? allSteps
            const ranRecheck = effectiveSteps.some(s => s.type === 'recheck')
            if (round < maxRounds || !ranRecheck) {
              let prHeadSha: string | null = null
              try {
                const { data: freshPR } = await lockOctokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
                prHeadSha = freshPR.head.sha
              } catch { /* skip auto-loop if PR head is unverifiable */ }
              if (prHeadSha === fixCommitSha) {
                fileLog({ level: 'info', event: 'auto_loop_triggered', repo: `${owner}/${repoName}`, pr: prNumber, round, maxRounds, verdict, nextSha: fixCommitSha })
                setImmediate(() => void reviewPR({ ...params, headSha: fixCommitSha!, action: 'auto_loop' }))
              }
            }
          }
        }
      } catch (err: unknown) {
        stopHeartbeat()
        const message = err instanceof Error ? err.message : String(err)
        if (boardAdded) board.failPR(key, message)
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
        // Post a PR-visible failure comment when the error came from a reviewer
        // subprocess (timeout / usage limit / subprocess crash). Non-reviewer
        // errors (fix, conflict-resolve, GitHub API) return `null` from the
        // classifier and skip the comment — those have their own handling.
        // The comment uses a bareword marker so Phase 1 detection ignores it
        // and the next push still triggers a fresh review.
        const classified = classifyReviewerError(err)
        if (classified) {
          try {
            await lockOctokit.rest.issues.createComment({
              owner, repo: repoName, issue_number: prNumber,
              body: buildReviewFailedCommentBody({
                prUrl: `https://github.com/${owner}/${repoName}/pull/${prNumber}`,
                reason: classified.reason,
                summary: classified.summary,
                ...(classified.details !== undefined && { details: classified.details }),
              }),
            })
            fileLog({ level: 'info', event: 'review_failed_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, reason: classified.reason })
          } catch (postErr) {
            fileLog({ level: 'warn', event: 'review_failed_comment_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: postErr instanceof Error ? postErr.message : String(postErr) })
          }
        }
        await releaseRemoteLock(lockOctokit, owner, repoName, params.headSha, 'failure')
        // Smart-switch: when a reviewer hits a subscription limit in cross-vendor mode,
        // degrade to single-vendor with the healthy vendor for the next 30 minutes.
        if (config.mode === 'cross-vendor' && !getSmartSwitch().active && isSubscriptionLimitError(err)) {
          const failedVendor = detectFailedVendor(err)
          if (failedVendor) triggerSwitch(failedVendor, message, bLog)
        }
      } finally {
        releasePRLock(owner, repoName, prNumber, params.headSha)
        rmSync(tmpDir, { force: true, recursive: true })
      }
    } catch (err: unknown) {
      logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'setup' }, err)
    } finally {
      inFlight.delete(key)
    }
  }

  // Start local webhook server
  const server = createWebhookServer(
    config,
    webhookSecret,
    async (event: PREvent) => {
      const { pull_request: pr, repository: repo } = event
      const owner = repo.owner.login
      const repoName = repo.name
      const prNumber = event.number
      const key = `${owner}/${repoName}#${prNumber}@${pr.head.sha}`

      if (inFlight.has(key)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'duplicate' })
        return
      }

      if (event.action === 'synchronize') {
        const message = await getCommitMessage(owner, repoName, pr.head.sha, token).catch(() => null)
        if (message !== null && isCrosscheckCommitMessage(message)) {
          fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_commit', sha: pr.head.sha })
          return
        }
      }

      // Skip synchronize events triggered by our own address commits.
      // crosscheckShas is backed by disk so this also covers SHAs from prior sessions.
      if (crosscheckShas.has(pr.head.sha)) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_sha', sha: pr.head.sha })
        return
      }

      await reviewPR({
        owner, repoName, prNumber,
        title: pr.title, body: pr.body, author: pr.user.login,
        headSha: pr.head.sha, headRef: pr.head.ref, headRepo: pr.head.repo?.full_name ?? null,
        baseRef: pr.base.ref, action: event.action,
      })
    },
    (msg: string) => bLog(chalk.dim(fmtTime()) + '  ' + msg),
    fileLog,
    async (event: IssueCommentEvent) => {
      const owner = event.repository.owner.login
      const repoName = event.repository.name
      const prNumber = event.issue.number

      // Human feedback in regular PR comments is always valued and never reaches
      // this handler (webhook.ts only forwards comments that contain the hidden
      // <!-- crosscheck: ... type=review --> automation marker). The concern is
      // specifically annotation injection: someone deliberately embedding that
      // marker to drive automated fix work. Guard against it by verifying the
      // comment was posted by the account that owns the crosscheck token — the
      // only entity that legitimately writes these automation markers.
      // Fail closed: if we couldn't determine the token owner at startup, disable
      // the bridge entirely rather than allowing any commenter to trigger fixes.
      if (authenticatedLogin === null) {
        fileLog({ level: 'warn', event: 'comment_trigger_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'authenticated_login_unavailable' })
        return
      }
      if (event.comment.user.login !== authenticatedLogin) {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'annotation_injection_blocked', author: event.comment.user.login })
        return
      }

      // P2: the annotation embeds the SHA the review was written for. If the PR
      // head is already past that SHA, the fix would apply to an unreviewed diff —
      // let the synchronize event from the new commit handle it instead.
      const commentAnnotation = parseAnnotation(event.comment.body)
      const annotationSha = commentAnnotation?.sha  // may be short (7 chars)
      const shaMatches = (a: string, b: string) => a.startsWith(b) || b.startsWith(a)

      try {
        const octokit = createGithubClient(token)
        const initial = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
        let prData = initial.data

        // merged_at is absent from the issue_comment webhook payload so we check
        // PR state authoritatively here — skip closed or already-merged PRs.
        if (prData.state !== 'open' || prData.merged) {
          fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'pr_not_open', state: prData.state })
          return
        }

        if (annotationSha && !shaMatches(prData.head.sha, annotationSha)) {
          fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'comment_stale_sha', sha: prData.head.sha, annotation_sha: annotationSha })
          return
        }

        if (reviewedPRShaKeys.has(`${owner}/${repoName}#${prNumber}@${prData.head.sha}`)) {
          fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'comment_self_trigger', sha: prData.head.sha })
          return
        }

        // GitHub can deliver issue_comment before ck run's finally block releases
        // the remote lock. Retry with backoff; re-fetch the PR head on each attempt
        // so we don't dispatch against a sha that advanced while we were waiting.
        const RETRY_DELAYS_MS = [3_000, 10_000, 30_000]
        for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt++) {
          if (attempt > 0) {
            await new Promise(r => setTimeout(r, RETRY_DELAYS_MS[attempt - 1]))
            try {
              const { data: fresh } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
              prData = fresh
            } catch { /* best-effort — proceed with previous data */ }
            // PR may have been closed or merged during the backoff window
            if (prData.state !== 'open' || prData.merged) {
              fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'pr_not_open', state: prData.state })
              break
            }
            // PR advanced past the reviewed SHA during the wait — let synchronize handle it
            if (annotationSha && !shaMatches(prData.head.sha, annotationSha)) {
              fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'comment_stale_sha', sha: prData.head.sha })
              break
            }
          }

          if (reviewedPRShaKeys.has(`${owner}/${repoName}#${prNumber}@${prData.head.sha}`)) {
            fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'comment_self_trigger', sha: prData.head.sha })
            break
          }
          if (await checkRemoteLock(octokit, owner, repoName, prData.head.sha).catch(() => false)) {
            fileLog({ level: 'info', event: 'comment_trigger_deferred', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'in_progress_remote', attempt })
            continue
          }
          await reviewPR({
            owner, repoName, prNumber,
            title: prData.title,
            body: prData.body ?? '',
            author: prData.user?.login ?? '',
            headSha: prData.head.sha,
            headRef: prData.head.ref,
            headRepo: prData.head.repo?.full_name ?? null,
            baseRef: prData.base.ref,
            action: 'comment',
          })
          break
        }
      } catch (err: unknown) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'comment_trigger' }, err)
      }
    },
  )

  await new Promise<void>((resolve, reject) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      if (err.code === 'EADDRINUSE') {
        reject(new Error(
          `Port ${config.server.port} is already in use.\n` +
          `  Another crosscheck watch instance is likely running on this port.\n` +
          `  Stop it first — running two instances against the same scopes will\n` +
          `  register duplicate webhooks and post duplicate reviews.\n` +
          `  To run intentionally on a different port, change it in config:\n` +
          `    server:\n      port: ${config.server.port + 1}`
        ))
      } else {
        reject(err)
      }
    })
    server.listen(config.server.port, resolve)
  }).catch((err: Error) => {
    console.error(chalk.red(`\n✗ ${err.message}`))
    process.exit(1)
  })

  // ── Deployment setup ─────────────────────────────────────────────────────
  // Runs before scope building so detected users/orgs feed into webhook registration.
  let effectiveDeployment: 'personal' | 'team' | undefined = config.deployment
  let sessionOnly = false
  let selfLogin: string | null = null

  if (opts.personal || opts.team) {
    // One-time flag: auto-detect scopes for this session, no config write.
    effectiveDeployment = opts.personal ? 'personal' : 'team'
    sessionOnly = true
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    selfLogin = detected.login
    config = { ...config, users: detected.users, orgs: detected.orgs, repos: [] }
  } else if (opts.reconfigure || !config.deployment) {
    // First run (no deployment in config) or explicit --reconfigure.
    effectiveDeployment = await promptDeploymentMode(opts.reconfigure ? config.deployment : undefined)
    const cfgPath = resolveConfigPath(configPath) ?? join(process.cwd(), 'crosscheck.config.yml')
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    selfLogin = detected.login
    // force=true only for --reconfigure; first-run preserves any manually-configured orgs/authors
    patchDeploymentConfig(cfgPath, effectiveDeployment, detected.login, detected.orgs, !!opts.reconfigure)
    config = loadConfig(configPath)
    console.log(`\n  ${chalk.green('✓')} deployment set to ${chalk.cyan(effectiveDeployment)} ${chalk.dim(`(saved to ${cfgPath})`)}`)
  }

  // ── Scope building ────────────────────────────────────────────────────────
  // Determine scopes once — these don't change between tunnel reconnects.
  // orgs, users, and repos are additive: all configured sources contribute scopes.
  const rawScopes: Scope[] = []

  for (const org of config.orgs) rawScopes.push({ org })

  const userRepoResults: Array<{ user: string; count: number } | { user: string; error: string }> = []
  if (config.users.length > 0) {
    // selfLogin is known when we just ran detection; fall back to detectGitHubLogin() for
    // existing configs so personal-mode users still get private repos enumerated.
    if (!selfLogin) selfLogin = detectGitHubLogin()
    for (const user of config.users) {
      try {
        const repos = await listUserRepos(user, token, user === selfLogin)
        for (const { owner, name } of repos) rawScopes.push({ owner, repo: name })
        userRepoResults.push({ user, count: repos.length })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        userRepoResults.push({ user, error: msg })
      }
    }
  }

  // Validate explicitly-configured repos and skip any that are inaccessible.
  const repoChecks = await Promise.all(
    config.repos.map(async ({ owner, name }) => ({
      owner, name,
      ok: await checkRepoAccessible(owner, name, token).catch(() => false),
    }))
  )
  for (const { owner, name, ok } of repoChecks) {
    if (ok) {
      rawScopes.push({ owner, repo: name })
    } else {
      console.log(chalk.yellow(`  ✗ repo not accessible: ${owner}/${name} — skipped`))
      fileLog({ level: 'warn', event: 'repo_inaccessible', repo: `${owner}/${name}` })
    }
  }

  // Collapse repo scopes already covered by an org scope. Registering both produces
  // duplicate webhook deliveries from GitHub (one per registered hook), which our
  // in-flight dedup absorbs but still clutters logs and burns signature-verification cycles.
  const { scopes, dropped: droppedRepos, fallbackRepos } = dedupScopes(rawScopes)
  for (const [org, repos] of droppedRepos) {
    for (const repo of repos) {
      const fallback = fallbackRepos.get(org)?.find(s => s.repo === repo)
      fileLog({ level: 'info', event: 'scope_deduped', org, owner: fallback?.owner ?? org, repo, reason: 'covered_by_org_scope' })
    }
  }

  if (scopes.length === 0 && config.tunnel.backend !== 'smee') {
    // localhost.run needs a target repo to auto-register webhooks.
    // smee users register the webhook manually — no target required here.
    const detected = detectCurrentRepo()
    if (!detected) {
      console.error(chalk.red('No repos, users, or orgs configured. Run inside a git repo or set repos/users/orgs in config.'))
      server.close(() => process.exit(1))
      return
    }
    scopes.push({ owner: detected.owner, repo: detected.repo })
  }

  type RegisteredHook =
    | { type: 'org'; org: string; hookId: number }
    | { type: 'repo'; owner: string; repo: string; hookId: number }

  function webhookFailureReason(msg: string, isOrg: boolean): string {
    const isCreds = /bad credentials|\[401\]/i.test(msg)
    const isScope = /admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(msg)
      || (isOrg && /\[404\]/i.test(msg))
    return isCreds ? 'creds' : isScope ? 'scope' : `other:${msg}`
  }

  function addWebhookFailure(
    failures: Map<string, { labels: string[]; msg: string }>,
    reason: string,
    label: string,
    msg: string,
  ): void {
    const bucket = failures.get(reason)
    if (bucket) {
      bucket.labels.push(label)
    } else {
      failures.set(reason, { labels: [label], msg })
    }
  }

  // Mutable tunnel session state — replaced on each reconnect
  let currentTunnelProc: ChildProcess | null = null
  let currentRegistered: RegisteredHook[] = []
  let running = true

  async function deleteCurrentWebhooks(): Promise<void> {
    for (const hook of currentRegistered) {
      try {
        if (hook.type === 'org') {
          await deleteOrgWebhook(hook.org, hook.hookId, token)
        } else {
          await deleteRepoWebhook(hook.owner, hook.repo, hook.hookId, token)
        }
      } catch { /* best-effort */ }
    }
    currentRegistered = []
  }

  const cleanup = async () => {
    running = false
    if (idleIntervalRef !== null) clearInterval(idleIntervalRef)
    board.stop()
    stopSmartSwitch()
    console.log('\nCleaning up...')
    currentTunnelProc?.kill()
    await deleteCurrentWebhooks()
    fileLog({ level: 'info', event: 'session_end', command: 'watch' })
    server.close(() => process.exit(0))
  }

  process.on('SIGINT', () => { void cleanup() })
  process.on('SIGTERM', () => { void cleanup() })

  // ── Static startup banner ─────────────────────────────────────────────────
  console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
  console.log(chalk.bold('crosscheck watch\n'))
  if (effectiveDeployment) {
    const deployLabel = sessionOnly
      ? chalk.dim(`${effectiveDeployment} (session only — not saved)`)
      : chalk.cyan(effectiveDeployment)
    console.log(`  profile     ${deployLabel} · ${chalk.cyan(config.mode)} · ${chalk.cyan(config.quality.tier)}`)
  } else {
    console.log(`  profile     ${chalk.cyan(config.mode)} · ${chalk.cyan(config.quality.tier)}`)
  }
  if (config.orgs.length > 0) {
    console.log(`  orgs        ${chalk.cyan(config.orgs.join(', '))}`)
  }
  if (config.users.length > 0) {
    const userParts = userRepoResults.map(r => {
      if ('error' in r) return chalk.yellow(`${r.user} (⚠ list failed)`)
      return `${chalk.cyan(r.user)} ${chalk.dim(`(${r.count} repos)`)}`
    })
    console.log(`  users       ${userParts.join(', ')}`)
  }
  if (config.orgs.length === 0 && config.users.length === 0) {
    const labels = scopes.map(s => 'org' in s ? s.org : `${s.owner}/${s.repo}`)
    console.log(`  repos       ${chalk.cyan(labels.join(', '))}`)
  }
  const cfgPath = resolveConfigPath(configPath)
  console.log(`  config      ${chalk.dim(cfgPath ?? 'none (using defaults)')}  ${chalk.dim('← edit to change above')}`)
  if (effectiveDeployment === 'team' && config.routing.allowed_authors.length === 0) {
    console.log(`  authors     ${chalk.dim('all PRs (team mode)')}`)
  } else if (config.routing.allowed_authors.length > 0) {
    console.log(`  authors     ${chalk.cyan(config.routing.allowed_authors.join(', '))}`)
  } else {
    console.log()
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
    console.log(`     ${chalk.dim('Run')} ${chalk.cyan('crosscheck watch --reconfigure')} ${chalk.dim('to set up a deployment mode.')}`)
    // Without an author filter on a public (or broadly accessible) repo, any commenter
    // can post the hidden automation marker and attempt to trigger automated fix work.
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('Annotation injection risk: any commenter can post a hidden crosscheck annotation')}`)
    console.log(`     ${chalk.yellow('to trigger the automated fix bridge. Restrict via')} ${chalk.cyan('routing.allowed_authors')} ${chalk.yellow('or keep repos private.')}`)
  }

  // Warn when author_routes will be silently bypassed (cross-vendor + both vendors enabled)
  // so users understand why their configured mapping isn't applying.
  const bothVendorsEnabled = config.mode === 'cross-vendor'
    && config.vendors.claude.enabled
    && config.vendors.codex.enabled
  const routedAllowedAuthors = bothVendorsEnabled
    ? Object.entries(config.routing.author_routes).filter(([login]) =>
        config.routing.allowed_authors.length === 0 || config.routing.allowed_authors.includes(login)
      )
    : []
  if (routedAllowedAuthors.length > 0) {
    console.log()
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('author_routes bypassed in cross-vendor mode (both vendors enabled).')}`)
    for (const [login, vendor] of routedAllowedAuthors) {
      console.log(`     ${chalk.dim(`${login} → ${vendor}`)}`)
    }
    console.log(`     ${chalk.dim('PRs without attribution markers (body / Co-Authored-By / branch prefix)')}`)
    console.log(`     ${chalk.dim('fall through to')} ${chalk.cyan(`fallback_reviewer: ${config.routing.fallback_reviewer ?? 'skip'}`)} ${chalk.dim('instead.')}`)
  }

  // Warn when repo scopes were dropped because their owner is also an org scope —
  // both being registered causes duplicate webhook deliveries from GitHub.
  if (droppedRepos.size > 0) {
    console.log()
    console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('redundant repo scopes — org webhook already covers these:')}`)
    for (const [org, repos] of droppedRepos) {
      console.log(`     ${chalk.dim(`${org}/{${repos.join(', ')}}`)}`)
    }
    console.log(`     ${chalk.dim('Remove these entries from')} ${chalk.cyan('config.repos')} ${chalk.dim('to silence this warning.')}`)
  }

  console.log()

  // Board starts after the banner — all output below is live-updated
  board.start()

  // ── Idle issue timer ─────────────────────────────────────────────────────
  // When watch has been idle (no PR activity) for the configured duration,
  // offer to analyze logs and create an improvement ticket.
  const idleIssueCfg = config.watch?.idle_issue
  if (idleIssueCfg?.enabled !== false && process.stdin.isTTY) {
    const idleThresholdMs = (idleIssueCfg?.timeout_min ?? 30) * 60_000
    idleIntervalRef = setInterval(() => {
      if (!running) return
      if (idleAnalysisRunning) return
      if (inFlight.size > 0) return
      if (Date.now() - lastActivityAt < idleThresholdMs) return
      idleAnalysisRunning = true
      lastActivityAt = Date.now()  // prevent immediate re-trigger
      board.stop()
      void runIssueFromWatchIdle({ config: opts.config })
        .catch(err => {
          fileLog({ level: 'warn', event: 'idle_issue_flow_error', error: err instanceof Error ? err.message : String(err) })
        })
        .finally(() => {
          idleAnalysisRunning = false
          if (running) board.start()
        })
    }, 60_000)
  }

  // ── Backtrace scan ────────────────────────────────────────────────────────
  if (opts.backtrace === true || (opts.backtrace !== false && config.backtrace.enabled)) {
    void (async () => {
      try {
        cLog(`${chalk.dim('✦')} backtrace: scanning open PRs in monitored scope...`)
        const { queued, alreadyReviewed, skippedAuthor } = await scanUnreviewedPRs(scopes, config, token)
        cLog(`${chalk.dim('✦')} backtrace: ${queued.length} unreviewed, ${alreadyReviewed} already reviewed, ${skippedAuthor} skipped (author filter)`)
        void Promise.all(queued.map(pr => reviewPR({
          owner: pr.owner, repoName: pr.repo, prNumber: pr.number,
          title: pr.title, body: pr.body, author: pr.author,
          headSha: pr.headSha, headRef: pr.headRef, headRepo: pr.headRepo,
          baseRef: pr.baseRef, action: 'backtrace',
        })))
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        cLog(`${chalk.yellow('⚠')} backtrace: scan failed — ${msg}`)
      }
    })()
  }

  // ── Smee mode ─────────────────────────────────────────────────────────────
  // Smee channel URL is stable — webhooks are registered once and survive restarts.
  if (config.tunnel.backend === 'smee') {
    const channelUrl = config.tunnel.smee_channel
    if (!channelUrl) {
      board.stop()
      console.error(chalk.red('✗ tunnel.smee_channel is required when tunnel.backend: smee'))
      console.error(chalk.dim('  Visit https://smee.io/new to get a free channel URL.'))
      server.close(() => process.exit(1))
      return
    }
    board.setTunnel('smee', channelUrl, true)
    fileLog({ level: 'info', event: 'tunnel_opened', url: channelUrl, backend: 'smee' })

    // Register webhooks pointing at the smee channel URL (idempotent — skip if already set).
    // The smee channel URL never changes, so this survives restarts without creating duplicates.
    let smeeOk = 0, smeeFail = 0
    let smeeTotal = scopes.length
    const smeeFailuresByReason = new Map<string, { labels: string[]; msg: string }>()
    const succeededOrgs = new Set<string>()

    for (const scope of scopes) {
      const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`
      try {
        let existing: number | null
        if ('org' in scope) {
          existing = await findOrgWebhook(scope.org, channelUrl, token)
          if (!existing) await registerOrgWebhook(scope.org, channelUrl, webhookSecret, token)
          else await patchOrgWebhookEvents(scope.org, existing, WEBHOOK_EVENTS, token).catch(() => {/* best-effort */})
          succeededOrgs.add(scope.org)
        } else {
          existing = await findRepoWebhook(scope.owner, scope.repo, channelUrl, token)
          if (!existing) await registerRepoWebhook(scope.owner, scope.repo, channelUrl, webhookSecret, token)
          else await patchRepoWebhookEvents(scope.owner, scope.repo, existing, WEBHOOK_EVENTS, token).catch(() => {/* best-effort */})
        }
        smeeOk++
        fileLog({ level: 'info', event: existing ? 'webhook_active' : 'webhook_registered', scope: label, url: channelUrl })
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err)
        const fallbackOrg = 'org' in scope ? scope.org : null
        smeeFail++
        addWebhookFailure(smeeFailuresByReason, webhookFailureReason(msg, fallbackOrg !== null), label, msg)
        fileLog({ level: 'warn', event: 'webhook_error', scope: label, message: msg })

        const fallback = fallbackOrg ? fallbackRepos.get(fallbackOrg) ?? [] : []
        smeeTotal += fallback.length
        await Promise.all(fallback.map(async ({ owner, repo }) => {
          const repoLabel = `${owner}/${repo}`
          try {
            const existing = await findRepoWebhook(owner, repo, channelUrl, token)
            if (!existing) await registerRepoWebhook(owner, repo, channelUrl, webhookSecret, token)
            else await patchRepoWebhookEvents(owner, repo, existing, WEBHOOK_EVENTS, token).catch(() => {/* best-effort */})
            smeeOk++
            fileLog({ level: 'info', event: existing ? 'webhook_active' : 'webhook_registered', scope: repoLabel, url: channelUrl, fallback_for_org: fallbackOrg })
          } catch (fallbackErr: unknown) {
            const fallbackMsg = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
            smeeFail++
            addWebhookFailure(smeeFailuresByReason, webhookFailureReason(fallbackMsg, false), repoLabel, fallbackMsg)
            fileLog({ level: 'warn', event: 'webhook_error', scope: repoLabel, message: fallbackMsg, fallback_for_org: fallbackOrg })
          }
        }))
      }
    }

    // Cleanup: org hook succeeded → delete any stale repo-level hooks for repos now covered by the org hook.
    // Without this, a repo hook registered before the org scope was added would keep firing,
    // re-introducing the duplicate-delivery problem the scope dedup is meant to fix.
    for (const [org, repos] of droppedRepos) {
      if (!succeededOrgs.has(org)) continue
      for (const repo of repos) {
        try {
          const staleId = await findRepoWebhook(org, repo, channelUrl, token)
          if (staleId) {
            await deleteRepoWebhook(org, repo, staleId, token)
            fileLog({ level: 'info', event: 'webhook_deleted', scope: `${org}/${repo}`, reason: 'covered_by_org_hook' })
          }
        } catch { /* best-effort */ }
      }
    }

    // Grouped failure summary — one block per error type
    for (const [reason, { labels, msg }] of smeeFailuresByReason) {
      const count = labels.length
      const shown = labels.slice(0, 5)
      const overflow = count - shown.length
      const sample = shown.join(', ') + (overflow > 0 ? ` +${overflow} more` : '')
      const noun = count === 1 ? 'webhook' : 'webhooks'
      if (reason === 'creds') {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: token invalid — run: ${chalk.cyan('gh auth refresh')}`)
      } else if (reason === 'scope') {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: missing scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`)
      } else {
        cLog(`${chalk.yellow('⚠')} ${count} ${noun} failed: ${msg}`)
      }
      cLog(`  ${chalk.dim(sample)}`)
    }
    cLog(`${smeeFail === 0 ? chalk.green('✓') : chalk.yellow('⚠')} webhooks registered: ${smeeOk}/${smeeTotal}${smeeFail > 0 ? ` (${smeeFail} failed)` : ''}`)

    let smeeRetryDelay = 5_000
    while (running) {
      const smeeProc = spawn('smee', [
        '--url', channelUrl,
        '--path', config.server.webhook_path,
        '--port', String(config.server.port),
      ], { stdio: 'pipe' })
      currentTunnelProc = smeeProc

      try {
        await new Promise<void>((resolve, reject) => {
          smeeProc.on('error', (err: NodeJS.ErrnoException) => {
            if (err.code === 'ENOENT') {
              reject(new Error('smee-client not installed — run: npm install -g smee-client'))
            } else {
              reject(err)
            }
          })
          smeeProc.on('exit', () => resolve())
        })
      } catch (err) {
        board.stop()
        console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
        server.close(() => process.exit(1))
        return
      }

      if (!running) break
      currentTunnelProc = null
      board.setTunnel('smee', channelUrl, false)
      cLog(chalk.yellow(`smee relay exited — reconnecting in ${smeeRetryDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true, backend: 'smee' })
      await new Promise(r => setTimeout(r, smeeRetryDelay))
      smeeRetryDelay = Math.min(smeeRetryDelay * 2, 60_000)
      board.setTunnel('smee', channelUrl, true)
    }
    return
  }

  // ── localhost.run mode ────────────────────────────────────────────────────
  let reconnectDelay = 5_000
  while (running) {
    board.setTunnel('localhost.run', null, false)
    let tunnelUrl: string
    let tunnelProc: ChildProcess
    try {
      ;({ url: tunnelUrl, proc: tunnelProc } = await openTunnel(config.server.port))
    } catch (err: unknown) {
      if (!running) break
      const msg = err instanceof Error ? err.message : String(err)
      cLog(chalk.yellow(`tunnel failed: ${msg} — retrying in ${reconnectDelay / 1000}s`))
      fileLog({ level: 'warn', event: 'tunnel_error', message: msg })
      await new Promise(r => setTimeout(r, reconnectDelay))
      reconnectDelay = Math.min(reconnectDelay * 2, 60_000)
      continue
    }
    reconnectDelay = 5_000  // reset backoff on success

    currentTunnelProc = tunnelProc
    board.setTunnel('localhost.run', tunnelUrl, true)
    cLog(`${chalk.green('✓')} tunnel ready: ${chalk.cyan(tunnelUrl)}`)
    fileLog({ level: 'info', event: 'tunnel_opened', url: tunnelUrl })

    // Register webhooks in parallel: dedup check → register with backoff → aggregate summary
    const webhookUrl = `${tunnelUrl}${webhookPath}`
    currentRegistered = []
    let hookOk = 0, hookFail = 0
    let hookTotal = scopes.length
    const failuresByReason = new Map<string, { labels: string[]; msg: string }>()

    await Promise.all(scopes.map(async (scope) => {
      const label = 'org' in scope ? scope.org : `${scope.owner}/${scope.repo}`

      // Dedup: skip if a hook for this exact URL already exists (e.g. previous session not cleaned up)
      let existingId: number | null = null
      try {
        existingId = 'org' in scope
          ? await findOrgWebhook(scope.org, webhookUrl, token)
          : await findRepoWebhook(scope.owner, scope.repo, webhookUrl, token)
      } catch { /* ignore — proceed to register */ }

      if (existingId !== null) {
        currentRegistered.push('org' in scope
          ? { type: 'org' as const, org: scope.org, hookId: existingId }
          : { type: 'repo' as const, owner: scope.owner, repo: scope.repo, hookId: existingId })
        hookOk++
        fileLog({ level: 'info', event: 'webhook_active', scope: label, url: webhookUrl })
        // Ensure the hook delivers issue_comment (may be missing on hooks created
        // before this feature was added). Best-effort — a patch failure is non-fatal.
        if ('org' in scope) {
          patchOrgWebhookEvents(scope.org, existingId, WEBHOOK_EVENTS, token).catch(() => {/* best-effort */})
        } else {
          patchRepoWebhookEvents(scope.owner, scope.repo, existingId, WEBHOOK_EVENTS, token).catch(() => {/* best-effort */})
        }
        return
      }

      // Register with exponential back-off: delay 2s then 4s before giving up
      let hookId: number | null = null
      let lastErr = ''
      for (let attempt = 0; attempt < 3; attempt++) {
        if (attempt > 0) {
          const delay = 2 ** attempt * 1000
          fileLog({ level: 'warn', event: 'webhook_register_retry', scope: label, attempt, message: lastErr })
          await new Promise(r => setTimeout(r, delay))
        }
        try {
          hookId = 'org' in scope
            ? await registerOrgWebhook(scope.org, webhookUrl, webhookSecret, token)
            : await registerRepoWebhook(scope.owner, scope.repo, webhookUrl, webhookSecret, token)
          break
        } catch (err: unknown) {
          lastErr = err instanceof Error ? err.message : String(err)
        }
      }

      if (hookId !== null) {
        currentRegistered.push('org' in scope
          ? { type: 'org' as const, org: scope.org, hookId }
          : { type: 'repo' as const, owner: scope.owner, repo: scope.repo, hookId })
        hookOk++
        fileLog({ level: 'info', event: 'webhook_registered', scope: label, url: webhookUrl })
      } else {
        const fallbackOrg = 'org' in scope ? scope.org : null
        hookFail++
        addWebhookFailure(failuresByReason, webhookFailureReason(lastErr, fallbackOrg !== null), label, lastErr)
        fileLog({ level: 'warn', event: 'webhook_error', scope: label, message: lastErr })

        const fallback = fallbackOrg ? fallbackRepos.get(fallbackOrg) ?? [] : []
        hookTotal += fallback.length
        await Promise.all(fallback.map(async ({ owner, repo }) => {
          const repoLabel = `${owner}/${repo}`
          let fallbackHookId: number | null = null
          let fallbackLastErr = ''
          try {
            fallbackHookId = await findRepoWebhook(owner, repo, webhookUrl, token)
          } catch { /* ignore — proceed to register */ }
          if (fallbackHookId === null) {
            for (let attempt = 0; attempt < 3; attempt++) {
              if (attempt > 0) {
                const delay = 2 ** attempt * 1000
                fileLog({ level: 'warn', event: 'webhook_register_retry', scope: repoLabel, attempt, message: fallbackLastErr, fallback_for_org: fallbackOrg })
                await new Promise(r => setTimeout(r, delay))
              }
              try {
                fallbackHookId = await registerRepoWebhook(owner, repo, webhookUrl, webhookSecret, token)
                break
              } catch (fallbackErr: unknown) {
                fallbackLastErr = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
              }
            }
          }

          if (fallbackHookId !== null) {
            currentRegistered.push({ type: 'repo', owner, repo, hookId: fallbackHookId })
            hookOk++
            fileLog({ level: 'info', event: 'webhook_registered', scope: repoLabel, url: webhookUrl, fallback_for_org: fallbackOrg })
          } else {
            hookFail++
            addWebhookFailure(failuresByReason, webhookFailureReason(fallbackLastErr, false), repoLabel, fallbackLastErr)
            fileLog({ level: 'warn', event: 'webhook_error', scope: repoLabel, message: fallbackLastErr, fallback_for_org: fallbackOrg })
          }
        }))
      }
    }))

    // Print grouped failure summary — one block per error type, not one line per repo
    for (const [reason, { labels, msg }] of failuresByReason) {
      const count = labels.length
      const shown = labels.slice(0, 5)
      const overflow = count - shown.length
      const sample = shown.join(', ') + (overflow > 0 ? ` +${overflow} more` : '')
      const noun = count === 1 ? 'webhook' : 'webhooks'
      if (reason === 'creds') {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: token invalid — run: ${chalk.cyan('gh auth refresh')}`)
      } else if (reason === 'scope') {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: missing scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`)
      } else {
        bLog(`  ${chalk.yellow('⚠')} ${count} ${noun} failed: ${msg}`)
      }
      bLog(`    ${chalk.dim(sample)}`)
      bLog(`  manual Payload URL: ${chalk.cyan(webhookUrl)}`)
    }

    // Single aggregated connectivity line instead of one per repo
    cLog(`${hookFail === 0 ? chalk.green('✓') : chalk.yellow('⚠')} webhooks registered: ${hookOk}/${hookTotal}${hookFail > 0 ? ` (${hookFail} failed)` : ''}`)
    fileLog({ level: 'info', event: 'webhooks_registered', count: hookOk, total: hookTotal, failed: hookFail, url: webhookUrl })

    // Wait for this tunnel session to end.
    // Health check kills the SSH proc if lhr.life goes dead without exiting.
    await waitForTunnelEnd(tunnelProc, tunnelUrl)

    if (!running) break

    // Clean up webhooks tied to the old URL before reconnecting
    await deleteCurrentWebhooks()
    board.setTunnel('localhost.run', tunnelUrl, false)
    cLog(chalk.yellow('tunnel disconnected — reconnecting in 5s...'))
    fileLog({ level: 'warn', event: 'tunnel_closed', reconnecting: true })
    await new Promise(r => setTimeout(r, reconnectDelay))
  }
}
