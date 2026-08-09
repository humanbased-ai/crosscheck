import { parseAnnotation, parseAnnotationFields } from './annotation.js'
import { evaluateWhen, DEFAULT_RECHECK_INSTRUCTIONS, type WorkflowStep } from './workflow.js'
import type { StepResult } from './workflow.js'
import { parseVerdict } from './verdict.js'
import { fetchPRCommentPage, fetchPRCommitPage, type RawPRComment, type RawPRCommit } from '../github/client.js'

export type StepRecordType = 'review' | 'recheck' | 'fix' | 'conflict-resolve'

export interface StepRecord {
  type: StepRecordType
  /** APPROVE | NEEDS_WORK | BLOCK — from annotation or parsed from body */
  verdict?: string
  /** PR head SHA when this step ran (review/recheck only; absent on older comments) */
  sha?: string
  /** SHA the fix commit pushed to (fix records only; parsed from the commit URL in the body) */
  pushedSha?: string
  round: number
  commentId: number
  commentBody: string
  /** ISO 8601 timestamp from GitHub */
  createdAt: string
  reviewer?: string
  model?: string
  /** Pre-computed next workflow step from the annotation (review/recheck only) */
  next_step?: string
  /** Where this record was reconstructed from. */
  source?: 'comment' | 'commit'
}

/** Why `step` is null. `approved` means the PR is finished for good, not just for this SHA. */
export type WorkflowStopReason = 'approved'

export interface NextStepResult {
  /** Next workflow step to execute, or null when the workflow is complete. */
  step: WorkflowStep | null
  /** Set when the workflow stopped for a reason worth reporting. */
  stopReason?: WorkflowStopReason
  /** For fix/recheck steps: the review comment to use as working context. */
  reviewComment?: { id: number; body: string }
  /** True when at least one review or recheck comment exists on the PR. */
  hasExistingReview: boolean
  /** Round number the next step should run as. */
  round: number
  /** Full parsed history in chronological order. */
  history: StepRecord[]
}

const VALID_STEP_TYPES = new Set<StepRecordType>(['review', 'recheck', 'fix', 'conflict-resolve'])

function commentToRecord(comment: { id: number; body: string; created_at: string }): StepRecord | null {
  const fields = parseAnnotationFields(comment.body)

  if (!fields) {
    // No annotation at all — detect legacy review comments by header pattern
    if (comment.body.includes('### Code Review by') && !comment.body.startsWith('> Recheck of')) {
      const { verdict } = parseVerdict(comment.body)
      return {
        type: 'review',
        ...(verdict !== null && { verdict }),
        round: 1,
        commentId: comment.id,
        commentBody: comment.body,
        createdAt: comment.created_at,
      }
    }
    return null
  }

  // Bareword markers: fix_applied and conflict_resolved have no origin/reviewer fields
  const marker = fields.get('__marker__')
  if (marker === 'fix_applied') {
    // The fix comment body embeds the pushed SHA as a full commit URL — extract it
    // so identifyNextWorkflowStep can verify the fix commit before routing to recheck.
    const shaMatch = comment.body.match(/\/commit\/([0-9a-f]{40})/i)
    const pushedSha = shaMatch ? shaMatch[1] : undefined
    return { type: 'fix', round: 1, commentId: comment.id, commentBody: comment.body, createdAt: comment.created_at, ...(pushedSha !== undefined && { pushedSha }) }
  }
  if (marker === 'conflict_resolved') {
    return { type: 'conflict-resolve', round: 1, commentId: comment.id, commentBody: comment.body, createdAt: comment.created_at }
  }

  // Full annotation (requires origin + reviewer)
  const parsed = parseAnnotation(comment.body)
  if (!parsed) return null

  const type = parsed.type as StepRecordType
  if (!VALID_STEP_TYPES.has(type)) return null

  const verdict = parsed.verdict && parsed.verdict !== 'UNKNOWN' ? parsed.verdict : undefined

  return {
    type,
    ...(verdict !== undefined && { verdict }),
    ...(parsed.sha !== undefined && { sha: parsed.sha }),
    round: parsed.round,
    commentId: comment.id,
    commentBody: comment.body,
    createdAt: comment.created_at,
    reviewer: parsed.reviewer,
    ...(parsed.model !== 'default' && { model: parsed.model }),
    ...(parsed.next_step !== undefined && { next_step: parsed.next_step }),
  }
}

export function commitToRecord(commit: RawPRCommit): StepRecord | null {
  const trailers = parseCommitTrailers(commit.commit.message)
  const step = trailers.get('crosscheck-step') as StepRecordType | undefined
  if (step !== 'fix' && step !== 'conflict-resolve') return null

  const createdAt = commit.commit.committer?.date ?? commit.commit.author?.date
  if (!createdAt) return null

  return {
    type: step,
    pushedSha: commit.sha,
    round: 1,
    commentId: 0,
    commentBody: commit.commit.message,
    createdAt,
    source: 'commit',
    ...(trailers.has('crosscheck-reviewer') && { reviewer: trailers.get('crosscheck-reviewer') }),
    ...(trailers.has('crosscheck-model') && { model: trailers.get('crosscheck-model') }),
  }
}

function parseCommitTrailers(message: string): Map<string, string> {
  const trailers = new Map<string, string>()
  for (const line of message.split('\n')) {
    const match = line.match(/^\s*(Crosscheck-[A-Za-z-]+):\s*(.*?)\s*$/)
    if (match) trailers.set(match[1].toLowerCase(), match[2])
  }
  return trailers
}

async function fetchCommitHistory(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<StepRecord[]> {
  const records: StepRecord[] = []
  let page = 1
  while (true) {
    const commits = await fetchPRCommitPage(owner, repo, prNumber, token, page)
    if (commits.length === 0) break
    for (const commit of commits) {
      const record = commitToRecord(commit)
      if (record) records.push(record)
    }
    if (commits.length < 100) break
    page++
  }
  return records
}

function mergeStepHistory(commentRecords: StepRecord[], commitRecords: StepRecord[]): StepRecord[] {
  const commentedStepShas = new Set(
    commentRecords
      .filter(r => (r.type === 'fix' || r.type === 'conflict-resolve') && r.pushedSha)
      .map(r => r.pushedSha),
  )
  const uniqueCommitRecords = commitRecords.filter(r => !r.pushedSha || !commentedStepShas.has(r.pushedSha))
  return [...commentRecords, ...uniqueCommitRecords]
    .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime())
}

/**
 * Fetch all crosscheck step records from PR comments and crosscheck commit
 * trailers in chronological order.
 * All HTTP calls go through github/client.ts.
 *
 * Fast path (new annotations with next_step):
 *   1. Fetch the last page to find the most recent review/recheck annotation.
 *   2. If it carries next_step, fetch only comments after it (?since=) to check for
 *      trailing fix markers — skipping the entire earlier thread.
 *
 * Full scan fallback (legacy annotations without next_step):
 *   Read all pages from page 1.
 */
export async function fetchStepHistory(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<StepRecord[]> {
  // Fetch the first page to discover total pagination
  const { comments: firstPage, lastPage } = await fetchPRCommentPage(owner, repo, prNumber, token)
  const commitHistory = await fetchCommitHistory(owner, repo, prNumber, token)
  if (firstPage.length === 0) return mergeStepHistory([], commitHistory)

  // ── Fast path ──────────────────────────────────────────────────────────────
  if (lastPage !== null && lastPage > 1) {
    const { comments: tailPage } = await fetchPRCommentPage(owner, repo, prNumber, token, { page: lastPage })
    const anchor = [...tailPage].reverse().find(c => {
      const r = commentToRecord(c)
      return r !== null && (r.type === 'review' || r.type === 'recheck') && r.next_step !== undefined
    })
    if (anchor) {
      const anchorRecord = commentToRecord(anchor)!
      const { comments: sinceComments } = await fetchPRCommentPage(owner, repo, prNumber, token, { since: anchor.created_at })
      const seen = new Set<number>([anchorRecord.commentId])
      const trailing: StepRecord[] = []
      for (const c of sinceComments) {
        if (seen.has(c.id)) continue
        seen.add(c.id)
        const r = commentToRecord(c)
        if (r) trailing.push(r)
      }
      return mergeStepHistory([anchorRecord, ...trailing], commitHistory)
    }
  }

  // ── Full scan fallback ─────────────────────────────────────────────────────
  const allComments: RawPRComment[] = [...firstPage]
  let page = 2
  while (true) {
    const { comments } = await fetchPRCommentPage(owner, repo, prNumber, token, { page })
    if (comments.length === 0) break
    allComments.push(...comments)
    if (comments.length < 100) break
    page++
  }
  const records: StepRecord[] = []
  for (const comment of allComments) {
    const record = commentToRecord(comment)
    if (record) records.push(record)
  }
  return mergeStepHistory(records, commitHistory)
}

/**
 * Given the PR's step history and the current HEAD SHA, determine which workflow
 * step should run next.
 *
 * The algorithm replays the history from the end:
 *  1. No review/recheck on record → start from the first workflow step.
 *  2. Any non-APPROVE review/recheck without a later fix → fix is next.
 *  3. A fix after the last review/recheck → recheck is next.
 *  4. Current SHA has not been analyzed after the initial review → recheck is next.
 *  5. Current SHA already reviewed → walk the workflow steps that follow
 *     and return the first whose `when` condition evaluates to true and
 *     that hasn't already been completed in history.
 */
export function identifyNextWorkflowStep(
  history: StepRecord[],
  steps: WorkflowStep[],
  currentSha: string,
): NextStepResult {
  const reviewHistory = history.filter(r => r.type === 'review' || r.type === 'recheck')
  const hasExistingReview = reviewHistory.length > 0
  const hasFixStep = steps.some(s => s.type === 'fix')
  const hasRecheckStep = steps.some(s => s.type === 'recheck')

  if (!hasExistingReview) {
    const firstStep = firstIncompleteInitialStep(history, steps)
    return { step: firstStep, hasExistingReview: false, round: 1, history }
  }

  const lastReview = reviewHistory[reviewHistory.length - 1]
  const lastReviewIdx = history.lastIndexOf(lastReview)
  const historyAfterReview = history.slice(lastReviewIdx + 1)
  // Only check for explicit fix/conflict-resolve markers after the last review.
  // Do NOT short-circuit based on lastReview.type === 'recheck': after a BLOCK or
  // NEEDS_WORK recheck, fix still needs to run. The fix step's `when` condition
  // (e.g. "review.verdict != 'APPROVE'") correctly gates it on APPROVE alone.
  const lastFixAfterReview = historyAfterReview.filter(r => r.type === 'fix').at(-1)
  const conflictAfterReview = historyAfterReview.some(r => r.type === 'conflict-resolve')
  const fixAfterReview = lastFixAfterReview !== undefined || conflictAfterReview

  // Terminal state: the newest verdict on the PR is APPROVE. Crosscheck is done with this
  // PR — no further step runs, not even on commits pushed after the approval. Re-reviewing
  // post-approval pushes is the one thing this deliberately gives up; a human who wants
  // another pass asks for it explicitly (`ck run <pr-url> --steps review`, which skips
  // history detection entirely).
  // Gated on `fixAfterReview` so work that landed AFTER the approval is still finished:
  // a workflow whose fix step isn't gated on the verdict can push a commit past an
  // APPROVE, and that commit still needs its recheck.
  if (lastReview.verdict === 'APPROVE' && !fixAfterReview) {
    return { step: null, stopReason: 'approved', hasExistingReview: true, round: lastReview.round, history }
  }

  // Build synthetic results so evaluateWhen works correctly for downstream steps.
  // Always populate under the literal key 'review' so conditions like
  // "review.verdict != 'APPROVE'" work regardless of the step's name in the workflow.
  const syntheticResults: Record<string, StepResult> = {
    review: { verdict: lastReview.verdict },
  }
  const reviewStepDef = steps.find(s => s.type === 'review' || s.type === 'recheck')
  if (reviewStepDef && reviewStepDef.name !== 'review') {
    syntheticResults[reviewStepDef.name] = { verdict: lastReview.verdict }
  }
  if (fixAfterReview) {
    syntheticResults['fix'] = { applied_count: 1 }
    const fixStepDef = steps.find(s => s.type === 'fix')
    if (fixStepDef && fixStepDef.name !== 'fix') syntheticResults[fixStepDef.name] = { applied_count: 1 }
  }

  const reviewComment = { id: lastReview.commentId, body: lastReview.commentBody }

  const reviewedCurrentSha = lastReview.sha !== undefined && lastReview.sha === currentSha
  const fixedCurrentSha = lastFixAfterReview?.pushedSha !== undefined && lastFixAfterReview.pushedSha === currentSha

  if (fixedCurrentSha) {
    return {
      step: effectiveRecheckStep(steps),
      reviewComment,
      hasExistingReview: true,
      round: lastReview.round,
      history,
    }
  }

  if (lastFixAfterReview !== undefined && !fixedCurrentSha) {
    const reviewStep = steps.find(s => s.type === 'review') ?? steps[0] ?? null
    return {
      step: reviewStep,
      hasExistingReview: true,
      round: lastReview.round + 1,
      history,
    }
  }

  const fixStep = firstRunnableFixStep(steps, syntheticResults)
  if (fixStep) {
    return {
      step: fixStep,
      reviewComment,
      hasExistingReview: true,
      round: lastReview.round,
      history,
    }
  }

  if (!reviewedCurrentSha) {
    // A new (unreviewed) SHA has appeared since the last review. In a recheck-no-fix
    // workflow (e.g. `review,recheck`) crosscheck never auto-fixes, so a human pushing
    // their own fix commits is the expected trigger: re-evaluate the new code against
    // the prior review (a recheck) instead of starting an unrelated fresh review. When
    // the workflow has a fix step, keep the fresh-review behaviour so the auto-fix loop
    // re-engages on the new SHA.
    //
    // Only when the prior review left unresolved work. An APPROVE normally stops the
    // workflow above; it reaches here only when a conflict-resolve landed after the
    // approval, and a recheck — whose instructions centre on resolving the original
    // review — has no findings to re-evaluate. That merge gets a fresh review instead.
    if (hasRecheckStep && !hasFixStep && lastReview.verdict !== 'APPROVE') {
      return {
        step: effectiveRecheckStep(steps),
        reviewComment,
        hasExistingReview: true,
        round: lastReview.round + 1,
        history,
      }
    }
    const reviewStep = steps.find(s => s.type === 'review') ?? steps[0] ?? null
    return {
      step: reviewStep,
      hasExistingReview: true,
      round: lastReview.round + 1,
      history,
    }
  }

  // Current SHA has been reviewed — find the first incomplete step that follows
  let passedReview = false
  for (const step of steps) {
    if (step.type === 'review' || step.type === 'recheck') {
      passedReview = true
      continue // done for this sha
    }
    if (!passedReview) continue
    if (step.when && !evaluateWhen(step.when, syntheticResults)) continue

    if (step.type === 'fix') {
      if (fixAfterReview) {
        syntheticResults[step.name] = { applied_count: 1 }
        syntheticResults['fix'] = { applied_count: 1 }
        continue // already ran
      }
      return {
        step,
        reviewComment: { id: lastReview.commentId, body: lastReview.commentBody },
        hasExistingReview: true,
        round: lastReview.round,
        history,
      }
    }

    if (step.type === 'conflict-resolve') {
      const conflictDone = historyAfterReview.some(r => r.type === 'conflict-resolve')
      if (conflictDone) continue
      return { step, hasExistingReview: true, round: lastReview.round, history }
    }
  }

  return { step: null, hasExistingReview: true, round: lastReview.round, history }
}

export interface ReviewOnlyDecision {
  /** True when `sha` already has a review/recheck record — the run should be skipped. */
  alreadyReviewed: boolean
  /** True when the most recent review carries APPROVE — crosscheck is done with this PR. */
  approved: boolean
  /** Round number to stamp on the review: highest prior round + 1, or 1 for a never-reviewed PR. */
  round: number
}

// Decision logic for a per-repo review-only workflow (crosscheck alter --review-only),
// which posts reviews but never fixes/rechecks. Unlike identifyNextWorkflowStep, this
// only asks "has this exact SHA already been reviewed?" — it deliberately ignores fix/recheck state,
// so a fix-pushed SHA from another session is treated as new content to review
// (not a recheck) and a SHA already reviewed is skipped. Short/long SHA forms are
// matched by prefix, the same tolerance the issue_comment bridge uses.
export function decideReviewOnly(history: StepRecord[], sha: string): ReviewOnlyDecision {
  const reviews = history.filter(r => r.type === 'review' || r.type === 'recheck')
  const alreadyReviewed = reviews.some(r =>
    r.sha !== undefined && (r.sha.startsWith(sha) || sha.startsWith(r.sha)))
  // An APPROVE on the latest review ends the PR the same way it does in the full
  // workflow — later pushes are not reviewed again.
  const approved = reviews.at(-1)?.verdict === 'APPROVE'
  const maxRound = reviews.reduce((max, r) => Math.max(max, r.round), 0)
  return { alreadyReviewed, approved, round: alreadyReviewed ? maxRound : maxRound + 1 }
}

function firstIncompleteInitialStep(history: StepRecord[], steps: WorkflowStep[]): WorkflowStep | null {
  for (const step of steps) {
    if (step.type === 'conflict-resolve') {
      const conflictDone = history.some(r => r.type === 'conflict-resolve')
      if (!conflictDone) return step
      continue
    }
    return step
  }
  return null
}

function firstRunnableFixStep(
  steps: WorkflowStep[],
  syntheticResults: Record<string, StepResult>,
): WorkflowStep | null {
  for (const step of steps) {
    if (step.type !== 'fix') continue
    if (step.when && !evaluateWhen(step.when, syntheticResults)) continue
    return step
  }
  return null
}

function effectiveRecheckStep(steps: WorkflowStep[]): WorkflowStep {
  const recheckStep = steps.find(s => s.type === 'recheck')
  if (recheckStep) return recheckStep

  const reviewBase = steps.find(s => s.type === 'review')
  return {
    ...(reviewBase ?? { reviewer: 'auto' as const, max_rounds: 1 }),
    name: 'recheck',
    type: 'recheck' as const,
    when: undefined,
    instructions: DEFAULT_RECHECK_INSTRUCTIONS,
  }
}
