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

/** Why `step` is null. `approved` means HEAD carries an APPROVE verdict — nothing runs until it moves. */
export type WorkflowStopReason = 'approved'

export interface NextStepOptions {
  /**
   * GitHub's `mergeable` for the PR: `false` = conflicted, `true` = merges cleanly,
   * `null`/omitted = GitHub is still computing (or the caller did not ask).
   *
   * A hint, not a verdict. The conflict-resolve step re-checks with its own `pulls.get`
   * and a real merge probe, and skips as `no_conflicts` when it disagrees — so a stale
   * `false` costs one cheap skip, never a wrong resolution.
   */
  mergeable?: boolean | null
}

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

// Whether a recorded SHA refers to the same commit as `currentSha`. Annotations carry
// either the short (7-char) or the full form, so compare by prefix. An absent or empty
// SHA proves nothing and never matches — a record that cannot say which commit it
// describes cannot be used to claim that commit is covered.
//
// The single implementation of this comparison: `decideReviewOnly`, the scan's approval
// check, and kickass's current-head review check all route through it, so they cannot
// drift apart on what "the same commit" means.
export function shaCovers(recordSha: string | undefined, currentSha: string): boolean {
  if (!recordSha || !currentSha) return false
  return recordSha.startsWith(currentSha) || currentSha.startsWith(recordSha)
}

// Exported for human-feedback.ts: the single classifier for "is this comment one
// of crosscheck's own step records" — reused there so a PR reply never gets
// misread as automation, or a crosscheck comment misread as a human opinion.
export function commentToRecord(comment: { id: number; body: string; created_at: string }): StepRecord | null {
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
    // Same as fix_applied: the body embeds the pushed SHA as a full commit URL. Extracting
    // it is what lets mergeStepHistory recognise the commit-trailer record for this same
    // resolution as a duplicate — without it, one resolution is counted twice.
    const shaMatch = comment.body.match(/\/commit\/([0-9a-f]{40})/i)
    const pushedSha = shaMatch ? shaMatch[1] : undefined
    return { type: 'conflict-resolve', round: 1, commentId: comment.id, commentBody: comment.body, createdAt: comment.created_at, ...(pushedSha !== undefined && { pushedSha }) }
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
 * The records a standing-verdict selection needs: at most one — the newest
 * review or recheck that actually carries a verdict — or none if the PR has
 * never been judged. Returned as history so `selectStandingVerdict` stays the
 * single definition of which record governs.
 *
 * `fetchStepHistory` cannot answer this. Its fast path anchors on the newest
 * review/recheck carrying `next_step` and returns that comment plus what
 * followed it — everything step routing needs, and not enough to say what
 * verdict stands. A review that ran and emitted no parseable `VERDICT:` line is
 * exactly such an anchor, so truncating there hides the `BLOCK` still gating
 * the PR behind it, and reports no verdict standing in the one state that most
 * needs saying out loud.
 *
 * Paging backward stops at the first record that carries a verdict, so the
 * answer is complete however far back it sits, while the ordinary case — a
 * verdict on the newest page — costs one request beyond the one that discovers
 * how many pages there are. Commit records are not fetched at all: only review
 * and recheck carry verdicts, and neither is ever reconstructed from a commit
 * trailer, so the commit pagination `fetchStepHistory` pays for is dead weight
 * here.
 *
 * A page the API refuses throws rather than reading as an empty page. An empty
 * read and a failed read mean opposite things to the caller — "no verdict
 * stands" is a claim about the PR, and this function is the only thing standing
 * behind it — so the report falls back to what step detection already read
 * rather than printing a claim built from an error. `fetchStepHistory` keeps
 * treating a failed page as empty: there a failed read degrades to routing a
 * step, not to asserting something untrue, and changing it is a separate
 * decision with its own blast radius.
 */
export async function fetchStandingVerdictRecords(
  owner: string,
  repo: string,
  prNumber: number,
  token: string,
): Promise<StepRecord[]> {
  const first = await fetchPRCommentPage(owner, repo, prNumber, token)
  if (!first.ok) throw new Error(`could not read PR comments for ${owner}/${repo}#${prNumber}`)
  for (let page = first.lastPage ?? 1; page >= 1; page--) {
    let comments = first.comments
    if (page !== 1) {
      const nextPage = await fetchPRCommentPage(owner, repo, prNumber, token, { page })
      if (!nextPage.ok) throw new Error(`could not read PR comments page ${page} for ${owner}/${repo}#${prNumber}`)
      comments = nextPage.comments
    }
    // Comments come back oldest-first within a page, so the last match on the
    // newest page carrying one is the newest verdict on the PR.
    const judged = comments
      .map(commentToRecord)
      .filter((r): r is StepRecord => r !== null && (r.type === 'review' || r.type === 'recheck') && r.verdict !== undefined)
      .at(-1)
    if (judged) return [judged]
  }
  return []
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
  opts: NextStepOptions = {},
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
  // A fix/conflict-resolve recorded after the approval only invalidates it while that
  // commit is still HEAD. Comment history is permanent, but a force-push can drop the
  // commit and put HEAD back on the approved SHA — the record then describes content
  // that no longer exists, and treating it as live work would schedule another pass
  // over the already-approved commit.
  const postApprovalPushCoversHead = historyAfterReview.some(
    r => (r.type === 'fix' || r.type === 'conflict-resolve') && shaCovers(r.pushedSha, currentSha),
  )

  // Conflict-resolve is orthogonal to the review ladder — it answers "can this merge?",
  // not "is this code good?" — so a PR that conflicts because the BASE branch moved must
  // reach it again. Nothing else can offer it once a review exists:
  // `firstIncompleteInitialStep` is gated on there being no review, and the tail loop
  // below only walks steps that FOLLOW review, so a conflict-resolve configured ahead of
  // review (the onboard default ordering) would never run a second time (#282).
  //
  // Checked before the approval stop: an approved PR that can no longer merge is exactly
  // the case where the resolve matters most. The merge commit it pushes moves HEAD off
  // the approved SHA, so the approval lapses and the merged code is reviewed fresh.
  //
  // Only an explicit `false` qualifies — `null` means GitHub is still computing, and
  // acting on unknown would churn. One attempt per review round (`!conflictAfterReview`):
  // a resolve that succeeds pushes a commit that gets reviewed, and that review makes the
  // PR eligible again if it re-conflicts. A resolve that finds nothing to do records
  // nothing, so an unresolvable conflict is re-attempted on later events by design — the
  // step's own `no_conflicts` pre-check keeps that cheap.
  //
  // The round reported here counts conflict-resolve attempts, not review rounds. That is
  // what `max_rounds` means for this step, and inheriting `lastReview.round` would let a
  // PR that has been through several fix→recheck cycles trip `exceedsMaxRounds` and lose
  // conflict resolution entirely — the review ladder's depth says nothing about how many
  // times this branch has needed a merge.
  const conflictResolveStep = steps.find(s => s.type === 'conflict-resolve')
  if (opts.mergeable === false && conflictResolveStep && !conflictAfterReview) {
    // Count distinct resolution commits, not records. A successful resolve leaves both a
    // comment and a commit trailer behind; when either one lacks a SHA the merge cannot
    // dedupe them, and counting records would burn through max_rounds at double rate.
    const attemptShas = new Set<string>()
    let attempts = 0
    for (const r of history) {
      if (r.type !== 'conflict-resolve') continue
      if (r.pushedSha) {
        if (attemptShas.has(r.pushedSha)) continue
        attemptShas.add(r.pushedSha)
      }
      attempts++
    }
    return { step: conflictResolveStep, hasExistingReview: true, round: attempts + 1, history }
  }

  // Terminal state: the newest verdict is APPROVE and it covers the current HEAD. No
  // further step runs — not a recheck, not a re-review — for as long as HEAD stays there.
  //
  // The approval covers a specific commit, not the PR forever. Commits pushed after it
  // materially change what was approved, so they invalidate it and fall through to a
  // fresh review below. A legacy APPROVE carrying no `sha=` cannot prove it covers HEAD,
  // so it falls through too; that one review re-establishes the SHA and the stop.
  //
  // Gated on `postApprovalPushCoversHead` so work that landed AFTER the approval still
  // finishes: a workflow whose fix step isn't gated on the verdict can push a commit past
  // an APPROVE, and that commit still needs its recheck. The gate requires that commit to
  // be the current HEAD, so a stale fix record left behind by a force-push doesn't keep
  // re-opening an approval that still covers HEAD.
  if (lastReview.verdict === 'APPROVE' && !postApprovalPushCoversHead && shaCovers(lastReview.sha, currentSha)) {
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

  // shaCovers, not `===`: annotations carry the short or the long form, and the
  // approval stop above already asks this question that way. Two definitions of
  // "the same commit" in one function is exactly the drift shaCovers exists to
  // prevent.
  const reviewedCurrentSha = shaCovers(lastReview.sha, currentSha)
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

  // A review describes the tree it ran against. Once HEAD moves past that tree the
  // findings may already be resolved — the author fixes their own PR — and running
  // fix against them applies nothing. A no-op fix records nothing on the PR, so the
  // history is unchanged and the next event replays this same decision: the PR sits
  // on a stale verdict forever, burning a vendor call each time, with no step able
  // to advance it (monorepo#2548).
  //
  // The branch above already re-reviews when crosscheck's OWN fix moved HEAD. Who
  // pushed says nothing about whether the reviewed tree still exists, so the same
  // answer applies here; the `!reviewedCurrentSha` branch below is where both land,
  // and it already knows to prefer a recheck in a workflow that cannot fix. One
  // extra review is the price, and unlike the old path it always terminates: the
  // fresh review lands on the new HEAD and the fix loop re-engages from there.
  //
  // Only a review that can PROVE it is stale is diverted. shaCovers treats an absent
  // SHA as proving nothing, and legacy comments carry none — trading their working
  // fix step for a re-review on every push would be a regression, so they keep the
  // old path.
  const reviewSupersededByPush = lastReview.sha !== undefined && !reviewedCurrentSha

  const fixStep = reviewSupersededByPush ? null : firstRunnableFixStep(steps, syntheticResults)
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
    // Only when the prior review left unresolved work. After an APPROVE there are no
    // findings to re-evaluate, so a recheck — whose instructions centre on resolving
    // the original review — could gloss over defects in the newly pushed code. Those
    // pushes get a fresh review instead.
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
  const alreadyReviewed = reviews.some(r => shaCovers(r.sha, sha))
  const maxRound = reviews.reduce((max, r) => Math.max(max, r.round), 0)
  return { alreadyReviewed, round: alreadyReviewed ? maxRound : maxRound + 1 }
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
