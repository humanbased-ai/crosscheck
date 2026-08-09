import { describe, expect, it } from 'vitest'
import { commitToRecord, decideReviewOnly, identifyNextWorkflowStep, type StepRecord } from '../lib/pr-workflow-state.js'
import type { RawPRCommit } from '../github/client.js'
import type { WorkflowStep } from '../lib/workflow.js'

const conflictResolveStep: WorkflowStep = {
  name: 'conflict-resolve',
  type: 'conflict-resolve',
  reviewer: 'origin',
  max_rounds: 1,
  instructions: 'resolve conflicts',
}

const reviewStep: WorkflowStep = {
  name: 'review',
  type: 'review',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'review',
}

const fixStep: WorkflowStep = {
  name: 'fix',
  type: 'fix',
  reviewer: 'origin',
  when: "review.verdict != 'APPROVE'",
  max_rounds: 1,
  instructions: 'fix',
}

const recheckStep: WorkflowStep = {
  name: 'recheck',
  type: 'recheck',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'recheck',
}

const workflow = [conflictResolveStep, reviewStep, fixStep, recheckStep]

function record(overrides: Partial<StepRecord>): StepRecord {
  return {
    type: 'review',
    round: 1,
    commentId: 100,
    commentBody: 'review body',
    createdAt: '2026-06-02T00:00:00Z',
    ...overrides,
  }
}

describe('identifyNextWorkflowStep', () => {
  it('starts with conflict-resolve before the initial review', () => {
    const next = identifyNextWorkflowStep([], workflow, 'head-sha')

    expect(next.step?.type).toBe('conflict-resolve')
    expect(next.round).toBe(1)
  })

  it('runs the initial review after conflict-resolve completes', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'conflict-resolve', commentId: 99 }),
    ], workflow, 'head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(1)
  })

  it('routes a non-APPROVE initial review to fix even when HEAD has moved', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('fix')
    expect(next.reviewComment?.id).toBe(100)
    expect(next.round).toBe(1)
  })

  it('routes a non-APPROVE recheck to fix', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'first-sha' }),
      record({ type: 'fix', commentId: 101 }),
      record({ type: 'recheck', verdict: 'NEEDS_WORK', sha: 'fixed-sha', round: 1, commentId: 102 }),
    ], workflow, 'fixed-sha')

    expect(next.step?.type).toBe('fix')
    expect(next.reviewComment?.id).toBe(102)
    expect(next.round).toBe(1)
  })

  it('routes a non-APPROVE recheck followed by an unannotated HEAD commit to fix', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'first-sha', commentId: 100 }),
      record({ type: 'fix', commentId: 101, pushedSha: 'first-fix-sha' }),
      record({ type: 'recheck', verdict: 'NEEDS_WORK', sha: 'rechecked-sha', round: 7, commentId: 102 }),
    ], workflow, 'new-unannotated-head-sha')

    expect(next.step?.type).toBe('fix')
    expect(next.reviewComment?.id).toBe(102)
    expect(next.round).toBe(7)
  })

  it('routes a current-head fix after review to recheck', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'fix-sha' }),
    ], workflow, 'fix-sha')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(100)
    expect(next.round).toBe(1)
  })

  it('routes a stale fix followed by a new HEAD back to review', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'fix-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })

  it('counts a commit-trailer fix as a completed fix step', () => {
    const fixRecord = commitToRecord({
      sha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      commit: {
        message: [
          '[crosscheck] fix: apply fixes from code review',
          '',
          'Crosscheck-Reviewer: claude',
          'Crosscheck-Model: claude-sonnet-5',
          'Crosscheck-Step: fix',
          'Crosscheck-Service: crosscheck',
        ].join('\n'),
        committer: { date: '2026-06-02T01:08:00Z' },
      },
    } satisfies RawPRCommit)

    expect(fixRecord).toMatchObject({
      type: 'fix',
      pushedSha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      reviewer: 'claude',
      model: 'claude-sonnet-5',
      source: 'commit',
    })

    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      fixRecord!,
    ], workflow, '59abeb630af4efbc874650db88ecf3dcb02724fb')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(100)
  })

  it('routes a commit-trailer fix after a non-APPROVE recheck to recheck', () => {
    const fixRecord = commitToRecord({
      sha: '1851423327a8452ed291f95e162a22f33b0d954a',
      commit: {
        message: [
          'fix credential resubmit evidence projection',
          '',
          'Crosscheck-Reviewer: codex',
          'Crosscheck-Step: fix',
          'Crosscheck-Service: crosscheck',
        ].join('\n'),
        committer: { date: '2026-06-02T02:17:32Z' },
      },
    } satisfies RawPRCommit)

    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'first-sha', commentId: 100 }),
      record({ type: 'fix', commentId: 101, pushedSha: 'first-fix-sha' }),
      record({ type: 'recheck', verdict: 'NEEDS_WORK', sha: 'rechecked-sha', round: 7, commentId: 102 }),
      fixRecord!,
    ], workflow, '1851423327a8452ed291f95e162a22f33b0d954a')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(102)
    expect(next.round).toBe(7)
  })

  it('routes a trailer fix followed by another HEAD back to review', () => {
    const fixRecord = commitToRecord({
      sha: '59abeb630af4efbc874650db88ecf3dcb02724fb',
      commit: {
        message: [
          '[crosscheck] fix: apply fixes from code review',
          '',
          'Crosscheck-Reviewer: claude',
          'Crosscheck-Model: claude-sonnet-5',
          'Crosscheck-Step: fix',
          'Crosscheck-Service: crosscheck',
        ].join('\n'),
        committer: { date: '2026-06-02T01:08:00Z' },
      },
    } satisfies RawPRCommit)

    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'reviewed-sha' }),
      fixRecord!,
    ], workflow, 'later-human-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })

  // An APPROVE ends the workflow for the commit it covers. It does NOT end it for the
  // PR: a later push materially changes what was approved, so the approval no longer
  // applies and the new code is reviewed.
  it('stops on the approved SHA', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
    ], workflow, 'approved-sha')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  it('stops when the APPROVE came from a recheck on the current SHA', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'sha-A' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'sha-B' }),
      record({ type: 'recheck', verdict: 'APPROVE', sha: 'sha-B', round: 2, commentId: 102 }),
    ], workflow, 'sha-B')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  it('matches the approved SHA in short and long form', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'abc1234' }),
    ], workflow, 'abc1234def5678')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  it('reviews a new HEAD pushed after APPROVE — the approval no longer covers it', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
    expect(next.stopReason).toBeUndefined()
  })

  it('reviews a new HEAD pushed after an APPROVE recheck', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'sha-A' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'sha-B' }),
      record({ type: 'recheck', verdict: 'APPROVE', sha: 'sha-B', round: 2, commentId: 102 }),
    ], workflow, 'sha-C')

    expect(next.step?.type).toBe('review')
    expect(next.stopReason).toBeUndefined()
  })

  // A legacy APPROVE predates the `sha=` annotation field, so it cannot prove it covers
  // HEAD. Fail open and review — that review records a SHA and re-establishes the stop.
  it('reviews when an APPROVE carries no SHA', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE' }),
    ], workflow, 'head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.stopReason).toBeUndefined()
  })

  // The stop gate must not swallow work that landed AFTER the approval. A workflow whose
  // fix step is not gated on the verdict can push a commit past an APPROVE; that commit
  // still has to be rechecked.
  it('still rechecks a fix that landed after an APPROVE', () => {
    const ungatedFix: WorkflowStep = { ...fixStep, when: undefined }
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'fix-sha' }),
    ], [reviewStep, ungatedFix, recheckStep], 'fix-sha')

    expect(next.step?.type).toBe('recheck')
    expect(next.stopReason).toBeUndefined()
  })

  // The post-approval exception is scoped to the pushed commit, not to the record. A
  // force-push can drop the fix commit and put HEAD back on the approved SHA; the record
  // then describes content that no longer exists, so the approval stands.
  it('stops when a post-approval fix was force-pushed away', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
      record({ type: 'fix', commentId: 101, pushedSha: 'dropped-sha' }),
    ], workflow, 'approved-sha')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  // A fix that pushed nothing to the PR head (pull_request delivery puts it on its own
  // branch) leaves HEAD as the approved content, so the approval still stands.
  it('stops when a post-approval fix record has no pushed SHA', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
      record({ type: 'fix', commentId: 101 }),
    ], workflow, 'approved-sha')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  it('does not stop on a NEEDS_WORK verdict', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'sha-A' }),
    ], workflow, 'sha-A')

    expect(next.step?.type).toBe('fix')
    expect(next.stopReason).toBeUndefined()
  })

  // recheck-no-fix mode (per-repo `review,recheck`): crosscheck never auto-fixes, so a
  // human pushing their own fix commits is the trigger to re-evaluate — as a recheck
  // against the prior review, not a fresh review.
  const reviewRecheckWorkflow = [reviewStep, recheckStep]

  it('routes a human-pushed SHA to recheck (not review) in a recheck-no-fix workflow', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'sha-A' }),
    ], reviewRecheckWorkflow, 'sha-B')

    expect(next.step?.type).toBe('recheck')
    expect(next.reviewComment?.id).toBe(100) // links back to the original review
    expect(next.round).toBe(2)
  })

  it('completes once the human-pushed SHA has been rechecked (recheck-no-fix)', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'sha-A' }),
      record({ type: 'recheck', verdict: 'NEEDS_WORK', sha: 'sha-B', round: 2, commentId: 102 }),
    ], reviewRecheckWorkflow, 'sha-B')

    expect(next.step).toBeNull()
  })

  // After an APPROVE there are no findings left to re-evaluate, so a push of NEW code
  // must get a fresh review — a recheck would judge it against a resolved review and
  // could gloss over defects the new commits introduced.
  it('routes a post-APPROVE push to a fresh review, not a recheck (recheck-no-fix)', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'sha-A' }),
    ], reviewRecheckWorkflow, 'sha-B')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })

  it('stops on the approved SHA (recheck-no-fix)', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'sha-A' }),
    ], reviewRecheckWorkflow, 'sha-A')

    expect(next.step).toBeNull()
    expect(next.stopReason).toBe('approved')
  })

  it('still rechecks a post-BLOCK push (recheck-no-fix)', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'BLOCK', sha: 'sha-A' }),
    ], reviewRecheckWorkflow, 'sha-B')

    expect(next.step?.type).toBe('recheck')
  })

  // An APPROVE recorded by a recheck ends the cycle just like an APPROVE review does.
  it('routes a push after an APPROVE recheck to a fresh review (recheck-no-fix)', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'sha-A' }),
      record({ type: 'recheck', verdict: 'APPROVE', sha: 'sha-B', round: 2, commentId: 102 }),
    ], reviewRecheckWorkflow, 'sha-C')

    expect(next.step?.type).toBe('review')
  })
})

// A per-repo review-only workflow (crosscheck alter --review-only) uses decideReviewOnly
// (NOT identifyNextWorkflowStep) so it can never advance to fix/recheck. These cases lock
// the behaviors that mode depends on: review a fresh PR, skip an already-reviewed SHA,
// re-review a new SHA, and — critically — treat a fix-pushed SHA from another session as
// new content to review rather than mistaking it for a recheck (the fixedCurrentSha bypass).
describe('decideReviewOnly (per-repo review-only)', () => {
  it('reviews a fresh PR at round 1', () => {
    expect(decideReviewOnly([], 'head-sha')).toEqual({ alreadyReviewed: false, round: 1 })
  })

  // Review-only needs no separate approval stop: the approved SHA is by definition an
  // already-reviewed SHA (skipped), and a SHA pushed after the approval is new content.
  it('skips the approved SHA and reviews the one pushed after it', () => {
    const history = [
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha', round: 1 }),
    ]

    expect(decideReviewOnly(history, 'approved-sha').alreadyReviewed).toBe(true)
    expect(decideReviewOnly(history, 'later-sha')).toEqual({ alreadyReviewed: false, round: 2 })
  })

  it('skips when the current SHA was already reviewed', () => {
    const decision = decideReviewOnly([
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'reviewed-sha', round: 1 }),
    ], 'reviewed-sha')

    expect(decision.alreadyReviewed).toBe(true)
  })

  it('re-reviews a new SHA at the next round', () => {
    const decision = decideReviewOnly([
      record({ type: 'review', verdict: 'BLOCK', sha: 'old-sha', round: 1 }),
    ], 'new-sha')

    expect(decision).toEqual({ alreadyReviewed: false, round: 2 })
  })

  it('reviews a fix-pushed SHA as new content, not a recheck (fixedCurrentSha bypass)', () => {
    // A prior full-workflow session reviewed sha-A (BLOCK) and pushed a fix to sha-B
    // but never rechecked. decideReviewOnly must REVIEW sha-B (it was never reviewed),
    // not skip it and not treat it as a recheck.
    const decision = decideReviewOnly([
      record({ type: 'review', verdict: 'BLOCK', sha: 'sha-A', round: 1 }),
      record({ type: 'fix', pushedSha: 'sha-B', round: 1, commentId: 101 }),
    ], 'sha-B')

    expect(decision).toEqual({ alreadyReviewed: false, round: 2 })
  })

  it('skips the fix-pushed SHA once it has been reviewed', () => {
    const decision = decideReviewOnly([
      record({ type: 'review', verdict: 'BLOCK', sha: 'sha-A', round: 1 }),
      record({ type: 'fix', pushedSha: 'sha-B', round: 1, commentId: 101 }),
      record({ type: 'review', verdict: 'NEEDS_WORK', sha: 'sha-B', round: 2, commentId: 102 }),
    ], 'sha-B')

    expect(decision.alreadyReviewed).toBe(true)
  })

  it('matches short and long SHA forms by prefix', () => {
    const decision = decideReviewOnly([
      record({ type: 'review', sha: 'abc1234', round: 1 }),
    ], 'abc1234def5678')

    expect(decision.alreadyReviewed).toBe(true)
  })
})
