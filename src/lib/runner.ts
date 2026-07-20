import { execSync, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import type { Config } from '../config/schema.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import type { Vendor } from '../lib/vendor.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runFixStep, runCodexFixStep } from '../reviewers/fix.js'
import { runConflictResolveStep, findConflictedFiles } from '../reviewers/conflict-resolve.js'
import { parseVerdict, prependVerdictToComment, NULL_VERDICT_WARNING, applySeverityGate, SEVERITY_GATE_NOTE } from '../lib/verdict.js'
import { createGithubClient, postReviewComment, getLastCrossCheckCommentId, getLastCrossCheckReviewComment } from '../github/client.js'
import { acquireRemoteLock, releaseRemoteLock } from '../github/review-status.js'
import { log as fileLog, logError, classifyError } from '../lib/logger.js'
import { buildCommitTrailers } from '../lib/annotation.js'
import { resolveClaudeModel, resolveCodexModel } from '../lib/review-models.js'
import { buildStepIdentityFields } from '../lib/event-fields.js'
import { buildFixAppliedCommentBody, buildConflictResolvedCommentBody, buildRetriedReviewBanner } from '../lib/comment-bodies.js'
import { loadWorkflow, loadHarnessSection, evaluateWhen, type StepResult } from '../lib/workflow.js'
import type { PRPhase } from '../lib/board.js'
import { isSubscriptionLimitError, isVendorUnavailableError } from '../lib/smart-switch.js'
import { tierTimeoutMs } from '../reviewers/tier-timeouts.js'

const MAX_CROSSCHECK_COMMITS = 5
const FIX_RETRY_DELAY_MS = 2 * 60 * 1000
const REVIEW_RETRY_DELAY_MS = 2 * 60 * 1000
const GIT_PUSH_RETRY_DELAY_MS = 3000

// Per-vendor configured timeout (seconds) → execa milliseconds, or undefined when
// unset so the reviewer falls back to its built-in default. A per-run override
// (ctx.overrideTimeoutMs, set by --timeout / --crazy / --halfcrazy) always wins
// over this; 0 from that override means "no cap" and is preserved by `??`.
function vendorTimeoutMs(timeoutSec: number | null): number | undefined {
  return timeoutSec == null ? undefined : timeoutSec * 1000
}

// Auth and quota/credit failures are operator/vendor-capacity issues that won't
// self-heal through an immediate retry. Transient subprocess failures can retry.
export function isRetryableFixError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  return !/auth failure|not logged in|claude auth/i.test(msg) && !isSubscriptionLimitError(err)
}

// Transient model API errors (rate-limit 429, overloaded 529) are safe to retry
// with a delay. Auth, budget, and subscription-limit errors are operator/capacity
// issues that don't self-heal and should surface immediately.
function isTransientApiError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err)
  if (/quota|credit|plan.?limit/i.test(msg)) return false
  return /\b429\b|rate.?limit|\b529\b|overloaded/i.test(msg)
}

// When a PR has already been reviewed, subsequent webhook runs treat every
// 'review' step as a 'recheck' so the first review's CR result is preserved.
export function getEffectiveStepType(stepType: string, isRecheckRun: boolean): string {
  return stepType === 'review' && isRecheckRun ? 'recheck' : stepType
}

// Counts crosscheck-authored commits unique to this PR (ahead of base) rather
// than the branch's full history. Long-lived integration branches like
// `staging` accumulate [crosscheck] commits from many merged PRs — counting
// those would trip the per-PR fix-loop guard immediately and skip fix/recheck.
//
// Fails closed: when `origin/<base>` isn't available (e.g. clone fetched the
// base ref with `base_branch_fetch_skipped`), fall back to the full-history
// count rather than returning 0. Over-counting can stop fix early; returning 0
// would silently disable the cap and let runaway fix loops keep pushing.
export function countCrosscheckCommitsForPR(tmpDir: string, baseRef: string): number {
  const runLog = (args: string[]): string =>
    execFileSync(
      'git',
      ['log', '--oneline', ...args],
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const count = (out: string): number => out.split('\n').filter(l => l.includes('[crosscheck]')).length

  try {
    return count(runLog([`origin/${baseRef}..HEAD`]))
  } catch {
    // Scoped range unavailable — fall back to full history so the cap still
    // applies. May over-count when the branch has prior merged crosscheck
    // commits, but that's preferable to bypassing the safety guard.
    try {
      return count(runLog([]))
    } catch {
      return 0
    }
  }
}

// Subset of WorkflowContext + accumulators the workflow_complete event needs.
// Kept narrow so this can be tested without constructing a full WorkflowContext.
// How the workflow was triggered. Included in workflow_complete, review_complete,
// fix_complete, and conflict_resolve_complete so log analysis can segment outcomes
// by entry point (e.g. kickass vs webhook vs direct run).
export type WorkflowTrigger = 'run' | 'kickass' | 'watch' | 'serve' | 'backtrace' | 'comment'

export interface WorkflowCompleteInputs {
  owner: string
  repoName: string
  prNumber: number
  workflowId: string
  workflowStart: number
  stepsRun: string[]
  results: Record<string, StepResult>
  workflowFailed: boolean
  round?: number
  trigger?: WorkflowTrigger
  qualityTier?: string
  workflowError?: unknown
  failedStep?: string
  now?: number  // injectable for testing total_duration_ms; defaults to Date.now()
}

// Reasons workflow can end. Today's runner emits only 'completed' and 'error';
// 'progress_gate' arrives with the single-gate work (PR-C of the redesign) and
// 'max_iterations' with the loop primitive (PR-D). 'manual_abort' is reserved
// for SIGINT/SIGTERM-driven exits — the current signal handler bypasses the
// finally so it's not wired up here yet.
export type WorkflowEndedReason =
  | 'completed'
  | 'error'
  | 'progress_gate'
  | 'max_iterations'
  | 'manual_abort'

export function buildWorkflowCompleteEvent(
  inputs: WorkflowCompleteInputs,
): Record<string, unknown> {
  const stepValues = Object.values(inputs.results)
  const lastVerdict = stepValues.reverse().find(r => r.verdict !== undefined)?.verdict ?? null
  const lastStep = inputs.stepsRun.length > 0 ? inputs.stepsRun[inputs.stepsRun.length - 1] : null
  const endedReason: WorkflowEndedReason = inputs.workflowFailed ? 'error' : 'completed'
  const now = inputs.now ?? Date.now()
  const rawErrorMessage = inputs.workflowError instanceof Error ? inputs.workflowError.message : inputs.workflowError !== undefined ? String(inputs.workflowError) : undefined
  const errorMessage = rawErrorMessage !== undefined && rawErrorMessage.length > 500
    ? `${rawErrorMessage.slice(0, 500)} …[truncated]`
    : rawErrorMessage

  const totalTokens = stepValues.reduce((s, r) => s + (r.tokens_used ?? 0), 0)
  // Only emit split fields when at least one step actually recorded them — avoid
  // emitting 0/0 for codex-only or fix-only workflows where splits are unavailable.
  const hasSplits = stepValues.some(r => r.input_tokens !== undefined || r.output_tokens !== undefined)
  const totalInputTokens = hasSplits ? stepValues.reduce((s, r) => s + (r.input_tokens ?? 0), 0) : undefined
  const totalOutputTokens = hasSplits ? stepValues.reduce((s, r) => s + (r.output_tokens ?? 0), 0) : undefined
  const vendorsUsed = [...new Set(stepValues.map(r => r.vendor).filter(Boolean))]

  return {
    level: inputs.workflowFailed ? 'warn' : 'info',
    event: 'workflow_complete',
    repo: `${inputs.owner}/${inputs.repoName}`,
    pr: inputs.prNumber,
    workflow_id: inputs.workflowId,
    steps_run: inputs.stepsRun,
    last_step: lastStep,
    last_verdict: lastVerdict,
    ended_reason: endedReason,
    total_duration_ms: now - inputs.workflowStart,
    ...(totalTokens > 0 && { total_tokens: totalTokens, ...(hasSplits && { total_input_tokens: totalInputTokens, total_output_tokens: totalOutputTokens }) }),
    ...(vendorsUsed.length > 0 && { vendors_used: vendorsUsed }),
    ...(inputs.qualityTier !== undefined && { quality_tier: inputs.qualityTier }),
    ...(inputs.round !== undefined && { round: inputs.round }),
    ...(inputs.trigger !== undefined && { trigger: inputs.trigger }),
    ...(inputs.failedStep !== undefined && { failed_step: inputs.failedStep }),
    ...(errorMessage !== undefined && { error_message: errorMessage, error_category: classifyError(rawErrorMessage ?? '') }),
  }
}

// Returns true when fix/recheck steps should be skipped because the configured
// max_rounds cap has been reached. The review step (even when coerced to recheck)
// is never skipped — it always produces a verdict for the current push.
export function exceedsMaxRounds(
  effectiveType: string,
  originalStepType: string,
  maxRounds: number,
  round: number | undefined,
): boolean {
  if (round === undefined) return false
  if (effectiveType === 'fix') return round > maxRounds
  if (effectiveType === 'conflict-resolve') return round > maxRounds
  // Recheck step from the workflow (not a review coerced to recheck) is gated
  if (effectiveType === 'recheck' && originalStepType !== 'review') return round > maxRounds
  return false
}

// True when any step recorded in this session applied at least one change
// (fix or conflict-resolve). Used to decide whether a following recheck has
// anything new to evaluate.
export function anyFixApplied(results: Record<string, StepResult>): boolean {
  return Object.values(results).some(r => (r.applied_count ?? 0) > 0)
}

export interface PRPhaseData {
  phase?: PRPhase
  verdict?: string | null
  commentCount?: number
  fixCount?: number
  recheckVerdict?: string | null
  crTokens?: number
  recheckTokens?: number
  fixTokens?: number
  crReviewer?: string
  recheckReviewer?: string
  qualityTier?: string
}

export interface WorkflowContext {
  owner: string
  repoName: string
  prNumber: number
  pr: PREvent['pull_request']
  tmpDir: string
  token: string
  config: Config
  origin: PROrigin
  reviewStart: number
  log: (msg: string) => void
  onPhaseChange: (label: string, data?: PRPhaseData) => void
  // SHAs crosscheck pushed — used to skip self-triggered synchronize events
  crosscheckShas: Set<string>
  // When true, all 'review' steps are coerced to 'recheck' steps — preserving
  // the first round's CR result on the board while still posting a verdict.
  isRecheckRun?: boolean
  // 1-based round counter passed to log events and the board display.
  round?: number
  // When true, review output is printed but the GitHub comment is not posted
  // and the fix step is skipped. Used by `crosscheck run --dry-run`.
  dryRun?: boolean
  // Override the steps to execute instead of loading from workflow.yml.
  // Used by `crosscheck run --steps` to run only a subset of the pipeline.
  steps?: import('./workflow.js').WorkflowStep[]
  // When smart-switch is active, route to this vendor if the step's configured
  // reviewer resolves to a disabled vendor rather than skipping the step.
  smartSwitchFallback?: 'claude' | 'codex'
  // Caller-supplied array the runner appends to whenever it sets a remote
  // pending status on a newly pushed sha (currently only from conflict-resolve).
  // Lets the command-layer signal handler release those shas if SIGINT/SIGTERM
  // fires mid-workflow — otherwise process.exit bypasses the runner's finally
  // and the pending status is leaked indefinitely on GitHub.
  pushedShas?: string[]
  // Optional review comment selected by the caller. Used by operator flows that
  // already scanned the PR and want fix-only runs to avoid reselecting a
  // different comment after dispatch.
  initialReviewComment?: {
    id?: number
    body: string
  }
  // When set, overrides step.max_rounds for all fix and recheck steps in this
  // run. Pass Infinity to disable the per-step cap entirely (used by --crazy /
  // --halfcrazy modes, which apply their own outer ceiling instead).
  overrideMaxRounds?: number
  // Loop mode set by --crazy / --halfcrazy. Included in review_complete and
  // step_skipped log events so operators can filter loop activity in logs.
  roundMode?: 'crazy' | 'halfcrazy'
  // Reviewer subprocess timeout override. 0 = no cap (crazy/halfcrazy).
  // When undefined, each reviewer uses its built-in default.
  overrideTimeoutMs?: number
  // How this workflow was triggered — logged in step events for analysis segmentation.
  trigger?: WorkflowTrigger
  // Called when a vendor hits a quota/credit limit and the runner can identify
  // an immediate same-step fallback. Long-lived commands use this to activate
  // smart-switch without failing the current PR first.
  onVendorLimit?: (failedVendor: Vendor, fallbackVendor: Vendor | null, reason: string, stepName: string) => void
}

export interface WorkflowResult {
  verdict: string | null
  // Sum of applied_count across all fix steps; 0 means fix ran but made no
  // changes; undefined means no fix step executed in this run.
  fixAppliedCount?: number
  // When fixAppliedCount is undefined, the reason the fix step was skipped
  // (e.g. 'fix_error', 'commit_limit_reached', 'no_vendor', 'fork_pr').
  // Lets callers distinguish transient errors from structural skips.
  fixSkipReason?: string
  // Latest review/recheck comment produced by this workflow. Operator loops
  // feed this into the next fix round so fixes target the freshest failed
  // recheck instead of falling back to the original review comment.
  latestReviewComment?: {
    id?: number
    body: string
  }
}

function countComments(reviewText: string): number {
  const bullets = (reviewText.match(/^[-*•]\s/gm) ?? []).length
  const numbered = (reviewText.match(/^\d+\.\s/gm) ?? []).length
  return bullets + numbered
}

function resolveReviewer(
  reviewer: string,
  origin: PROrigin,
  config: Config,
  fallback?: Vendor,
): Vendor | null {
  if (reviewer === 'origin') {
    if (origin === 'claude' && config.vendors.claude.enabled) return 'claude'
    if (origin === 'codex' && config.vendors.codex.enabled) return 'codex'
    return fallback && config.vendors[fallback].enabled ? fallback : null
  }
  if (reviewer === 'auto') {
    if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
    if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }
  if (reviewer === 'claude') return config.vendors.claude.enabled ? 'claude' : (fallback && config.vendors[fallback].enabled ? fallback : null)
  if (reviewer === 'codex') return config.vendors.codex.enabled ? 'codex' : (fallback && config.vendors[fallback].enabled ? fallback : null)
  return null
}

function supportsStep(vendor: Vendor, stepType: string): boolean {
  if (stepType === 'review' || stepType === 'recheck' || stepType === 'fix') return true
  // Conflict resolution is Claude-only until Codex conflict resolution exists.
  return vendor === 'claude'
}

function resolveLimitFallbackVendor(failedVendor: Vendor, stepType: string, config: Config): Vendor | null {
  const fallback: Vendor = failedVendor === 'claude' ? 'codex' : 'claude'
  return config.vendors[fallback].enabled && supportsStep(fallback, stepType) ? fallback : null
}

// Extends resolveReviewer with a human-origin fallback for the fix step.
// Scoped to reviewer: 'origin' only — other reviewer types (claude, codex, auto)
// already encode explicit vendor intent and need no fallback.
// When origin is 'human' and no vendor resolved, honours routing.fallback_reviewer
// so the fix step respects the same routing intent as the review step.
// 'auto' mirrors resolveReviewer's auto path (config-enabled check, codex-first)
// without async auth calls. null disables the fallback entirely.
// Exported so callers can detect when the fallback was applied (e.g. for logging).
export function resolveFixVendor(
  stepReviewer: string,
  origin: PROrigin,
  config: Config,
  fallback?: 'claude' | 'codex',
): { vendor: 'claude' | 'codex' | null; usedHumanFallback: boolean } {
  const vendor = resolveReviewer(stepReviewer, origin, config, fallback)
  if (vendor !== null || origin !== 'human' || stepReviewer !== 'origin') {
    return { vendor, usedHumanFallback: false }
  }
  const fb = config.routing.fallback_reviewer
  let humanFallback: 'claude' | 'codex' | null = null
  if (fb === 'claude') humanFallback = config.vendors.claude.enabled ? 'claude' : null
  else if (fb === 'codex') humanFallback = config.vendors.codex.enabled ? 'codex' : null
  else if (fb !== null) {
    // 'auto': prefer codex then claude, same as resolveReviewer's auto path
    humanFallback = config.vendors.codex.enabled ? 'codex' : config.vendors.claude.enabled ? 'claude' : null
  }
  if (!humanFallback) return { vendor: null, usedHumanFallback: false }
  return { vendor: humanFallback, usedHumanFallback: true }
}

// ─── pr_complexity helpers ────────────────────────────────────────────────────

const EXT_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'typescript', js: 'javascript', jsx: 'javascript',
  mjs: 'javascript', cjs: 'javascript', py: 'python', go: 'go', java: 'java',
  rb: 'ruby', rs: 'rust', cs: 'csharp', cpp: 'cpp', cc: 'cpp', php: 'php',
  kt: 'kotlin', swift: 'swift',
}

function classifyFile(filePath: string): string {
  const lower = filePath.toLowerCase()
  const ext = lower.split('.').pop() ?? ''
  if (/\.(test|spec)\.[jt]sx?$/.test(lower) || /(\/__tests__\/|\/test\/|\/spec\/)/.test(lower)) return 'test'
  if (/\.(md|mdx|rst|txt)$/.test(lower)) return 'docs'
  if (/^(dockerfile|tf|hcl)$/.test(ext) || lower === 'dockerfile' || /\/(\.github|infra|k8s|docker|ci\/)/.test(lower)) return 'infra'
  if (/\.(css|scss|sass|less|html|svelte|vue)$/.test(lower) || /\.(tsx|jsx)$/.test(lower)) return 'frontend'
  if (/\/(components|pages|views|ui|client|browser|public|assets|styles)/.test(lower)) return 'frontend'
  if (/^(json|yml|yaml|toml|ini|cfg|env|lock)$/.test(ext)) return 'config'
  if (['ts', 'js', 'mjs', 'cjs', 'py', 'go', 'java', 'rb', 'rs', 'cs', 'cpp', 'cc', 'php', 'kt', 'swift'].includes(ext)) return 'backend'
  return 'other'
}

function diffBucket(totalLines: number): string {
  if (totalLines < 50) return 'tiny'
  if (totalLines < 200) return 'small'
  if (totalLines < 500) return 'medium'
  if (totalLines < 2000) return 'large'
  return 'xlarge'
}

function emitPRComplexity(ctx: WorkflowContext, triggerField: Record<string, unknown>): void {
  const { owner, repoName, prNumber, tmpDir, pr, config } = ctx
  try {
    const raw = execSync(
      `git diff --stat origin/${pr.base.ref}...HEAD`,
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    if (!raw) return

    const lines = raw.split('\n')
    const summary = lines[lines.length - 1]
    const filesChanged = parseInt(summary.match(/(\d+) files? changed/)?.[1] ?? '0')
    const insertions = parseInt(summary.match(/(\d+) insertion/)?.[1] ?? '0')
    const deletions = parseInt(summary.match(/(\d+) deletion/)?.[1] ?? '0')

    const filePaths = lines.slice(0, -1).map(l => l.trim().split('|')[0]?.trim()).filter(Boolean) as string[]
    const mix: Record<string, number> = { backend: 0, frontend: 0, test: 0, infra: 0, docs: 0, config: 0, other: 0 }
    const langSet = new Set<string>()
    for (const fp of filePaths) {
      const ext = fp.split('.').pop()?.toLowerCase() ?? ''
      if (EXT_LANG[ext]) langSet.add(EXT_LANG[ext])
      const cat = classifyFile(fp)
      mix[cat] = (mix[cat] ?? 0) + 1
    }

    fileLog({
      level: 'info',
      event: 'pr_complexity',
      repo: `${owner}/${repoName}`,
      pr: prNumber,
      files_changed: filesChanged,
      insertions,
      deletions,
      diff_bucket: diffBucket(insertions + deletions),
      file_mix: mix,
      languages: [...langSet],
      quality_tier: config.quality.tier,
      ...triggerField,
    })
  } catch { /* best-effort — never fail the workflow for a logging event */ }
}

// ─────────────────────────────────────────────────────────────────────────────

// Detect non-fast-forward git push errors that indicate upstream commits
function isNonFastForwardError(message: string): boolean {
  return /rejected.*fetch first|updates were rejected.*remote contains work|non-fast-forward/i.test(message)
}

// Push with handling for non-fast-forward rejection. When the remote has new
// commits, we fetch + rebase onto the PR branch and retry the push once.
async function pushWithNonFastForwardHandling(params: {
  tmpDir: string
  branch: string
  token: string
  log: (msg: string) => void
  fileLog: (entry: Record<string, unknown>) => void
  owner: string
  repoName: string
  prNumber: number
}): Promise<void> {
  const { tmpDir, branch, token, log, fileLog, owner, repoName, prNumber } = params
  const env = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token }
  
  try {
    execSync(`git push origin HEAD:${branch}`, { cwd: tmpDir, env })
  } catch (pushErr: unknown) {
    const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr)
    
    if (isNonFastForwardError(pushMsg)) {
      // Non-fast-forward rejection — fetch latest and rebase
      fileLog({
        level: 'warn',
        event: 'push_non_fast_forward',
        repo: `${owner}/${repoName}`,
        pr: prNumber,
        branch,
      })
      log(chalk.yellow(`⚠  push rejected (non-fast-forward) — fetching latest and rebasing...`))
      
      try {
        // Fetch the latest state of the branch
        execSync(`git fetch origin ${branch}`, { cwd: tmpDir, env, stdio: 'pipe' })
        // Rebase our changes onto the latest branch state
        execSync(`git rebase origin/${branch}`, { cwd: tmpDir, env, stdio: 'pipe' })
        // Retry the push
        execSync(`git push origin HEAD:${branch}`, { cwd: tmpDir, env })
        fileLog({
          level: 'info',
          event: 'push_rebase_succeeded',
          repo: `${owner}/${repoName}`,
          pr: prNumber,
          branch,
        })
        return
      } catch (rebaseErr: unknown) {
        // Rebase failed — log and re-throw the original error
        const rebaseMsg = rebaseErr instanceof Error ? rebaseErr.message : String(rebaseErr)
        fileLog({
          level: 'error',
          event: 'push_rebase_failed',
          repo: `${owner}/${repoName}`,
          pr: prNumber,
          branch,
          error: rebaseMsg.slice(0, 500),
        })
        log(chalk.red(`✗  rebase failed: ${rebaseMsg.slice(0, 100)}`))
      }
    }
    
    // Re-throw original error
    throw pushErr
  }
}

// ─────────────────────────────────────────────────────────────────────────────

export async function runWorkflow(ctx: WorkflowContext): Promise<WorkflowResult> {
  const { owner, repoName, prNumber, pr, tmpDir, token, config, origin, log, onPhaseChange, trigger } = ctx
  const triggerField = trigger !== undefined ? { trigger } : {}
  const steps = (ctx.steps ?? loadWorkflow(process.cwd())).map(step => {
    if (!step.harness || step.instructions) return step
    const resolved = loadHarnessSection(step.harness, process.cwd())
    return resolved ? { ...step, instructions: resolved } : step
  })
  const results: Record<string, StepResult> = {}
  // SHAs the workflow pushed AND set a `crosscheck/review` pending status on.
  // Each one must be released in the finally below — otherwise the pending
  // status would stay forever on GitHub (the 15-min staleness check is
  // internal to crosscheck's lock detection and does not clear the status,
  // which can block PRs in repos where `crosscheck/review` is required).
  //
  // Use the caller's array if provided so the command-layer signal handler
  // can iterate the same list and release these shas if SIGINT/SIGTERM fires
  // mid-workflow (process.exit there bypasses our finally below).
  const pushedShasNeedingRelease: string[] = ctx.pushedShas ?? []
  let workflowFailed = false
  let workflowError: unknown = undefined
  let failedStep: string | undefined = undefined
  // When a fix commits and a structural review/recheck step follows, we acquire
  // the remote lock on the pushed SHA. Track it here so the finally can detect
  // whether the recheck was actually skipped (by `when`, no_reviewer, etc.) and
  // release the SHA as `failure` rather than `success` in that case.
  let fixPushedShaRequiresRecheck: string | null = null
  let lastFixSkipReason: string | undefined
  // A `recheck` step re-evaluates code that changed since the review it follows.
  // Running one in the same session as that review, with no fix in between, just
  // re-reviews the identical SHA and posts a duplicate verdict.
  //
  // The step's usual `when: "fix.applied_count > 0"` guard is not enough on its
  // own: in a fix-less depth (e.g. the per-repo `review,recheck` override) it
  // references a step that isn't in the workflow, and evaluateWhen fails open on
  // missing results, so the guard passes and the recheck runs. Recheck-as-resume
  // is unaffected — those sessions start at the recheck step, with no review
  // before it in the same run.
  let reviewRanThisSession = false

  // workflow_complete event accumulators. Each step the runner dispatches is
  // recorded in stepsRun (including ones that get logged as step_skipped —
  // the event records the workflow's declared shape, the per-step skip
  // reasons live in their own step_skipped log entries).
  const workflowId = randomUUID()
  const workflowStart = Date.now()
  const stepsRun: string[] = []
  let currentStepName: string | undefined

  emitPRComplexity(ctx, triggerField)

  try {
  for (const step of steps) {
    currentStepName = step.name
    stepsRun.push(step.name)
    const effectiveType = getEffectiveStepType(step.type, ctx.isRecheckRun === true)

    if (exceedsMaxRounds(effectiveType, step.type, ctx.overrideMaxRounds ?? step.max_rounds, ctx.round)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'max_rounds' })
      results[step.name] = { skipped: true }
      if (effectiveType === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (effectiveType === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      else if (effectiveType === 'conflict-resolve') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      continue
    }

    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'when_condition' })
      results[step.name] = { skipped: true }
      if (effectiveType === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (effectiveType === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      else if (effectiveType === 'conflict-resolve') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      continue
    }

    // Nothing has changed since the review earlier in this same session, so there
    // is nothing to recheck. Checks the declared type, not effectiveType, so a
    // review coerced to a recheck (isRecheckRun) is never blocked here.
    if (step.type === 'recheck' && reviewRanThisSession && !anyFixApplied(results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_change_since_review' })
      results[step.name] = { skipped: true }
      onPhaseChange('', { phase: 'rechecked' })
      continue
    }

    if (effectiveType === 'review' || effectiveType === 'recheck') {
      const isRecheck = effectiveType === 'recheck'
      let reviewer = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!reviewer) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_reviewer' })
        results[step.name] = { skipped: true }
        continue
      }

      // The recheck step is confirmed to run — clear the pending-recheck guard
      // so the finally doesn't release the fix-pushed SHA as failure.
      fixPushedShaRequiresRecheck = null
      reviewRanThisSession = true
      const stepIdentity = buildStepIdentityFields(effectiveType, step.name)
      fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, ...(ctx.round !== undefined && { round: ctx.round }), ...(ctx.roundMode && { mode: ctx.roundMode }) })

      const startPhase: PRPhase = isRecheck ? 'rechecking' : 'reviewing'
      const donePhase: PRPhase = isRecheck ? 'rechecked' : 'reviewed'
      onPhaseChange(`${reviewer} ${isRecheck ? 'rechecking' : 'reviewing'}...`, { phase: startPhase })
      // Per-step start timestamp. The shared ctx.reviewStart is set once at
      // workflow start and never reset, so a recheck's duration_ms would
      // otherwise include the prior review and fix wall time.
      const stepStart = Date.now()
      let rawReview = ''
      let tokensUsed: number | undefined
      let inputTokens: number | undefined
      let outputTokens: number | undefined
      let model = 'default'
      let retried: { timeoutMs: number; delayMs: number } | undefined
      const runReviewWithVendor = async (candidate: Vendor): Promise<void> => {
        if (candidate === 'codex') {
          ;({ review: rawReview, tokensUsed, model, retried } = await runCodexReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.codex, step.instructions, undefined, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.codex.timeout_sec), log))
          inputTokens = undefined
          outputTokens = undefined
        } else {
          ;({ review: rawReview, tokensUsed, inputTokens, outputTokens, model, retried } = await runClaudeReview(tmpDir, pr.base.ref, pr.title, config.quality, config.vendors.claude, config.budget.per_review_usd, step.instructions, undefined, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec), !!ctx.roundMode, log))
        }
      }

      try {
        await runReviewWithVendor(reviewer)
      } catch (err: unknown) {
        const isReconnect = err instanceof Error && /reconnect/i.test(err.message)
        if (isReconnect) {
          fileLog({ level: 'warn', event: 'review_reconnect_retry', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity })
          log(chalk.yellow(`⚠  codex connection dropped — retrying in 30s...`))
          await new Promise<void>(r => setTimeout(r, 30_000))
          await runReviewWithVendor(reviewer)
        } else {
          let fallbackErr: unknown = err
          if (isTransientApiError(err)) {
            fileLog({ level: 'warn', event: 'review_transient_retry', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity })
            log(chalk.yellow(`⚠  transient API error — retrying ${effectiveType} step in 2 min...`))
            onPhaseChange('retry in 2 min...', { phase: startPhase })
            await new Promise<void>(resolve => setTimeout(resolve, REVIEW_RETRY_DELAY_MS))
            onPhaseChange(`${reviewer} ${isRecheck ? 'rechecking' : 'reviewing'} (retry)...`, { phase: startPhase })
            try {
              await runReviewWithVendor(reviewer)
              fallbackErr = null
            } catch (retryErr: unknown) {
              fallbackErr = retryErr
            }
          }

          if (fallbackErr !== null) {
            if (!isSubscriptionLimitError(fallbackErr) && !isVendorUnavailableError(fallbackErr)) throw fallbackErr

            const failedVendor = reviewer
            const fallbackVendor = resolveLimitFallbackVendor(failedVendor, effectiveType, config)
            const reason = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr)
            ctx.onVendorLimit?.(failedVendor, fallbackVendor, reason, step.name)

            if (!fallbackVendor) throw fallbackErr

            fileLog({
              level: 'warn',
              event: 'vendor_fallback',
              repo: `${owner}/${repoName}`,
              pr: prNumber,
              step: step.name,
              step_type: effectiveType,
              failed_vendor: failedVendor,
              fallback_vendor: fallbackVendor,
              reason: reason.slice(0, 300),
            })
            log(chalk.yellow(`⚠  ${failedVendor} ${isSubscriptionLimitError(fallbackErr) ? 'hit a usage limit' : 'is unavailable'} — switching ${effectiveType} step to ${fallbackVendor}`))
            reviewer = fallbackVendor
            onPhaseChange(`${reviewer} ${isRecheck ? 'rechecking' : 'reviewing'}...`, { phase: startPhase })
            await runReviewWithVendor(reviewer)
          }
        }
      }

      // First attempt timed out but the delayed retry succeeded — surface a
      // soft notice on the review comment so the author knows it was a transient blip.
      if (retried) {
        fileLog({ level: 'info', event: 'review_retried', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, retry_timeout_sec: Math.round(retried.timeoutMs / 1000), retry_delay_sec: Math.round(retried.delayMs / 1000), ...(ctx.round !== undefined && { round: ctx.round }), ...triggerField })
      }

      const parsed = parseVerdict(rawReview)
      const { clean } = parsed
      if (parsed.verdict === null) {
        fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, output_length: rawReview.length })
      }
      // Severity gate: NEEDS WORK with only P3 nits is downgraded to APPROVE so
      // suggestion-only reviews don't drive the fix/recheck loop. P2 (correctness)
      // and above keep NEEDS WORK and require human attention before merge.
      const gate = applySeverityGate(parsed.verdict, clean)
      const verdict = gate.verdict
      if (gate.downgraded) {
        fileLog({ level: 'info', event: 'verdict_severity_gated', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, raw_verdict: parsed.verdict, gated_verdict: verdict })
      }
      const baseBody = verdict === null
        ? `${NULL_VERDICT_WARNING}\n\n${clean}`
        : prependVerdictToComment(gate.downgraded ? `${SEVERITY_GATE_NOTE}\n\n${clean}` : clean, verdict)
      const commentBody = retried
        ? `${buildRetriedReviewBanner(retried.timeoutMs, retried.delayMs)}\n\n${baseBody}`
        : baseBody
      const commentCount = countComments(rawReview)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, model, ...stepIdentity, verdict, duration_ms: Date.now() - stepStart, tokens_used: tokensUsed, ...(inputTokens !== undefined && { input_tokens: inputTokens }), ...(outputTokens !== undefined && { output_tokens: outputTokens }), ...(ctx.round !== undefined && { round: ctx.round }), ...(ctx.roundMode && { mode: ctx.roundMode }), ...triggerField })

      // Recheck verdict is stored separately to preserve the original review's commentCount on the board
      const phaseUpdate: PRPhaseData = isRecheck
        ? { recheckVerdict: verdict, phase: donePhase, recheckTokens: tokensUsed, recheckReviewer: reviewer, qualityTier: config.quality.tier }
        : { verdict, commentCount, phase: donePhase, crTokens: tokensUsed, crReviewer: reviewer, qualityTier: config.quality.tier }

      if (ctx.dryRun) {
        onPhaseChange('dry-run — comment not posted', phaseUpdate)
        log(chalk.dim(`\n--- dry-run: comment that would be posted ---\n${commentBody}\n--- end ---`))
        results[step.name] = { verdict, commentBody, tokens_used: tokensUsed, input_tokens: inputTokens, output_tokens: outputTokens, vendor: reviewer, model }
      } else {
        onPhaseChange(isRecheck ? 'posting recheck...' : 'posting comment...', phaseUpdate)
        const octokit = createGithubClient(token)
        // For rechecks: look up the original review comment ID so the recheck
        // can link back to it. Check in-run results first (single-run pipelines),
        // then fall back to GitHub (cross-run: recheck triggered by a new push).
        let priorReviewId: number | undefined
        if (isRecheck) {
          priorReviewId = Object.values(results).reverse().find(r => r.commentId !== undefined)?.commentId
          if (priorReviewId === undefined) {
            priorReviewId = await getLastCrossCheckCommentId(owner, repoName, prNumber, token)
          }
        }
        // Pre-compute next_step for the annotation so readers can skip full
        // comment scans: find the first remaining step whose when-condition holds.
        const currentStepIdx = steps.indexOf(step)
        const syntheticResultsForNext: Record<string, import('./workflow.js').StepResult> = {
          review: { verdict }, [step.name]: { verdict },
        }
        const nextWorkflowStep = steps.slice(currentStepIdx + 1).find(s =>
          !s.when || evaluateWhen(s.when, syntheticResultsForNext),
        )
        const nextStepAnnotation = nextWorkflowStep?.type ?? 'none'

        // Read the actual HEAD from the checkout: after an in-run fix step pushes a
        // new commit, pr.head.sha is still the pre-fix SHA and would make the recheck
        // annotation look stale to the step detector on the next run.
        let annotationSha = pr.head.sha
        try {
          annotationSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        } catch { /* fall back to pr.head.sha if git is unavailable */ }

        const commentId = await postReviewComment(
          octokit, owner, repoName, prNumber, commentBody, reviewer, config.brand,
          origin, verdict ?? undefined, priorReviewId, isRecheck, model, effectiveType, ctx.round ?? 1, annotationSha,
          nextStepAnnotation,
          ctx.trigger === 'kickass' ? 'kickass' : undefined,
        )
        const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
        fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })
        results[step.name] = { verdict, commentBody, commentUrl, commentId, tokens_used: tokensUsed, input_tokens: inputTokens, output_tokens: outputTokens, vendor: reviewer, model }
      }

    } else if (effectiveType === 'fix') {
      const skipFix = (reason: string) => {
        lastFixSkipReason = reason
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true }
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason })
      }

      if (ctx.dryRun) { skipFix('dry_run'); continue }

      // Migration gate: honor legacy opt-out fields while users migrate to workflow.yml.
      const legacyDisabled = config.post_review.auto_fix.enabled === false
        || config.post_review.auto_fix.trigger === 'never'
      if (legacyDisabled) {
        log(chalk.yellow(`⚠  auto_fix.enabled/trigger are deprecated — remove them from config and add a "when:" condition to the fix step in workflow.yml instead`))
        skipFix('legacy_auto_fix_disabled')
        continue
      }

      // Find the most recent review result that has a comment body. A fix-only
      // invocation (used by kickass) has no in-memory review result, so seed it
      // from the latest fresh crosscheck review comment on GitHub.
      const reviewResult = Object.values(results).reverse().find(r => r.commentBody)
      let reviewCommentBody = reviewResult?.commentBody
      let reviewCommentId = reviewResult?.commentId
      if (!reviewCommentBody) {
        reviewCommentBody = ctx.initialReviewComment?.body
        reviewCommentId = ctx.initialReviewComment?.id
      }
      if (!reviewCommentBody) {
        try {
          const latestReviewComment = await getLastCrossCheckReviewComment(owner, repoName, prNumber, token)
          reviewCommentBody = latestReviewComment?.body
          reviewCommentId = latestReviewComment?.id
        } catch (fetchErr) {
          fileLog({ level: 'warn', event: 'review_comment_fetch_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: fetchErr instanceof Error ? fetchErr.message : String(fetchErr) })
          throw fetchErr
        }
      }
      if (!reviewCommentBody) { skipFix('no_review_comment'); continue }

      // Vendor is resolved from the workflow step's reviewer field, same as review/recheck steps.
      // Use 'origin' to fix with the same vendor that authored the PR (recommended default).
      // resolveFixVendor extends resolveReviewer with a human-origin fallback so human-authored
      // PRs don't silently skip when no explicit vendor is configured.
      const { vendor, usedHumanFallback } = resolveFixVendor(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (usedHumanFallback && vendor) {
        fileLog({ level: 'info', event: 'fix_vendor_fallback', repo: `${owner}/${repoName}`, pr: prNumber, from: 'none', to: vendor, reason: 'human_origin' })
      }
      if (!vendor) { skipFix('no_vendor'); continue }

      const claudeFixModel = resolveClaudeModel(config.quality, config.vendors.claude)
      const codexFixModel = resolveCodexModel(config.quality, config.vendors.codex)

      // Guard: don't push more than MAX_CROSSCHECK_COMMITS per PR.
      // Scope to commits ahead of base so long-lived branches (e.g. staging)
      // don't count [crosscheck] commits from previously merged PRs.
      // Crazy/halfcrazy mode doubles the cap since it deliberately loops.
      const existingCount = countCrosscheckCommitsForPR(tmpDir, pr.base.ref)
      const effectiveCommitLimit = ctx.roundMode ? MAX_CROSSCHECK_COMMITS * 2 : MAX_CROSSCHECK_COMMITS

      if (existingCount >= effectiveCommitLimit) {
        log(chalk.yellow(`⚠  PR #${prNumber}: ${effectiveCommitLimit} [crosscheck] commits already — stopping auto-fix`))
        skipFix('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} fixing...`, { phase: 'fixing' })
      const fixStepStart = Date.now()
      let appliedCount = 0
      let fixChangedFiles: string[] = []
      let fixTokensUsed: number | undefined
      let fixErr: unknown = undefined
      let activeVendor = vendor

      const tierMs = tierTimeoutMs(config.quality.tier)
      const runFix = async (v: 'claude' | 'codex') => {
        if (v === 'codex') {
          return runCodexFixStep(
            tmpDir, pr.base.ref, pr.title, reviewCommentBody, step.instructions ?? '',
            codexFixModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.codex.timeout_sec) ?? tierMs,
          )
        }
        return runFixStep(
          tmpDir, pr.base.ref, pr.title, reviewCommentBody, step.instructions ?? '',
          config, claudeFixModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec) ?? tierMs,
        )
      }

      try {
        ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed } = await runFix(vendor))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 1, vendor }, err)
        const fallbackVendor = resolveLimitFallbackVendor(vendor, effectiveType, config)
        if (isSubscriptionLimitError(err)) {
          const reason = err instanceof Error ? err.message : String(err)
          ctx.onVendorLimit?.(vendor, fallbackVendor, reason, step.name)
        }
        if (fallbackVendor !== null && (isRetryableFixError(err) || isSubscriptionLimitError(err))) {
          log(chalk.yellow(`⚠  ${vendor} fix failed — falling back to ${fallbackVendor}...`))
          fileLog({ level: 'warn', event: 'fix_vendor_fallback', repo: `${owner}/${repoName}`, pr: prNumber, from: vendor, to: fallbackVendor, ...(isSubscriptionLimitError(err) && { reason: 'vendor_limit' }) })
          try {
            ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed } = await runFix(fallbackVendor))
            activeVendor = fallbackVendor
          } catch (fallbackErr) {
            logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 1, vendor: fallbackVendor }, fallbackErr)
            activeVendor = fallbackVendor  // retry uses the fallback vendor since primary already failed
            fixErr = fallbackErr
          }
        } else {
          fixErr = err
        }
      }

      if (fixErr !== undefined && isRetryableFixError(fixErr)) {
        log(chalk.yellow(`⚠  fix step failed — retrying in 2 min...`))
        onPhaseChange('fix retry in 2 min...', { phase: 'fixing' })
        fileLog({ level: 'info', event: 'fix_retry_scheduled', repo: `${owner}/${repoName}`, pr: prNumber })
        await new Promise<void>(resolve => setTimeout(resolve, FIX_RETRY_DELAY_MS))
        onPhaseChange(`${activeVendor} fixing (retry)...`, { phase: 'fixing' })
        try {
          ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed } = await runFix(activeVendor))
          fileLog({ level: 'info', event: 'fix_retry_succeeded', repo: `${owner}/${repoName}`, pr: prNumber })
          fixErr = undefined
        } catch (retryErr) {
          logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 2 }, retryErr)
          fixErr = retryErr
        }
      }

      if (fixErr !== undefined) {
        skipFix(isSubscriptionLimitError(fixErr) ? 'vendor_limit' : 'fix_error')
        // Only notify for transient failures — auth errors are operator issues, not PR author issues
        if (isRetryableFixError(fixErr)) {
          try {
            const octokit = createGithubClient(token)
            await octokit.rest.issues.createComment({
              owner, repo: repoName, issue_number: prNumber,
              body: `⚠️ **Auto-fix failed**\n\nThe fix step timed out after retrying. Push a new commit or run \`crosscheck run ${pr.html_url}\` to retry manually.\n\n<!-- crosscheck: fix_failed -->`,
            })
            fileLog({ level: 'info', event: 'fix_failed_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber })
          } catch { /* best-effort notification */ }
        }
        // The review was already posted — treat fix failure as a skipped step so the
        // workflow completes with the review's verdict rather than exiting non-zero and
        // releasing the remote lock as a workflow failure.
        continue
      }

      if (appliedCount === 0) {
        onPhaseChange('', { phase: 'fixed', fixCount: 0, fixTokens: fixTokensUsed })
        // Log the zero-change outcome explicitly: without this, a fix that ran but
        // applied nothing leaves no event at all, so the log/`diagnose` can't tell
        // "fix ran, changed nothing" from "fix never ran". Use a distinct `fix_noop`
        // event — NOT `fix_complete` — so status consumers (WORKFLOW_ACTIVITY_EVENTS,
        // the legacy status fold) don't misread a no-op as real workflow progress and
        // mark the PR NEEDS_RECHECK or hide it from `scan --tidy` with no fix applied.
        fileLog({ level: 'info', event: 'fix_noop', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: 0, no_changes: true, tokens_used: fixTokensUsed, duration_ms: Date.now() - fixStepStart, ...triggerField })
        results[step.name] = { applied_count: 0, ...(fixTokensUsed !== undefined && { tokens_used: fixTokensUsed }), vendor }
        continue
      }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { skipFix('fork_pr'); continue }

      const deliveryMode = config.post_review.auto_fix.delivery.mode

      if (deliveryMode === 'commit') {
        const fixModel = activeVendor === 'codex' ? codexFixModel : claudeFixModel
        execSync('git add -A', { cwd: tmpDir })
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            `[crosscheck] fix: apply ${appliedCount} fix${appliedCount !== 1 ? 'es' : ''} from code review — by Claude Code`,
            '-m',
            buildCommitTrailers({ reviewer: activeVendor, model: fixModel, step: 'fix', service: 'crosscheck' }),
          ],
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        await pushWithNonFastForwardHandling({
          tmpDir,
          branch: pr.head.ref,
          token,
          log,
          fileLog: (entry) => fileLog({ ...entry, phase: 'fix' } as any),
          owner,
          repoName,
          prNumber,
        })
        ctx.crosscheckShas.add(newSha)
        // Set a pending status on the pushed commit only when a review/recheck
        // step follows in THIS workflow invocation — that step will release it.
        // Fix-only runs (kickass `--steps fix`) must NOT acquire the lock here:
        // doing so leaves a PENDING status that the separately-dispatched recheck
        // (`--steps recheck`) sees as "in-progress" via checkRemoteLock and skips,
        // permanently orphaning the PENDING status.
        const currentStepIdx = steps.indexOf(step)
        const hasRecheckAfterFix = steps.slice(currentStepIdx + 1).some(s => s.type === 'review' || s.type === 'recheck')
        if (hasRecheckAfterFix) {
          try {
            const lockOctokit = createGithubClient(token)
            await acquireRemoteLock(lockOctokit, owner, repoName, newSha)
            pushedShasNeedingRelease.push(newSha)
            fixPushedShaRequiresRecheck = newSha
          } catch (err) {
            fileLog({ level: 'warn', event: 'remote_lock_refresh_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha, error: err instanceof Error ? err.message : String(err) })
          }
        }
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'commit', tokens_used: fixTokensUsed, duration_ms: Date.now() - fixStepStart, ...triggerField })

        // Post a summary comment so the silent commit push is visible on the timeline
        // as a comment card. Best-effort — a failure here must not fail the run.
        try {
          const octokit = createGithubClient(token)
          const body = buildFixAppliedCommentBody({
            owner, repo: repoName, sha: newSha, appliedCount,
            reviewCommentId,
            changedFiles: fixChangedFiles,
            vendor: activeVendor,
            reviewCommentBody,
          })
          await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
          fileLog({ level: 'info', event: 'fix_applied_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha })
        } catch (err) {
          fileLog({ level: 'warn', event: 'fix_applied_comment_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: err instanceof Error ? err.message : String(err) })
        }

        results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }

      } else if (deliveryMode === 'pull_request') {
        const fixModel = activeVendor === 'codex' ? codexFixModel : claudeFixModel
        // Create a fix branch and open a PR targeting the original branch
        const fixBranch = `fix/cr-${prNumber}-review-issues`
        execSync(`git checkout -b ${fixBranch}`, { cwd: tmpDir })
        execSync('git add -A', { cwd: tmpDir })
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            `[crosscheck] fix: apply CR fixes from review of PR #${prNumber} — by Claude Code`,
            '-m',
            buildCommitTrailers({ reviewer: activeVendor, model: fixModel, step: 'fix', service: 'crosscheck' }),
          ],
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
        execSync(`git push origin HEAD:${fixBranch}`, {
          cwd: tmpDir,
          env: { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token },
        })
        ctx.crosscheckShas.add(newSha)

        const octokit = createGithubClient(token)
        const fixPrTitle = config.post_review.auto_fix.delivery.pr_title.replace('#{original_pr_title}', pr.title)
        const { data: fixPr } = await octokit.rest.pulls.create({
          owner,
          repo: repoName,
          head: fixBranch,
          base: pr.head.ref,
          title: fixPrTitle,
          body: `Auto-fix by crosscheck for CR issues found in #${prNumber}.\n\nReview: https://github.com/${owner}/${repoName}/pull/${prNumber}`,
        })
        if (config.post_review.auto_fix.delivery.label) {
          try {
            await octokit.rest.issues.addLabels({
              owner, repo: repoName, issue_number: fixPr.number, labels: [config.post_review.auto_fix.delivery.label],
            })
          } catch { /* label may not exist in this repo — skip */ }
        }
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'pull_request', fix_pr: fixPr.number, tokens_used: fixTokensUsed, duration_ms: Date.now() - fixStepStart, ...triggerField })
        results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }

      } else {
        // comment: post the diff as a suggested-fix comment, no code push needed (works for fork PRs too)
        let patch = ''
        try { patch = execSync('git diff', { cwd: tmpDir, encoding: 'utf8' }) } catch { /* ignore */ }
        if (patch) {
          const octokit = createGithubClient(token)
          const body = `### Suggested fixes (crosscheck auto-fix)\n\n\`\`\`diff\n${patch.slice(0, 16000)}\n\`\`\``
          await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
        }
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, delivery: 'comment', tokens_used: fixTokensUsed, duration_ms: Date.now() - fixStepStart, ...triggerField })
        results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }
      }

    } else if (effectiveType === 'conflict-resolve') {
      const skipConflictResolve = (reason: string) => {
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true }
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason })
      }

      if (ctx.dryRun) { skipConflictResolve('dry_run'); continue }

      // Fast pre-check: GitHub's mergeable field tells us if the PR has conflicts without
      // cloning. true = no conflicts (skip immediately); false = conflicts confirmed (proceed);
      // null = GitHub is still computing — fall through to the git merge probe.
      {
        const octokit = createGithubClient(token)
        const { data: prInfo } = await octokit.rest.pulls.get({ owner, repo: repoName, pull_number: prNumber })
        if (prInfo.mergeable === true) {
          skipConflictResolve('no_conflicts')
          continue
        }
      }

      // P1: The clone only has the PR head checked out — no unmerged index entries exist
      // until we actually attempt the merge. Attempt the merge first; if it succeeds
      // cleanly (no conflicts) abort it and skip. If it fails, the working tree now has
      // real conflict markers and UU entries that findConflictedFiles can detect.
      let hasMergeConflicts = false
      try {
        execSync(`git merge --no-commit origin/${pr.base.ref}`, { cwd: tmpDir, stdio: 'pipe' })
        // Clean merge — undo the staged merge state and skip this step
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
      } catch {
        hasMergeConflicts = true
      }

      if (!hasMergeConflicts) {
        skipConflictResolve('no_conflicts')
        continue
      }

      const conflictedFiles = findConflictedFiles(tmpDir)
      if (conflictedFiles.length === 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        skipConflictResolve('no_conflicts')
        continue
      }

      const vendor = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!vendor) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('no_vendor'); continue }
      if (vendor === 'codex') { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('codex_conflict_resolve_unsupported'); continue }
      const conflictResolveModel = resolveClaudeModel(config.quality, config.vendors.claude)

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('fork_pr'); continue }

      const existingCount = countCrosscheckCommitsForPR(tmpDir, pr.base.ref)
      if (existingCount >= MAX_CROSSCHECK_COMMITS) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping conflict-resolve`))
        skipConflictResolve('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} resolving conflicts...`, { phase: 'fixing' })
      // Per-step start timestamp for conflict-resolve wall time.
      const conflictResolveStepStart = Date.now()
      let appliedCount = 0
      let resolvedPaths: string[] = []
      let resolveTokensUsed: number | undefined

      try {
        ;({ appliedCount, resolvedPaths, tokensUsed: resolveTokensUsed } = await runConflictResolveStep(
          tmpDir, pr.title, step.instructions ?? '', conflictResolveModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec),
        ))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'conflict-resolve', attempt: 1 }, err)
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        skipConflictResolve(isSubscriptionLimitError(err) ? 'vendor_limit' : 'resolve_error')
        continue
      }

      if (appliedCount === 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        onPhaseChange('', { phase: 'fixed', fixCount: 0, fixTokens: resolveTokensUsed })
        results[step.name] = { applied_count: 0, ...(resolveTokensUsed !== undefined && { tokens_used: resolveTokensUsed }), vendor }
        continue
      }

      // P2: Verify every conflict region was resolved before committing. Scope the
      // check to the union of (originally-conflicted files) ∪ (files the resolver
      // actually rewrote) — a repo-wide grep would false-positive on legitimate
      // "=======" lines in docs (e.g. Markdown setext headings) and abort valid
      // resolutions, but we still need to cover any path the resolver touched in
      // case it ever edits outside the original conflict set. Read working-tree
      // content directly so untrusted PR-controlled paths never reach a shell.
      const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)( |$)/m
      const pathsToScan = Array.from(new Set([...conflictedFiles, ...resolvedPaths]))
      const filesWithMarkers: string[] = []
      for (const f of pathsToScan) {
        try {
          const content = readFileSync(join(tmpDir, f), 'utf8')
          if (MARKER_RE.test(content)) filesWithMarkers.push(f)
        } catch { /* unreadable (deleted side of modify/delete) — caught by U-filter below */ }
      }
      if (filesWithMarkers.length > 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${filesWithMarkers.length} file(s) still contain conflict markers — skipping commit`))
        fileLog({ level: 'warn', event: 'conflict_resolve_incomplete', repo: `${owner}/${repoName}`, pr: prNumber, paths: filesWithMarkers })
        skipConflictResolve('incomplete_resolution')
        continue
      }

      // Stage only files the resolver actually rewrote — `git add -A` would
      // otherwise silently stage non-text conflicts (binary, modify/delete) using
      // the worktree side as an un-reviewed resolution. Staging also has to come
      // BEFORE the unmerged-path check below: git keeps a path in the unmerged
      // index until it is explicitly added, so checking earlier would always fail
      // on the resolved files themselves. Use execFileSync (no shell) because
      // resolvedPaths is derived from model output and PR-controlled filenames.
      for (const p of resolvedPaths) {
        try {
          execFileSync('git', ['add', '--', p], { cwd: tmpDir, stdio: 'pipe' })
        } catch { /* skip */ }
      }

      // After staging the resolved files, anything still in U state is a conflict
      // the resolver did not handle (binary, modify/delete, or a failed edit).
      // Abort rather than commit a partial merge.
      let unmergedPaths: string[] = []
      try {
        const out = execSync('git diff --name-only --diff-filter=U', { cwd: tmpDir, encoding: 'utf8' })
        unmergedPaths = out.trim().split('\n').filter(Boolean)
      } catch { /* ignore */ }
      if (unmergedPaths.length > 0) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(chalk.yellow(`⚠  PR #${prNumber}: ${unmergedPaths.length} unmerged path(s) remain after resolve — skipping commit`))
        fileLog({ level: 'warn', event: 'conflict_resolve_unmerged_paths', repo: `${owner}/${repoName}`, pr: prNumber, paths: unmergedPaths })
        skipConflictResolve('unmerged_paths')
        continue
      }

      execFileSync(
        'git',
        [
          'commit',
          '-m',
          `[crosscheck] resolve: resolve ${conflictedFiles.length} conflict${conflictedFiles.length !== 1 ? 's' : ''} — by Claude Code`,
          '-m',
          buildCommitTrailers({ reviewer: vendor, model: conflictResolveModel, step: 'conflict-resolve', service: 'crosscheck' }),
        ],
        { cwd: tmpDir },
      )
      const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()
      await pushWithNonFastForwardHandling({
        tmpDir,
        branch: pr.head.ref,
        token,
        log,
        fileLog: (entry) => fileLog({ ...entry, phase: 'conflict-resolve' } as any),
        owner,
        repoName,
        prNumber,
      })
      ctx.crosscheckShas.add(newSha)
      // Move the in-flight pending status to newSha so watchers on other
      // machines (which don't share crosscheckShas) see the PR as locked when
      // they receive the synchronize event and skip duplicate review.
      // Track the sha so the finally below releases the pending status —
      // without that release the status would stay pending forever on GitHub.
      try {
        const lockOctokit = createGithubClient(token)
        await acquireRemoteLock(lockOctokit, owner, repoName, newSha)
        pushedShasNeedingRelease.push(newSha)
      } catch (err) {
        fileLog({ level: 'warn', event: 'remote_lock_refresh_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha, error: err instanceof Error ? err.message : String(err) })
      }
      onPhaseChange('conflicts resolved ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: resolveTokensUsed })
      fileLog({ level: 'info', event: 'conflict_resolve_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor, conflicts_resolved: conflictedFiles.length, sha: newSha, tokens_used: resolveTokensUsed, duration_ms: Date.now() - conflictResolveStepStart, ...triggerField })

      // Post a summary comment so the silent merge-commit push is visible on the
      // timeline as a comment card. Best-effort — a failure here must not fail the run.
      // Prefer the resolver's actual rewrite set; fall back to the originally-conflicted
      // list if the resolver didn't surface paths.
      try {
        const octokit = createGithubClient(token)
        const body = buildConflictResolvedCommentBody({
          owner, repo: repoName, sha: newSha,
          conflictCount: conflictedFiles.length,
          files: resolvedPaths.length > 0 ? resolvedPaths : conflictedFiles,
        })
        await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
        fileLog({ level: 'info', event: 'conflict_resolved_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha })
      } catch (err) {
        fileLog({ level: 'warn', event: 'conflict_resolved_comment_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: err instanceof Error ? err.message : String(err) })
      }

      results[step.name] = { applied_count: appliedCount, ...(resolveTokensUsed !== undefined && { tokens_used: resolveTokensUsed }), vendor }
    }
  }

  const verdict = Object.values(results).reverse().find(r => r.verdict !== undefined)?.verdict ?? null
  const fixAppliedCount = Object.values(results).reduce<number | undefined>((acc, r) => {
    if (r.applied_count === undefined) return acc
    return (acc ?? 0) + r.applied_count
  }, undefined)
  const latestReviewResult = Object.values(results).reverse().find(r => r.commentBody !== undefined)
  return {
    verdict: verdict ?? null,
    fixAppliedCount,
    ...(fixAppliedCount === undefined && lastFixSkipReason !== undefined && { fixSkipReason: lastFixSkipReason }),
    ...(latestReviewResult?.commentBody && {
      latestReviewComment: {
        body: latestReviewResult.commentBody,
        ...(latestReviewResult.commentId !== undefined && { id: latestReviewResult.commentId }),
      },
    }),
  }
  } catch (err) {
    workflowFailed = true
    workflowError = err
    failedStep = currentStepName
    throw err
  } finally {
    if (pushedShasNeedingRelease.length > 0 || fixPushedShaRequiresRecheck !== null) {
      const lockOctokit = createGithubClient(token)
      const outcome: 'success' | 'failure' = workflowFailed ? 'failure' : 'success'

      // A recheck step was expected after the fix but was skipped (by `when`,
      // no_reviewer, max_rounds, etc.). The fix-pushed SHA is in
      // pushedShasNeedingRelease but no recheck ran to confirm the commit, so
      // releasing it as `success` would mislead branch protection. Release it
      // as `failure` instead so the commit remains unreviewed until the recheck
      // runs in a subsequent invocation (e.g. via `crosscheck run --steps recheck`).
      if (fixPushedShaRequiresRecheck !== null) {
        const unrecheckedSha = fixPushedShaRequiresRecheck
        fixPushedShaRequiresRecheck = null
        const idx = pushedShasNeedingRelease.indexOf(unrecheckedSha)
        if (idx !== -1) pushedShasNeedingRelease.splice(idx, 1)
        try {
          await releaseRemoteLock(lockOctokit, owner, repoName, unrecheckedSha, 'failure')
        } catch (err) {
          fileLog({ level: 'warn', event: 'pushed_sha_release_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: unrecheckedSha, error: err instanceof Error ? err.message : String(err) })
        }
      }

      // Drain via shift() so each released sha is synchronously removed from
      // the shared array. The command-layer SIGINT/SIGTERM handler iterates
      // the same array — if a late signal arrives after this finally has
      // already released a sha, the handler won't see it and won't overwrite
      // the released status with 'failure'. Atomic shift gives clean per-sha
      // ownership transfer even when both loops are draining concurrently.
      while (pushedShasNeedingRelease.length > 0) {
        const s = pushedShasNeedingRelease.shift()!
        try {
          await releaseRemoteLock(lockOctokit, owner, repoName, s, outcome)
        } catch (err) {
          fileLog({ level: 'warn', event: 'pushed_sha_release_failed', repo: `${owner}/${repoName}`, pr: prNumber, sha: s, error: err instanceof Error ? err.message : String(err) })
        }
      }
    }

    // workflow_complete fires exactly once per runWorkflow invocation, in the
    // finally so it lands on both happy-path returns AND on caught exceptions.
    // Closes the "no_followup vs crash" log ambiguity called out in
    // prd.md:1145 §B (the analysis of 411 review_complete events on
    // 2026-05-28 found 17.2% of initial reviews with no follow-up event —
    // indistinguishable from a session crash without this event).
    fileLog(buildWorkflowCompleteEvent({
      owner, repoName, prNumber,
      workflowId, workflowStart, stepsRun, results, workflowFailed,
      workflowError,
      failedStep,
      round: ctx.round,
      trigger: ctx.trigger,
      qualityTier: config.quality.tier,
    }) as Parameters<typeof fileLog>[0])
  }
}
