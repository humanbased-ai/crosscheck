import { execSync, execFileSync } from 'child_process'
import { randomUUID } from 'crypto'
import { readFileSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import type { Config, RepoWorkflowStep } from '../config/schema.js'
import { filterStepsByTypes } from './repo-workflow.js'
import type { PREvent } from '../github/webhook.js'
import type { PROrigin } from '../github/detector.js'
import { vendorDisplayName, type Vendor } from '../lib/vendor.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runFixStep, runCodexFixStep } from '../reviewers/fix.js'
import { runConflictResolveStep, findConflictedFiles } from '../reviewers/conflict-resolve.js'
import { parseVerdict, prependVerdictToComment, NULL_VERDICT_WARNING, applySeverityGate, SEVERITY_GATE_NOTE } from '../lib/verdict.js'
import { createGithubClient, postReviewComment, getLastCrossCheckCommentId, getLastCrossCheckReviewComment } from '../github/client.js'
import { autoFixBranchName, autoFixPRIntro, sourcePRHasMerged } from '../github/superseded-fix-pr.js'
import { verifyReviewedSha, isVerifiedReviewedSha, reviewedShaRejection } from '../github/reviewed-sha.js'
import { resolveLinearAuth, withWorker, type ResolvedLinearAuth } from '../linear/identity.js'
import { notifyLinear } from '../linear/notify.js'
import { shouldPostToLinear } from '../linear/comment.js'
import { getLinearCredentials } from '../config/loader.js'
import { acquireRemoteLock, releaseRemoteLock } from '../github/review-status.js'
import { log as fileLog, logError, classifyError } from '../lib/logger.js'
import { buildCommitTrailers } from '../lib/annotation.js'
import { resolveClaudeModel, resolveCodexModel } from '../lib/review-models.js'
import { resolveReviewStrategy, escalate, clampToLevels, type EscalationLane, type PRContext, type ResolvedStrategy } from './review-strategy.js'
import { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../config/schema.js'
import { buildStepIdentityFields, type StepIdentityFields } from '../lib/event-fields.js'
import { planAutoFixDelivery, forceWithLeaseArgs, parseLsRemoteOid, isLeaseRejection, assessFixBranchOwnership, isInvalidBaseError } from '../lib/auto-fix-branch.js'
import type { FixBranchPR } from '../lib/auto-fix-branch.js'
import { prOpenToVerdictMs } from '../lib/adoption.js'
import { buildAttributionFooter, buildFixAppliedCommentBody, buildFixFailedCommentBody, buildConflictResolvedCommentBody, buildRetriedReviewBanner } from '../lib/comment-bodies.js'
import { linearWritePossible, loadWorkflow, loadHarnessSection, evaluateWhen, type StepResult } from '../lib/workflow.js'
import type { PRPhase } from '../lib/board.js'
import { isSubscriptionLimitError, isVendorUnavailableError } from '../lib/smart-switch.js'
import { tierTimeoutMs } from '../reviewers/tier-timeouts.js'
import { loadSkillCatalog } from '../skills/catalog.js'
import { createSkillActivationSession, type SkillActivationSession } from '../skills/broker.js'
import { formatSkillAttribution } from '../skills/attribution.js'

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
export interface CrosscheckCommitCount {
  count: number
  /**
   * false when origin/<base> was unavailable and the count covers the whole
   * history rather than just this PR. Such a count is an upper bound, usually a
   * wild over-count, and must be reported as such rather than as a real limit hit.
   */
  scoped: boolean
}

export function countCrosscheckCommitsForPRDetailed(tmpDir: string, baseRef: string): CrosscheckCommitCount {
  const runLog = (args: string[]): string =>
    execFileSync(
      'git',
      ['log', '--oneline', ...args],
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    )
  const count = (out: string): number => out.split('\n').filter(l => l.includes('[crosscheck]')).length

  try {
    return { count: count(runLog([`origin/${baseRef}..HEAD`])), scoped: true }
  } catch {
    // Scoped range unavailable — fall back to full history so the cap still
    // applies. Over-counts when the branch has prior merged crosscheck commits,
    // but that's preferable to bypassing the safety guard.
    try {
      return { count: count(runLog([])), scoped: false }
    } catch {
      return { count: 0, scoped: false }
    }
  }
}

export function countCrosscheckCommitsForPR(tmpDir: string, baseRef: string): number {
  return countCrosscheckCommitsForPRDetailed(tmpDir, baseRef).count
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

export type FixDeliveryMode = 'pull_request' | 'commit' | 'comment'

// How a fix should be delivered once its edits are applied. Fork PRs are handled
// upstream (the fix step skips them with `fork_pr`), so by the time delivery runs
// the PR branch is one we can push to. Both `commit` and `pull_request` therefore
// land the fix directly on the PR's own branch — keeping the fix, recheck, and
// approval on the original PR. The ONLY difference: `pull_request` may fall back
// to opening a separate follow-up PR if that push can't succeed (e.g. the PR was
// merged and its branch deleted, or the branch is protected), whereas `commit`
// surfaces the push failure and `comment` never pushes at all.
//   'branch'                 → commit + push onto the PR branch; no fallback
//   'branch-then-separate-pr'→ same, but fall back to a follow-up PR on push failure
//   'comment'                → post the diff as a suggestion, no push
export type FixLanding = 'branch' | 'branch-then-separate-pr' | 'comment'
export function resolveFixLanding(deliveryMode: FixDeliveryMode): FixLanding {
  switch (deliveryMode) {
    case 'comment': return 'comment'
    case 'commit': return 'branch'
    case 'pull_request': return 'branch-then-separate-pr'
  }
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
  // Linear identity resolved once at the command-run boundary and reused across
  // every round, so a multi-round run mints exactly one token.
  linearAuth?: ResolvedLinearAuth | null
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
  // Linked tracker issue rendered as a prompt block (see issues/enrich.ts).
  // Injected into review/recheck prompts so the reviewer judges against the
  // stated goal; undefined when enrichment is off or the issue didn't resolve.
  issueContext?: string
  // Called when a vendor hits a quota/credit limit and the runner can identify
  // an immediate same-step fallback. Long-lived commands use this to activate
  // smart-switch without failing the current PR first.
  onVendorLimit?: (failedVendor: Vendor, fallbackVendor: Vendor | null, reason: string, stepName: string) => void
}

export interface WorkflowResult {
  verdict: string | null
  /** Set when the review strategy classified the PR as not worth reviewing
   *  (e.g. a lockfile-only change). Carries the matched class id. */
  strategySkipped?: string
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
  /** What each dispatched step actually did. Lets a caller tell "ran and found
   *  nothing" apart from "never ran", which the verdict alone cannot express —
   *  every step of a conflict-resolve run can skip and still leave verdict null,
   *  exactly like a review that approved nothing. */
  stepOutcomes?: StepOutcomes
}

export interface StepOutcomes {
  /** Steps that executed. A dispatched step with no recorded result counts as
   *  ran: only an explicit skip is evidence that nothing happened. */
  ran: string[]
  /** Steps dispatched but skipped, each with the reason recorded on its
   *  step_skipped log entry. */
  skipped: { step: string; reason: string }[]
}

// stepsRun holds every step the runner dispatched, skips included; results holds
// what each one did. Split them so callers can report a run where nothing
// happened without re-deriving the reasons from the log file.
export function summariseStepOutcomes(
  stepsRun: readonly string[],
  results: Record<string, StepResult>,
): StepOutcomes {
  const outcomes: StepOutcomes = { ran: [], skipped: [] }
  for (const name of new Set(stepsRun)) {
    const result = results[name]
    if (result?.skipped) outcomes.skipped.push({ step: name, reason: result.skipReason ?? 'unknown' })
    else outcomes.ran.push(name)
  }
  return outcomes
}

// Accumulates outcomes across the fix→recheck rounds of one invocation, so the
// completion line reports whether the run as a whole did work: a first round
// that skips everything followed by a round that applies a fix is not a
// "no step ran" run.
//
// Running once wins over skipping any number of times — the step demonstrably
// happened. A step skipped in several rounds is reported once, carrying its
// latest reason: that is the state the run ended in, and listing the same step
// several times reads as several distinct problems.
export function mergeStepOutcomes(
  base: StepOutcomes | undefined,
  next: StepOutcomes | undefined,
): StepOutcomes | undefined {
  if (!base) return next
  if (!next) return base
  const ran = [...new Set([...base.ran, ...next.ran])]
  const ranSet = new Set(ran)
  // Map.set on an existing key overwrites the reason but keeps the original
  // position, so order stays first-seen while the reason stays last-seen.
  const skipped = new Map<string, string>()
  for (const entry of [...base.skipped, ...next.skipped]) {
    if (!ranSet.has(entry.step)) skipped.set(entry.step, entry.reason)
  }
  return { ran, skipped: [...skipped].map(([step, reason]) => ({ step, reason })) }
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

// ─── commit subjects ──────────────────────────────────────────────────────────
// The vendor is a parameter, not a constant: the vendor that ran the step is
// known at every call site, and a subject crediting a different one contradicts
// the Crosscheck-Reviewer trailer on its own commit.
// The `[crosscheck]` prefix and the step word after it are parsed —
// countCrosscheckCommitsForPR greps the prefix to enforce the commit cap — so
// only the trailing attribution varies.

export function fixCommitSubject(appliedCount: number, vendor: Vendor): string {
  return `[crosscheck] fix: apply ${appliedCount} fix${appliedCount !== 1 ? 'es' : ''} from code review — by ${vendorDisplayName(vendor)}`
}

export function fixPRCommitSubject(prNumber: number, vendor: Vendor): string {
  return `[crosscheck] fix: apply CR fixes from review of PR #${prNumber} — by ${vendorDisplayName(vendor)}`
}

export function conflictResolveCommitSubject(conflictCount: number, vendor: Vendor): string {
  return `[crosscheck] resolve: resolve ${conflictCount} conflict${conflictCount !== 1 ? 's' : ''} — by ${vendorDisplayName(vendor)}`
}

// Extends resolveReviewer with a human-origin fallback for the steps that write
// code (fix, conflict-resolve).
// Scoped to reviewer: 'origin' only — other reviewer types (claude, codex, auto)
// already encode explicit vendor intent and need no fallback.
// When origin is 'human' and no vendor resolved, honours routing.fallback_reviewer
// so the step respects the same routing intent as the review step.
// 'auto' resolves against the vendors that can actually run stepType, so a step
// only one vendor supports doesn't fall back to the other and skip a line later.
// An explicit 'claude'/'codex' is an operator decision and is honoured as written
// even when that vendor cannot run the step — the caller then reports a precise
// unsupported-step skip instead of silently substituting a different vendor.
// null disables the fallback entirely.
function resolveStepVendor(
  stepType: string,
  stepReviewer: string,
  origin: PROrigin,
  config: Config,
  fallback?: 'claude' | 'codex',
): { vendor: 'claude' | 'codex' | null; usedHumanFallback: boolean; substitutedOriginVendor?: 'claude' | 'codex' } {
  const vendor = resolveReviewer(stepReviewer, origin, config, fallback)

  // Origin detection can assign a vendor that cannot run the step: conflict
  // resolution is Claude-only, so a Codex-origin PR (reviewer: 'origin', origin:
  // 'codex') resolves to 'codex' and the dispatch skips it as unsupported — the
  // conflicts never get resolved. (#284's `Crosscheck-Reviewer: codex` detection
  // introduced this: these crosscheck-authored fix PRs used to detect as 'human'
  // and the auto fallback picked Claude.) Substitute a capable, enabled vendor.
  // Scoped to origin-derived assignment only — an explicit reviewer: claude|codex,
  // reviewer: auto, or routing.fallback_reviewer is an operator decision, left as
  // written so the caller can report the precise unsupported-step skip.
  if (
    stepReviewer === 'origin' &&
    (origin === 'claude' || origin === 'codex') &&
    vendor !== null &&
    !supportsStep(vendor, stepType)
  ) {
    const capable: Vendor = vendor === 'claude' ? 'codex' : 'claude'
    if (config.vendors[capable].enabled && supportsStep(capable, stepType)) {
      return { vendor: capable, usedHumanFallback: false, substitutedOriginVendor: vendor }
    }
  }

  if (vendor !== null || origin !== 'human' || stepReviewer !== 'origin') {
    return { vendor, usedHumanFallback: false }
  }
  const fb = config.routing.fallback_reviewer
  let humanFallback: 'claude' | 'codex' | null = null
  if (fb === 'claude') humanFallback = config.vendors.claude.enabled ? 'claude' : null
  else if (fb === 'codex') humanFallback = config.vendors.codex.enabled ? 'codex' : null
  else if (fb !== null) {
    // 'auto': prefer codex then claude, same as resolveReviewer's auto path,
    // narrowed to vendors that support this step type.
    const usable = (v: Vendor): boolean => config.vendors[v].enabled && supportsStep(v, stepType)
    humanFallback = usable('codex') ? 'codex' : usable('claude') ? 'claude' : null
  }
  if (!humanFallback) return { vendor: null, usedHumanFallback: false }
  return { vendor: humanFallback, usedHumanFallback: true }
}

// Exported so callers can detect when the fallback was applied (e.g. for logging).
export function resolveFixVendor(
  stepReviewer: string,
  origin: PROrigin,
  config: Config,
  fallback?: 'claude' | 'codex',
): { vendor: 'claude' | 'codex' | null; usedHumanFallback: boolean; substitutedOriginVendor?: 'claude' | 'codex' } {
  return resolveStepVendor('fix', stepReviewer, origin, config, fallback)
}

// The default workflow gives conflict-resolve `reviewer: origin`, so every PR
// crosscheck cannot attribute resolved to null here and skipped with 'no_vendor'
// — the fix step honoured routing.fallback_reviewer, this one did not.
export function resolveConflictResolveVendor(
  stepReviewer: string,
  origin: PROrigin,
  config: Config,
  fallback?: 'claude' | 'codex',
): { vendor: 'claude' | 'codex' | null; usedHumanFallback: boolean; substitutedOriginVendor?: 'claude' | 'codex' } {
  return resolveStepVendor('conflict-resolve', stepReviewer, origin, config, fallback)
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

/**
 * Builds the input the review strategy classifies on, from the already-cloned
 * working copy rather than the API — the runner has the repo on disk, so this
 * costs one `git diff` instead of a round trip.
 *
 * Returns null when the diff can't be read. Callers then fall back to the
 * configured tier, which is why `quality.tier` stays meaningful under smart mode.
 */
export function buildPRContext(ctx: WorkflowContext): PRContext | null {
  const { tmpDir, pr } = ctx
  try {
    // execFileSync, not execSync: a git ref may legally contain `;`, `$( )` and
    // backticks, and this value drives routing rather than best-effort logging.
    const raw = execFileSync(
      'git',
      ['diff', '--numstat', `origin/${pr.base.ref}...HEAD`],
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    if (!raw) return null

    const files: string[] = []
    let additions = 0
    let deletions = 0
    for (const line of raw.split('\n')) {
      // numstat: <added>\t<deleted>\t<path>. Binary files report '-' for both.
      const [add, del, ...rest] = line.split('\t')
      const path = rest.join('\t').trim()
      if (!path) continue
      files.push(path)
      additions += parseInt(add, 10) || 0
      deletions += parseInt(del, 10) || 0
    }
    if (files.length === 0) return null

    return {
      files,
      additions,
      deletions,
      labels: pr.labels?.map(l => l.name) ?? [],
      title: pr.title,
      baseRef: pr.base.ref,
      ...(pr.base.repo.default_branch !== undefined && { defaultBranch: pr.base.repo.default_branch }),
    }
  } catch {
    return null
  }
}

/**
 * Folds a resolved strategy into the quality config the reviewers receive, so
 * every downstream `quality.tier` read picks up the per-PR decision without
 * threading a new parameter through each vendor signature.
 *
 * A null strategy — fixed mode, or an unreadable diff — returns the config
 * untouched, which is why `quality.tier` remains the documented fallback.
 */
export function strategyQuality(
  quality: WorkflowContext['config']['quality'],
  strategy: ResolvedStrategy | null,
): WorkflowContext['config']['quality'] {
  if (!strategy?.tier) return quality
  return { ...quality, tier: strategy.tier }
}

/**
 * Applies the class's effort alongside its tier. Without this the strategy's
 * effort was resolved and logged but never sent, so the run line named a level
 * the CLI was never given.
 *
 * `accepted` is the vendor CLI's vocabulary, which is narrower than the model's:
 * the strategy escalates to `xhigh` on round 3 and claude-opus-5 reasons at that
 * level, but the claude CLI has no flag for it, so claudeEffort() mapped the
 * unknown value to `medium` — a round 3 weaker than round 2. Clamp here, where
 * the strategy meets the config, rather than at each CLI.
 */
export function strategyVendor<T extends { effort?: string }>(
  vendor: T,
  strategy: ResolvedStrategy | null,
  accepted: readonly string[],
): T {
  if (!strategy?.effort) return vendor
  const effort = clampToLevels(strategy.effort, accepted)
  if (effort === null) return vendor
  return { ...vendor, effort }
}
// NOTE on the asymmetry with `model`: an explicit vendors.*.model is honored
// over the strategy, but vendors.*.effort is not. That is deliberate rather than
// an oversight — `effort` carries a schema default, so a parsed config cannot
// distinguish "the user chose medium" from "nobody set it", and treating the
// default as a user choice would disable effort escalation for everyone. The
// override is documented in crosscheck.config.example.yml next to the model
// note; set `quality.mode: fixed` to keep a hand-set effort on every call.

/**
 * True when the strategy actually determined the model that ran.
 *
 * Judged from the resolved model rather than from config shape, because two
 * different configs defeat the tier map:
 *   - an explicit `vendors.*.model` outranks it, and
 *   - codex under subscription auth with no `model`/`model_tiers` resolves every
 *     tier to the CLI's own `default`, so fast/balanced/thorough are the same run.
 * In both cases the strategy's tier is not what happened, and citing it would
 * assert a routing decision that never took place — the exact auditability
 * property this feature exists to provide.
 */
export function strategyDeterminedModel(
  vendor: { model?: string | null },
  strategy: ResolvedStrategy | null,
  resolvedModel?: string,
): boolean {
  if (strategy === null || vendor.model) return false
  // 'default' means the vendor CLI chose, not us.
  return resolvedModel !== 'default'
}

/**
 * Classifies the PR and resolves the strategy, or returns null under
 * `quality.mode: fixed` so the single configured tier applies unchanged.
 */
export function resolveStrategyForPR(ctx: WorkflowContext): ResolvedStrategy | null {
  if (ctx.config.quality.mode !== 'smart') return null
  const prContext = buildPRContext(ctx)
  if (!prContext) return null
  return resolveReviewStrategy(prContext)
}

export interface RoundExecution {
  /** The class as escalated for this round; null under fixed mode. */
  strategy: ResolvedStrategy | null
  quality: Config['quality']
  claudeVendor: Config['vendors']['claude']
  codexVendor: Config['vendors']['codex']
  /** `config` with the above folded in, for callees that take the whole config. */
  roundConfig: Config
  escalated: boolean
}

/**
 * The tier, effort, and vendor configs every step of one round runs under.
 *
 * One function rather than a fold at each use site: the review step ran the
 * escalated strategy while the fix step re-folded the base class, so a promoted
 * round reviewed with the stronger model and then fixed with the weaker one —
 * and took the weaker tier's subprocess timeout with it.
 *
 * Rounds beyond the first escalate: the class tier was already tried and did not
 * resolve the PR, so difficulty is now measured rather than predicted. escalate()
 * raises effort where the model supports it and promotes a tier where it does
 * not, and never weakens the model.
 */
export function resolveRoundExecution(
  config: Config,
  strategy: ResolvedStrategy | null,
  round: number,
): RoundExecution {
  if (!strategy) {
    return {
      strategy: null,
      quality: config.quality,
      claudeVendor: config.vendors.claude,
      codexVendor: config.vendors.codex,
      roundConfig: config,
      escalated: false,
    }
  }

  // The vendors that may actually run this round, each with the model it would
  // use and the vocabulary its CLI accepts. Keyed to the enabled vendors rather
  // than to claude alone: on a codex-only install the claude tier model is never
  // called, so judging escalation by its effort ladder promoted a tier every
  // round while codex sat at the effort it started on.
  const baseQuality = strategyQuality(config.quality, strategy)
  const lanes: EscalationLane[] = []
  if (config.vendors.claude.enabled) {
    lanes.push({ model: resolveClaudeModel(baseQuality, config.vendors.claude), accepted: CLAUDE_EFFORT_LEVELS })
  }
  if (config.vendors.codex.enabled) {
    lanes.push({ model: resolveCodexModel(baseQuality, config.vendors.codex), accepted: CODEX_EFFORT_LEVELS })
  }

  const escalated = escalate(
    { tier: strategy.tier ?? config.quality.tier, effort: strategy.effort },
    round,
    lanes,
  )
  const roundStrategy = { ...strategy, tier: escalated.tier, effort: escalated.effort }
  const quality = strategyQuality(config.quality, roundStrategy)
  const claudeVendor = strategyVendor(config.vendors.claude, roundStrategy, CLAUDE_EFFORT_LEVELS)
  const codexVendor = strategyVendor(config.vendors.codex, roundStrategy, CODEX_EFFORT_LEVELS)

  return {
    strategy: roundStrategy,
    quality,
    claudeVendor,
    codexVendor,
    roundConfig: { ...config, quality, vendors: { ...config.vendors, claude: claudeVendor, codex: codexVendor } },
    escalated: escalated.tier !== strategy.tier || escalated.effort !== strategy.effort,
  }
}

function emitPRComplexity(ctx: WorkflowContext, triggerField: Record<string, unknown>, effectiveTierForRun: Config['quality']['tier']): void {
  const { owner, repoName, prNumber, tmpDir, pr } = ctx
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
      quality_tier: effectiveTierForRun,
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
    execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: tmpDir, env })
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
        execFileSync('git', ['fetch', 'origin', branch], { cwd: tmpDir, env, stdio: 'pipe' })
        // Rebase our changes onto the latest branch state
        execFileSync('git', ['rebase', `origin/${branch}`], { cwd: tmpDir, env, stdio: 'pipe' })
        // Retry the push
        execFileSync('git', ['push', 'origin', `HEAD:${branch}`], { cwd: tmpDir, env })
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
  const configuredSteps = (ctx.steps ?? loadWorkflow(process.cwd())).map(step => {
    if (!step.harness || step.instructions) return step
    const resolved = loadHarnessSection(step.harness, process.cwd())
    return resolved ? { ...step, instructions: resolved } : step
  })
  // Resolved once per runWorkflow call: the fix step pushes commits, so
  // re-classifying per step could yield a different class and make the review
  // and recheck comments cite different tiers for the same PR.
  //
  // Not once per PR: --crazy/--halfcrazy re-enter runWorkflow per round, and by
  // then the diff includes crosscheck's own fix commits, so a later round can
  // legitimately classify differently. Each comment cites the class that
  // produced it, so the record stays accurate either way.
  const strategy = resolveStrategyForPR(ctx)
  if (config.quality.mode === 'smart' && !strategy) {
    // A smart-mode install quietly behaving as fixed is otherwise invisible.
    fileLog({ level: 'warn', event: 'strategy_unresolved', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'pr_context_unavailable', fallback_tier: config.quality.tier })
  } else if (strategy) {
    // A config written before `mode` existed parses as smart on upgrade, so a
    // hand-set `quality.tier` can be silently overridden. onboard preserves the
    // old tier by reading raw yaml, but that only helps users who re-run it —
    // so record it here for everyone else.
    //
    // info, not warn: `config.quality.tier` carries a schema default of
    // `balanced` on every install, so the parsed config cannot tell a hand-set
    // tier from an unset one. Five of the eight classes resolve to something
    // other than balanced, which made this fire on the majority of PRs — and
    // recommend a `mode: fixed` opt-out to users who never chose a tier at all.
    // Only the raw yaml can draw that distinction (thoroughnessDefaults), and it
    // is not available on this path.
    if (strategy.tier && strategy.tier !== config.quality.tier) {
      fileLog({ level: 'info', event: 'strategy_overrode_configured_tier', repo: `${owner}/${repoName}`, pr: prNumber, configured_tier: config.quality.tier, applied_tier: strategy.tier, pr_class: strategy.classId })
    }
    fileLog({ level: 'info', event: 'strategy_resolved', repo: `${owner}/${repoName}`, pr: prNumber, strategy_version: strategy.version, pr_class: strategy.classId, tier: strategy.tier, effort: strategy.effort, steps: strategy.steps, domain: strategy.domain })
  }

  // The class's step set NARROWS the configured pipeline; it never widens it.
  // A repo set to review-only stays review-only whatever the class says, which
  // matches how per-repo `crosscheck alter` overrides compose. Reuses
  // filterStepsByTypes so the conflict-resolve rule (orthogonal to the depth
  // ladder, kept only when the depth permits code modification) stays in one
  // place rather than being re-derived here.
  const steps = ((): typeof configuredSteps => {
    if (!strategy || strategy.steps.length === 0) return configuredSteps
    const classTypes = strategy.steps.filter(
      (t): t is RepoWorkflowStep => t === 'review' || t === 'fix' || t === 'recheck',
    )
    if (classTypes.length === 0) return configuredSteps
    const narrowed = filterStepsByTypes(configuredSteps, classTypes)
    const dropped = configuredSteps.length - narrowed.length
    if (dropped > 0) {
      log(chalk.dim(`  strategy v${strategy.version}: ${strategy.classId} → ${classTypes.join(', ')} (${dropped} step${dropped === 1 ? '' : 's'} dropped)`))
      fileLog({ level: 'info', event: 'strategy_steps_narrowed', repo: `${owner}/${repoName}`, pr: prNumber, pr_class: strategy.classId, configured: configuredSteps.map((x: { type: string }) => x.type), applied: narrowed.map((x: { type: string }) => x.type), strategy_version: strategy.version })
    }
    return narrowed
  })()

  if (strategy && strategy.tier === null) {
    log(chalk.dim(`  strategy v${strategy.version}: ${strategy.classId} → skipped (${strategy.reason})`))
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'strategy_class_skip', pr_class: strategy.classId, strategy_version: strategy.version })
    return { verdict: null, strategySkipped: strategy.classId }
  }

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
  const skillCatalog = config.skills.enabled.length > 0 ? loadSkillCatalog() : []
  const skillSessions = new Map<string, SkillActivationSession>()
  const skillSessionFor = (stepName: string, stepType: string): SkillActivationSession | undefined => {
    if (skillCatalog.length === 0) return undefined
    const existing = skillSessions.get(stepName)
    if (existing) return existing
    const session = createSkillActivationSession(stepType, config.skills.enabled, skillCatalog)
    skillSessions.set(stepName, session)
    return session
  }
  // Skills were offered and the agent took none. Silent before, which is how a
  // prompt that never triggered activation ran unnoticed for 336 steps.
  // `skills_activated: []` on the *_complete events says something similar but
  // quietly; what is new here is `enabled` (what was actually on offer) and the
  // warn level, which makes a step that activates nothing greppable on its own.
  const logSkillsNoneActivated = (
    session: SkillActivationSession,
    identity: StepIdentityFields | { step_type: 'fix' | 'conflict-resolve'; step_name: string },
  ): void => {
    // skillSessionFor hands back a session whenever the catalog is non-empty,
    // but createSkillActivationSession filters that catalog down to
    // config.skills.enabled — so a configured name that never resolved (typo,
    // skill not installed) leaves enabledSkills empty, and then
    // renderSkillBrokerInstructions renders nothing at all. Nothing was offered,
    // so nothing was refused: that is broken config, not agent non-compliance,
    // and logging it here would conflate the two causes the event exists to
    // tell apart.
    if (session.enabledSkills.length === 0) return
    fileLog({ level: 'warn', event: 'skills_none_activated', repo: `${owner}/${repoName}`, pr: prNumber, ...identity, enabled: session.enabledSkills.map(skill => skill.name) })
  }

  // Linear write-back identity. Resolved up front — before any expensive step —
  // and allowed to throw. The contract is that a configured-but-failing
  // client_credentials mint ABORTS rather than degrading, because silently
  // continuing would either drop the write or re-attribute it to a human. This
  // matches commands/review.ts; the two paths must not disagree.
  // The contract is one token per command run. runWorkflow is re-entered for every
  // fix/recheck round under --crazy and max_rounds, so minting here would mint per
  // round and let a late transient failure abort work already done. The caller
  // resolves once and passes it in; resolving here is the single-round fallback.
  // A dry run posts nothing, so it never mints.
  let linearAuth: ResolvedLinearAuth | null = ctx.linearAuth ?? null

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

  // Class picks tier AND effort under smart; untouched config under fixed.
  // Every step of this round reads from here — review, fix, and recheck alike —
  // so a promoted round cannot review with one model and fix with another.
  //
  // Above the try, and above emitPRComplexity, because both the complexity event
  // and workflow_complete report the tier that ran: an escalated round reporting
  // the base class tier is the same defect as a comment citing one.
  const { strategy: roundStrategy, quality, claudeVendor, codexVendor, roundConfig, escalated } =
    resolveRoundExecution(config, strategy, ctx.round ?? 1)

  emitPRComplexity(ctx, triggerField, quality.tier)

  try {
  // Inside the try so a preflight failure still reaches the completion handler in
  // the finally — resolving above it meant a failed mint skipped workflow_complete
  // entirely and left no record of the run.
  // canWriteVerdict here too: the caller passes null deliberately when the selected
  // steps cannot write a verdict, and this fallback previously read that as
  // "unresolved" and resolved anyway — defeating the gate one line upstream.
  if (!ctx.dryRun && !linearAuth && linearWritePossible(config.linear, steps)) {
    linearAuth = await resolveLinearAuth(config.linear, getLinearCredentials(config.linear.auth))
    fileLog({ level: 'info', event: 'linear_auth_resolved', repo: `${owner}/${repoName}`, pr: prNumber, mode: linearAuth.mode, actor: linearAuth.actor })
  }

  // Logged once per run, not per step: nothing here depends on `step`, and
  // recomputing inside the loop printed the same line for review and recheck.
  if (strategy && roundStrategy) {
    // Report the effort each vendor was actually GIVEN, not the level the round
    // asked for. The two CLI vocabularies differ, so one round can send codex
    // `xhigh` and claude `high`; printing the request names a level nobody ran.
    const appliedEffort = [...new Set([
      ...(config.vendors.claude.enabled ? [claudeVendor.effort] : []),
      ...(config.vendors.codex.enabled ? [codexVendor.effort] : []),
    ])].join('/')
    const escalatedNote = escalated ? ` · round ${ctx.round} escalated` : ''
    log(chalk.dim(`  strategy v${strategy.version}: ${strategy.classId} → ${roundStrategy.tier ?? 'skip'} tier${appliedEffort ? ` (${appliedEffort})` : ''}${escalatedNote}`))
    if (escalatedNote) {
      fileLog({ level: 'info', event: 'strategy_escalated', repo: `${owner}/${repoName}`, pr: prNumber, round: ctx.round, from_tier: strategy.tier, to_tier: roundStrategy.tier, from_effort: strategy.effort, to_effort: roundStrategy.effort, applied_effort_claude: config.vendors.claude.enabled ? claudeVendor.effort : null, applied_effort_codex: config.vendors.codex.enabled ? codexVendor.effort : null, strategy_version: strategy.version })
    }
  }

  for (const step of steps) {
    currentStepName = step.name
    stepsRun.push(step.name)
    const effectiveType = getEffectiveStepType(step.type, ctx.isRecheckRun === true)

    if (exceedsMaxRounds(effectiveType, step.type, ctx.overrideMaxRounds ?? step.max_rounds, ctx.round)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'max_rounds' })
      results[step.name] = { skipped: true, skipReason: 'max_rounds' }
      if (effectiveType === 'fix') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      else if (effectiveType === 'recheck') onPhaseChange('', { phase: 'rechecked' })
      else if (effectiveType === 'conflict-resolve') onPhaseChange('', { phase: 'fixed', fixCount: 0 })
      continue
    }

    // Evaluate when condition — skip step if false
    if (step.when && !evaluateWhen(step.when, results)) {
      fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'when_condition' })
      results[step.name] = { skipped: true, skipReason: 'when_condition' }
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
      results[step.name] = { skipped: true, skipReason: 'no_change_since_review' }
      onPhaseChange('', { phase: 'rechecked' })
      continue
    }

    if (effectiveType === 'review' || effectiveType === 'recheck') {
      const isRecheck = effectiveType === 'recheck'
      let reviewer = resolveReviewer(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (!reviewer) {
        fileLog({ level: 'info', event: 'step_skipped', repo: `${owner}/${repoName}`, pr: prNumber, step: step.name, reason: 'no_reviewer' })
        results[step.name] = { skipped: true, skipReason: 'no_reviewer' }
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
      let effort: string | undefined
      let retried: { timeoutMs: number; delayMs: number } | undefined
      const skillSession = skillSessionFor(step.name, effectiveType)
      // Under `quality.mode: smart` the PR's class picks the tier; under fixed
      // this is config.quality untouched.
      const runReviewWithVendor = async (candidate: Vendor): Promise<void> => {
        if (candidate === 'codex') {
          ;({ review: rawReview, tokensUsed, model, effort, retried } = await runCodexReview(tmpDir, pr.base.ref, pr.title, quality, codexVendor, step.instructions, undefined, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.codex.timeout_sec), log, ctx.issueContext, skillSession))
          inputTokens = undefined
          outputTokens = undefined
        } else {
          ;({ review: rawReview, tokensUsed, inputTokens, outputTokens, model, effort, retried } = await runClaudeReview(tmpDir, pr.base.ref, pr.title, quality, claudeVendor, config.budget.per_review_usd, step.instructions, undefined, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec), !!ctx.roundMode, log, ctx.issueContext, skillSession))
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

      const activatedSkills = skillSession?.activations() ?? []
      if (activatedSkills.length > 0) log(chalk.dim(`  skills: ${formatSkillAttribution(activatedSkills)}`))
      else if (skillSession) logSkillsNoneActivated(skillSession, stepIdentity)

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
      // Skills are not folded into the body — postReviewComment renders the
      // receipt beneath the attribution footer.
      const commentBody = retried
        ? `${buildRetriedReviewBanner(retried.timeoutMs, retried.delayMs)}\n\n${baseBody}`
        : baseBody
      const commentCount = countComments(rawReview)
      // How long the PR waited for a verdict, measured from when its author opened
      // it — the number a team feels, as distinct from duration_ms (how long the
      // reviewer ran). Omitted rather than guessed when the PR event carried no
      // created_at, so the metric never mixes real latencies with invented ones.
      const openToVerdictMs = prOpenToVerdictMs(pr.created_at, verdict)
      fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, model, ...stepIdentity, verdict, duration_ms: Date.now() - stepStart, ...(openToVerdictMs !== undefined && { open_to_verdict_ms: openToVerdictMs }), tokens_used: tokensUsed, skills_activated: activatedSkills.map(skill => skill.name), ...(inputTokens !== undefined && { input_tokens: inputTokens }), ...(outputTokens !== undefined && { output_tokens: outputTokens }), ...(ctx.round !== undefined && { round: ctx.round }), ...(ctx.roundMode && { mode: ctx.roundMode }), ...triggerField })

      // Recheck verdict is stored separately to preserve the original review's commentCount on the board
      const phaseUpdate: PRPhaseData = isRecheck
        ? { recheckVerdict: verdict, phase: donePhase, recheckTokens: tokensUsed, recheckReviewer: reviewer, qualityTier: quality.tier }
        : { verdict, commentCount, phase: donePhase, crTokens: tokensUsed, crReviewer: reviewer, qualityTier: quality.tier }

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

        // ...but the clone's HEAD is only trustworthy once it is in the repo. A fix
        // commit whose push failed leaves HEAD one commit ahead of the remote, and
        // stamping it attributes this verdict to code that does not exist — an APPROVE
        // on a phantom sha clears the previous BLOCK and reads as routine on the PR
        // page. Refuse to post rather than post an unattributable verdict: a missing
        // review is recoverable (the run fails, the pending status releases as
        // failure, the PR stays blocked), a phantom approval is not.
        const shaVerification = await verifyReviewedSha(octokit, owner, repoName, prNumber, annotationSha)
        if (!isVerifiedReviewedSha(shaVerification.status)) {
          const rejection = reviewedShaRejection(shaVerification, annotationSha, verdict)
          fileLog({ level: 'error', event: 'verdict_sha_unverified', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, verdict, sha: annotationSha, head_sha: shaVerification.headSha, verification: shaVerification.status, ...(ctx.round !== undefined && { round: ctx.round }), ...triggerField })
          log(chalk.red(`✗ ${rejection}`))
          // The review itself cost vendor tokens — surface it rather than lose it.
          log(chalk.dim(`\n--- unposted review ---\n${commentBody}\n--- end ---`))
          throw new Error(rejection)
        }
        if (shaVerification.status === 'descendant') {
          // The reviewed commit is real but ahead of the PR head — the fix landed on a
          // separate auto-fix branch. Recorded so a verdict that does not cover HEAD is
          // explicable from the log rather than looking like the head-matching case.
          fileLog({ level: 'warn', event: 'verdict_sha_off_head', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, ...stepIdentity, verdict, sha: annotationSha, head_sha: shaVerification.headSha, ...(ctx.round !== undefined && { round: ctx.round }), ...triggerField })
        }

        const commentId = await postReviewComment(
          octokit, owner, repoName, prNumber, commentBody, reviewer, config.brand,
          origin, verdict ?? undefined, priorReviewId, isRecheck, model, effectiveType, ctx.round ?? 1, annotationSha,
          nextStepAnnotation,
          ctx.trigger === 'kickass' ? 'kickass' : undefined,
          activatedSkills,
          effort,
          // Withheld when an explicit vendors.*.model overrode the tier map:
          // citing a tier the run did not use would assert a routing decision
          // that never happened.
          strategyDeterminedModel(reviewer === 'codex' ? config.vendors.codex : config.vendors.claude, roundStrategy, model) && roundStrategy?.tier
            ? { version: roundStrategy.version, classId: roundStrategy.classId, tier: roundStrategy.tier, reason: roundStrategy.reason }
            : undefined,
        )
        const commentUrl = `github.com/${owner}/${repoName}/pull/${prNumber}`
        fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, url: `https://${commentUrl}` })

        // A posted verdict that blocks the merge is the product's whole reason to
        // exist, so it gets its own event rather than being re-derived downstream.
        // BLOCK blocks by definition; a NEEDS WORK that reached here survived the
        // severity gate, which only lets it through when a Critical/High/Medium
        // finding backs it — a nit-only review was already downgraded to APPROVE.
        // Logged only here, after the comment actually posted, so dry runs and
        // failed postReviewComment calls are never counted as posted findings.
        if (verdict === 'BLOCK' || verdict === 'NEEDS WORK') {
          fileLog({ level: 'info', event: 'blocking_finding_posted', repo: `${owner}/${repoName}`, pr: prNumber, reviewer, model, ...stepIdentity, verdict, ...(ctx.round !== undefined && { round: ctx.round }), ...triggerField })
        }

        // Mirror the verdict onto the PR's Linear issue. `run` and `watch` both
        // land here, so this is the path that matters — reviews posted from
        // commands/review.ts are the exception, not the rule.
        if (linearAuth && shouldPostToLinear(verdict ?? null, config.linear.comment_on)) {
          {
            // Attribute to crosscheck/review, /fix, /recheck rather than a flat actor.
            const stepAuth = config.linear.identity.per_step_actor ? withWorker(linearAuth, effectiveType) : linearAuth
            const linearResult = await notifyLinear({
              auth: stepAuth,
              config: config.linear,
              pr: { branch: pr.head.ref, title: pr.title, body: pr.body ?? '', url: `https://${commentUrl}`, sha: annotationSha },
              verdict: verdict ?? null,
              reviewer,
              origin,
              model,
              stepType: effectiveType,
              round: ctx.round ?? 1,
              service: config.brand.service_name,
            })
            fileLog({
              level: linearResult.status === 'failed' ? 'warn' : 'info',
              event: 'linear_comment', repo: `${owner}/${repoName}`, pr: prNumber,
              status: linearResult.status, reason: linearResult.reason, issue: linearResult.identifier,
            })
            if (linearResult.status === 'posted') {
              log(chalk.dim(`  linear: commented on ${linearResult.identifier}`))
            } else if (linearResult.status === 'failed') {
              log(chalk.yellow(`  linear: write failed — ${linearResult.reason}`))
            }
          }
        }
        results[step.name] = { verdict, commentBody, commentUrl, commentId, tokens_used: tokensUsed, input_tokens: inputTokens, output_tokens: outputTokens, vendor: reviewer, model }
      }

    } else if (effectiveType === 'fix') {
      const skipFix = (reason: string) => {
        lastFixSkipReason = reason
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true, skipReason: reason }
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

      // The fix step holds the review's tier — this round's, escalation
      // included: it is generation against an explicit findings list, which
      // models handle well, but a cheap fixer that introduces a regression costs
      // a whole extra round. Recheck does not step down either — it decides
      // whether to spend another round, and a weak judge there is how loops run
      // away.
      const claudeFixModel = resolveClaudeModel(quality, claudeVendor)
      const codexFixModel = resolveCodexModel(quality, codexVendor)

      // Guard: don't push more than MAX_CROSSCHECK_COMMITS per PR.
      // Scope to commits ahead of base so long-lived branches (e.g. staging)
      // don't count [crosscheck] commits from previously merged PRs.
      // Crazy/halfcrazy mode doubles the cap since it deliberately loops.
      const commitCount = countCrosscheckCommitsForPRDetailed(tmpDir, pr.base.ref)
      const effectiveCommitLimit = ctx.roundMode ? MAX_CROSSCHECK_COMMITS * 2 : MAX_CROSSCHECK_COMMITS

      if (commitCount.count >= effectiveCommitLimit) {
        // Report the count, not the limit. An unscoped count means origin/<base>
        // was missing, so this is an over-count from whole-repo history rather
        // than a real cap hit — say so, or the next person debugs the wrong thing.
        log(commitCount.scoped
          ? chalk.yellow(`⚠  PR #${prNumber}: ${commitCount.count}/${effectiveCommitLimit} [crosscheck] commits already — stopping auto-fix`)
          : chalk.yellow(`⚠  PR #${prNumber}: cannot scope [crosscheck] commit count (origin/${pr.base.ref} missing; ${commitCount.count} across all history) — stopping auto-fix`))
        skipFix(commitCount.scoped ? 'commit_limit_reached' : 'commit_count_unscoped')
        continue
      }

      onPhaseChange(`${vendor} fixing...`, { phase: 'fixing' })
      const fixStepStart = Date.now()
      let appliedCount = 0
      let fixChangedFiles: string[] = []
      let fixTokensUsed: number | undefined
      let fixEffort: string | undefined
      let fixErr: unknown = undefined
      let activeVendor = vendor

      // The strategy tier, not the configured one: a risky PR runs the thorough
      // model here, and the balanced 600s budget would cut it off.
      const tierMs = tierTimeoutMs(quality.tier)
      const skillSession = skillSessionFor(step.name, effectiveType)
      const runFix = async (v: 'claude' | 'codex') => {
        if (v === 'codex') {
          return runCodexFixStep(
            tmpDir, pr.base.ref, pr.title, reviewCommentBody, step.instructions ?? '',
            codexFixModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.codex.timeout_sec) ?? tierMs, skillSession,
            codexVendor.effort,
          )
        }
        // roundConfig, not config: runFixStep reads vendors.claude.effort and
        // quality.tier out of it, and both must be this round's values.
        return runFixStep(
          tmpDir, pr.base.ref, pr.title, reviewCommentBody, step.instructions ?? '',
          roundConfig, claudeFixModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec) ?? tierMs, skillSession,
        )
      }

      try {
        ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed, effort: fixEffort } = await runFix(vendor))
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
            ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed, effort: fixEffort } = await runFix(fallbackVendor))
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
          ;({ appliedCount, changedFiles: fixChangedFiles, tokensUsed: fixTokensUsed, effort: fixEffort } = await runFix(activeVendor))
          fileLog({ level: 'info', event: 'fix_retry_succeeded', repo: `${owner}/${repoName}`, pr: prNumber })
          fixErr = undefined
        } catch (retryErr) {
          logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'fix', attempt: 2 }, retryErr)
          fixErr = retryErr
        }
      }

      const activatedSkills = skillSession?.activations() ?? []
      if (activatedSkills.length > 0) log(chalk.dim(`  skills: ${formatSkillAttribution(activatedSkills)}`))
      else if (skillSession) logSkillsNoneActivated(skillSession, { step_type: 'fix', step_name: step.name })

      // Every delivery mode (commit card, fix PR, suggested-diff comment) closes
      // with the same footer as a review comment.
      const fixAttributionFooter = (): string => buildAttributionFooter({
        action: 'Fixed',
        vendor: activeVendor,
        model: activeVendor === 'codex' ? codexFixModel : claudeFixModel,
        effort: fixEffort,
        skills: activatedSkills,
      })

      if (fixErr !== undefined) {
        skipFix(isSubscriptionLimitError(fixErr) ? 'vendor_limit' : 'fix_error')
        // Only notify for transient failures — auth errors are operator issues, not PR author issues
        if (isRetryableFixError(fixErr)) {
          try {
            const octokit = createGithubClient(token)
            await octokit.rest.issues.createComment({
              owner, repo: repoName, issue_number: prNumber,
              body: buildFixFailedCommentBody({
                prUrl: pr.html_url,
                vendor: activeVendor,
                model: activeVendor === 'codex' ? codexFixModel : claudeFixModel,
                effort: fixEffort,
                skills: activatedSkills,
              }),
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
        fileLog({ level: 'info', event: 'fix_noop', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: 0, no_changes: true, tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })
        results[step.name] = { applied_count: 0, ...(fixTokensUsed !== undefined && { tokens_used: fixTokensUsed }), vendor }
        continue
      }

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { skipFix('fork_pr'); continue }

      const deliveryMode = config.post_review.auto_fix.delivery.mode
      const landing = resolveFixLanding(deliveryMode)

      if (landing === 'branch') {
        const fixModel = activeVendor === 'codex' ? codexFixModel : claudeFixModel
        execSync('git add -A', { cwd: tmpDir })
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            fixCommitSubject(appliedCount, activeVendor),
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
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'commit', tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })

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
            model: activeVendor === 'codex' ? codexFixModel : claudeFixModel,
            effort: fixEffort,
            skills: activatedSkills,
          })
          await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
          fileLog({ level: 'info', event: 'fix_applied_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha })
        } catch (err) {
          fileLog({ level: 'warn', event: 'fix_applied_comment_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: err instanceof Error ? err.message : String(err) })
        }

        results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }

      } else if (landing === 'branch-then-separate-pr') {
        const fixModel = activeVendor === 'codex' ? codexFixModel : claudeFixModel
        // Commit the fix on the PR's own branch (already checked out in tmpDir) and
        // try to push it there, so the fix, recheck, and approval all stay on the
        // original PR. Only when that push can't land — e.g. the PR was merged and
        // its branch deleted, or the branch is protected — do we fall back to opening
        // a separate follow-up PR that carries the very same commit.
        execSync('git add -A', { cwd: tmpDir })
        execFileSync(
          'git',
          [
            'commit',
            '-m',
            fixPRCommitSubject(prNumber, activeVendor),
            '-m',
            buildCommitTrailers({ reviewer: activeVendor, model: fixModel, step: 'fix', service: 'crosscheck' }),
          ],
          { cwd: tmpDir },
        )
        const newSha = execSync('git rev-parse HEAD', { cwd: tmpDir, encoding: 'utf8' }).trim()

        let landedOnBranch = false
        try {
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
          landedOnBranch = true
        } catch (pushErr: unknown) {
          fileLog({ level: 'warn', event: 'fix_branch_push_fell_back', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha, branch: pr.head.ref, error: pushErr instanceof Error ? pushErr.message.slice(0, 500) : String(pushErr), fallback: 'pull_request' })
        }
        ctx.crosscheckShas.add(newSha)

        if (landedOnBranch) {
          // Fix landed on the PR branch — mirror `commit` delivery exactly: set the
          // pending status the following recheck releases, and post the fix-applied
          // comment so the push is visible on the PR timeline.
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
          fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'commit', tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })
          try {
            const octokit = createGithubClient(token)
            const body = buildFixAppliedCommentBody({
              owner, repo: repoName, sha: newSha, appliedCount,
              reviewCommentId,
              changedFiles: fixChangedFiles,
              vendor: activeVendor,
              reviewCommentBody,
              model: activeVendor === 'codex' ? codexFixModel : claudeFixModel,
              effort: fixEffort,
              skills: activatedSkills,
            })
            await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
            fileLog({ level: 'info', event: 'fix_applied_comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, sha: newSha })
          } catch (err) {
            fileLog({ level: 'warn', event: 'fix_applied_comment_failed', repo: `${owner}/${repoName}`, pr: prNumber, error: err instanceof Error ? err.message : String(err) })
          }
          results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }
        } else {
          // Fallback: the fix could not land on the PR branch. Push the same commit to a
          // dedicated branch and open a follow-up PR targeting the original branch.
          const fixBranch = autoFixBranchName(prNumber)
          const gitEnv = { ...process.env, GITHUB_TOKEN: token, GH_TOKEN: token }
          const octokit = createGithubClient(token)

          // The fallback commit exists only in this clone until something pushes it, so
          // every path that ends without delivering it as a PR has to put HEAD back on the
          // PR head. Otherwise a later recheck reviews that commit and stamps its verdict
          // either with a sha the repository cannot resolve — which verifyReviewedSha
          // refuses to post (#290) — or with one no open PR carries.
          const restorePRHeadInClone = () => {
            execSync('git reset --hard HEAD~1', { cwd: tmpDir, stdio: 'pipe' })
          }

          // Deliver the fix as a diff on the original PR. Used wherever opening the
          // follow-up PR would either create a stale artifact or overwrite a branch that
          // is not ours: the work still reaches a human, just not as a branch.
          const deliverFixAsComment = async (outcome: { event: string; reason: string; branch: string; notice: string; explanation: string }) => {
            fileLog({ level: 'warn', event: outcome.event, repo: `${owner}/${repoName}`, pr: prNumber, branch: outcome.branch, reason: outcome.reason })
            log(chalk.yellow(`⚠  ${outcome.notice}`))
            let patch = ''
            try { patch = execSync('git diff HEAD~1', { cwd: tmpDir, encoding: 'utf8' }) } catch { /* fall through to the empty check */ }
            if (patch) {
              await octokit.rest.issues.createComment({
                owner, repo: repoName, issue_number: prNumber,
                body: [
                  '### Suggested fixes (crosscheck auto-fix)',
                  '',
                  outcome.explanation,
                  '',
                  '```diff',
                  patch.slice(0, 16000),
                  '```',
                  '',
                  fixAttributionFooter(),
                ].join('\n'),
              })
            }
            restorePRHeadInClone()
            onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
            fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'comment', tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })
            results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }
          }

          // Ask whether the intended base still exists BEFORE pushing anything. The most
          // common reason the PR-branch push failed is that the PR merged and GitHub
          // deleted its branch — and `pulls.create` rejects a missing base with
          // `field: base, code: invalid`. That used to throw after the branch was already
          // pushed, losing the fix and orphaning the branch (19 times in logged runs).
          let baseBranchExists = true
          try {
            await octokit.rest.repos.getBranch({ owner, repo: repoName, branch: pr.head.ref })
          } catch (err: unknown) {
            if ((err as { status?: number })?.status === 404) baseBranchExists = false
            else throw err
          }
          const delivery = planAutoFixDelivery(baseBranchExists, pr.head.ref)

          if (delivery.kind === 'comment') {
            // A PR cut from this snapshot would be stale the moment it opened — it is
            // exactly the artifact the superseded-auto-fix cleanup exists to close. Post
            // the fix as a diff instead, so the work is still delivered and reviewable.
            await deliverFixAsComment({
              event: 'fix_pr_skipped',
              reason: delivery.reason,
              branch: pr.head.ref,
              notice: `${pr.head.ref} no longer exists — posting the fix as a diff instead of opening a stale follow-up PR`,
              explanation: `\`${pr.head.ref}\` no longer exists, so this PR has merged and there is no branch to land on. The fix is below rather than in a follow-up PR — a PR cut from the pre-merge state would reintroduce whatever the merged version changed.`,
            })
            continue
          }

          // A fix branch left behind by an earlier round of this PR made a plain push
          // non-fast-forward and lost the fix (12 times in logged runs). Replace it under
          // a lease: this round's fix is built on the newer PR head and supersedes it,
          // and the lease still refuses if anything other than us moved the branch.
          let remoteOid: string | null = null
          try {
            remoteOid = parseLsRemoteOid(execFileSync('git', ['ls-remote', '--heads', 'origin', fixBranch], { cwd: tmpDir, env: gitEnv, encoding: 'utf8' }))
          } catch { /* treat an unreadable remote as "branch absent"; the lease catches a wrong guess */ }

          // `--force-with-lease` only protects against changes made *after* this lookup —
          // it happily accepts a branch a human just created or moved as the lease value
          // and overwrites it. So establish that the branch is crosscheck's own artifact
          // before replacing it, from GitHub's record of who opened the PR from it rather
          // than from anything the pusher can write into a commit.
          if (remoteOid !== null) {
            let crosscheckLogin: string | null = null
            let candidates: FixBranchPR[] = []
            try {
              const [{ data: viewer }, { data: branchPrs }] = await Promise.all([
                octokit.rest.users.getAuthenticated(),
                octokit.rest.pulls.list({ owner, repo: repoName, state: 'all', head: `${owner}:${fixBranch}` }),
              ])
              crosscheckLogin = viewer.login
              candidates = branchPrs
            } catch { /* unreadable identity or PR list — treated as not ours, never overwrite */ }
            const ownership = assessFixBranchOwnership({ sourcePrNumber: prNumber, crosscheckLogin, candidates })
            if (!ownership.owned) {
              await deliverFixAsComment({
                event: 'fix_branch_push_skipped',
                reason: ownership.reason,
                branch: fixBranch,
                notice: `${fixBranch} exists but crosscheck has no PR of its own from it — leaving it in place and posting the fix as a diff instead`,
                explanation: `\`${fixBranch}\` already exists and crosscheck cannot show it opened a pull request from it, so the branch was left untouched rather than force-replaced. The fix is posted here instead.`,
              })
              continue
            }
          }

          // From #296: the merged-PR handler sweeps for auto-fix PRs once, so a PR opened
          // after that sweep is never seen by it and stays open and mergeable against a
          // tree that no longer exists. The base-exists check above already covers a merge
          // that deleted the branch; this catches a merge in a repo that keeps its
          // branches. It sits immediately before the push — every lookup above widens the
          // window it has to close, and nothing has been written to the remote yet, so a
          // skip here cannot orphan a branch.
          if (await sourcePRHasMerged(octokit, owner, repoName, prNumber)) {
            restorePRHeadInClone()
            skipFix('source_pr_merged')
            continue
          }

          try {
            execFileSync('git', forceWithLeaseArgs(fixBranch, remoteOid), { cwd: tmpDir, env: gitEnv, stdio: 'pipe' })
          } catch (pushErr: unknown) {
            const pushMsg = pushErr instanceof Error ? pushErr.message : String(pushErr)
            fileLog({
              level: 'error', event: 'fix_branch_push_failed', repo: `${owner}/${repoName}`, pr: prNumber,
              branch: fixBranch, lease: remoteOid ?? 'absent',
              reason: isLeaseRejection(pushMsg) ? 'lease_rejected' : 'push_failed',
              error: pushMsg.slice(0, 500),
            })
            throw pushErr
          }
          if (remoteOid !== null) {
            fileLog({ level: 'info', event: 'fix_branch_replaced', repo: `${owner}/${repoName}`, pr: prNumber, branch: fixBranch, previous_sha: remoteOid, sha: newSha })
          }

          // Undo this run's push when the follow-up PR turns out not to be creatable after
          // all. Only a branch this run brought into existence is removed — one that was
          // already crosscheck's is left at the newer commit rather than deleted out from
          // under whatever else references it.
          const rollBackPushedFixBranch = () => {
            if (remoteOid !== null) return
            try {
              execFileSync('git', ['push', 'origin', '--delete', fixBranch], { cwd: tmpDir, env: gitEnv, stdio: 'pipe' })
              fileLog({ level: 'info', event: 'fix_branch_rolled_back', repo: `${owner}/${repoName}`, pr: prNumber, branch: fixBranch, sha: newSha })
            } catch (deleteErr: unknown) {
              fileLog({ level: 'warn', event: 'fix_branch_rollback_failed', repo: `${owner}/${repoName}`, pr: prNumber, branch: fixBranch, error: deleteErr instanceof Error ? deleteErr.message.slice(0, 500) : String(deleteErr) })
            }
          }

          // The source PR can still merge in the window between the check above and this
          // point. Asking again here is what keeps the push from becoming a stale fix PR:
          // the branch is already on the remote, so the answer decides whether it stays.
          if (await sourcePRHasMerged(octokit, owner, repoName, prNumber)) {
            rollBackPushedFixBranch()
            restorePRHeadInClone()
            skipFix('source_pr_merged')
            continue
          }

          const fixPrTitle = config.post_review.auto_fix.delivery.pr_title.replace('#{original_pr_title}', pr.title)
          // An earlier round may already have an open PR from this branch; the force-push
          // above updated it, so opening a second one would be rejected as a duplicate.
          const { data: existingFixPrs } = await octokit.rest.pulls.list({
            owner, repo: repoName, state: 'open', head: `${owner}:${fixBranch}`,
          })
          let fixPrNumber: number
          if (existingFixPrs.length > 0) {
            fixPrNumber = existingFixPrs[0].number
            fileLog({ level: 'info', event: 'fix_pr_updated', repo: `${owner}/${repoName}`, pr: prNumber, fix_pr: fixPrNumber, sha: newSha })
          } else {
            let fixPr: { number: number }
            try {
              const created = await octokit.rest.pulls.create({
                owner,
                repo: repoName,
                head: fixBranch,
                base: delivery.base,
                title: fixPrTitle,
                body: [
                  autoFixPRIntro(prNumber),
                  '',
                  `Review: https://github.com/${owner}/${repoName}/pull/${prNumber}`,
                  '',
                  fixAttributionFooter(),
                ].join('\n'),
              })
              fixPr = created.data
            } catch (createErr: unknown) {
              // A merge landing in a repo that deletes its branches takes the base away
              // between the checks above and this call, and `pulls.create` reports that as
              // `field: base, code: invalid` — the original failure this fallback exists to
              // stop, just in a narrower window. Take the branch back out and deliver the
              // fix as a diff rather than leaving it orphaned.
              if (!isInvalidBaseError(createErr)) throw createErr
              rollBackPushedFixBranch()
              await deliverFixAsComment({
                event: 'fix_pr_create_failed',
                reason: 'base_branch_gone_after_push',
                branch: delivery.base,
                notice: `${delivery.base} disappeared while the fix branch was being pushed — posting the fix as a diff instead of opening a stale follow-up PR`,
                explanation: `\`${delivery.base}\` existed when this fix started and was gone by the time the follow-up PR was opened, so this PR merged mid-run. The fix is below rather than in a follow-up PR — a PR cut from the pre-merge state would reintroduce whatever the merged version changed.`,
              })
              continue
            }
            fixPrNumber = fixPr.number
          }
          if (config.post_review.auto_fix.delivery.label) {
            try {
              await octokit.rest.issues.addLabels({
                owner, repo: repoName, issue_number: fixPrNumber, labels: [config.post_review.auto_fix.delivery.label],
              })
            } catch { /* label may not exist in this repo — skip */ }
          }
          onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
          fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, sha: newSha, delivery: 'pull_request', fix_pr: fixPrNumber, tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })
          results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }
        }

      } else {
        // comment: post the diff as a suggested-fix comment, no code push needed (works for fork PRs too)
        let patch = ''
        try { patch = execSync('git diff', { cwd: tmpDir, encoding: 'utf8' }) } catch { /* ignore */ }
        if (patch) {
          const octokit = createGithubClient(token)
          const body = `### Suggested fixes (crosscheck auto-fix)\n\n\`\`\`diff\n${patch.slice(0, 16000)}\n\`\`\`\n\n${fixAttributionFooter()}`
          await octokit.rest.issues.createComment({ owner, repo: repoName, issue_number: prNumber, body })
        }
        onPhaseChange('fixed ✓', { fixCount: appliedCount, phase: 'fixed', fixTokens: fixTokensUsed })
        fileLog({ level: 'info', event: 'fix_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor: activeVendor, applied_count: appliedCount, delivery: 'comment', tokens_used: fixTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - fixStepStart, ...triggerField })
        results[step.name] = { applied_count: appliedCount, tokens_used: fixTokensUsed, vendor: activeVendor }
      }

    } else if (effectiveType === 'conflict-resolve') {
      const skipConflictResolve = (reason: string) => {
        onPhaseChange('', { phase: 'fixed', fixCount: 0 })
        results[step.name] = { skipped: true, skipReason: reason }
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

      // resolveConflictResolveVendor extends resolveReviewer with the same human-origin
      // fallback the fix step uses, so a PR crosscheck cannot attribute still gets its
      // conflicts resolved instead of skipping with 'no_vendor'.
      const { vendor, usedHumanFallback, substitutedOriginVendor } = resolveConflictResolveVendor(step.reviewer, origin, config, ctx.smartSwitchFallback)
      if (usedHumanFallback && vendor) {
        fileLog({ level: 'info', event: 'conflict_resolve_vendor_fallback', repo: `${owner}/${repoName}`, pr: prNumber, from: 'none', to: vendor, reason: 'human_origin' })
      } else if (substitutedOriginVendor && vendor) {
        fileLog({ level: 'info', event: 'conflict_resolve_vendor_fallback', repo: `${owner}/${repoName}`, pr: prNumber, from: substitutedOriginVendor, to: vendor, reason: 'unsupported_vendor' })
      }
      if (!vendor) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('no_vendor'); continue }
      if (vendor === 'codex') { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('codex_conflict_resolve_unsupported'); continue }
      // Conflict-resolve is mechanical text surgery bounded by the markers —
      // measured at 37s against ~643s for a review — so it always runs fast.
      const conflictResolveModel = resolveClaudeModel(
        { ...config.quality, tier: config.quality.mode === 'smart' ? 'fast' : config.quality.tier },
        config.vendors.claude,
      )

      const isFork = pr.head.repo?.full_name !== pr.base.repo.full_name
      if (isFork) { try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }; skipConflictResolve('fork_pr'); continue }

      const crCommitCount = countCrosscheckCommitsForPRDetailed(tmpDir, pr.base.ref)
      if (crCommitCount.count >= MAX_CROSSCHECK_COMMITS) {
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        log(crCommitCount.scoped
          ? chalk.yellow(`⚠  PR #${prNumber}: ${crCommitCount.count}/${MAX_CROSSCHECK_COMMITS} [crosscheck] commits already — stopping conflict-resolve`)
          : chalk.yellow(`⚠  PR #${prNumber}: cannot scope [crosscheck] commit count (origin/${pr.base.ref} missing) — stopping conflict-resolve`))
        skipConflictResolve('commit_limit_reached')
        continue
      }

      onPhaseChange(`${vendor} resolving conflicts...`, { phase: 'fixing' })
      // Per-step start timestamp for conflict-resolve wall time.
      const conflictResolveStepStart = Date.now()
      let appliedCount = 0
      let resolvedPaths: string[] = []
      let resolveTokensUsed: number | undefined
      let resolveEffort: string | undefined
      const skillSession = skillSessionFor(step.name, effectiveType)

      try {
        ;({ appliedCount, resolvedPaths, tokensUsed: resolveTokensUsed, effort: resolveEffort } = await runConflictResolveStep(
          tmpDir, pr.title, step.instructions ?? '', conflictResolveModel, ctx.overrideTimeoutMs ?? vendorTimeoutMs(config.vendors.claude.timeout_sec), skillSession,
          config.vendors.claude.effort,
        ))
      } catch (err) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'conflict-resolve', attempt: 1 }, err)
        try { execSync('git merge --abort', { cwd: tmpDir }) } catch { /* ignore */ }
        skipConflictResolve(isSubscriptionLimitError(err) ? 'vendor_limit' : 'resolve_error')
        continue
      }

      const activatedSkills = skillSession?.activations() ?? []
      if (activatedSkills.length > 0) log(chalk.dim(`  skills: ${formatSkillAttribution(activatedSkills)}`))
      else if (skillSession) logSkillsNoneActivated(skillSession, { step_type: 'conflict-resolve', step_name: step.name })

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
          conflictResolveCommitSubject(conflictedFiles.length, vendor),
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
      fileLog({ level: 'info', event: 'conflict_resolve_complete', repo: `${owner}/${repoName}`, pr: prNumber, vendor, conflicts_resolved: conflictedFiles.length, sha: newSha, tokens_used: resolveTokensUsed, skills_activated: activatedSkills.map(skill => skill.name), duration_ms: Date.now() - conflictResolveStepStart, ...triggerField })

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
          model: conflictResolveModel,
          effort: resolveEffort,
          skills: activatedSkills,
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
    stepOutcomes: summariseStepOutcomes(stepsRun, results),
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
    for (const session of skillSessions.values()) session.close()
    skillSessions.clear()
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
      // The tier that actually ran, not the configured one and not the base
      // class tier — under smart mode all three differ, and telemetry naming the
      // wrong one is the same class of problem as a comment citing a tier that
      // never reached the vendor.
      qualityTier: quality.tier,
    }) as Parameters<typeof fileLog>[0])
  }
}
