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

  it('uses review rather than recheck when a new HEAD appears after APPROVE', () => {
    const next = identifyNextWorkflowStep([
      record({ type: 'review', verdict: 'APPROVE', sha: 'approved-sha' }),
    ], workflow, 'new-head-sha')

    expect(next.step?.type).toBe('review')
    expect(next.round).toBe(2)
  })
})

// crosscheck watch --only-review uses decideReviewOnly (NOT identifyNextWorkflowStep)
// so it can never advance to fix/recheck. These cases lock the behaviors that mode
// depends on: review a fresh PR, skip an already-reviewed SHA, re-review a new SHA,
// and — critically — treat a fix-pushed SHA from another session as new content to
// review rather than mistaking it for a recheck (the fixedCurrentSha bypass).
describe('decideReviewOnly (--only-review)', () => {
  it('reviews a fresh PR at round 1', () => {
    expect(decideReviewOnly([], 'head-sha')).toEqual({ alreadyReviewed: false, round: 1 })
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
    // A prior non-only-review session reviewed sha-A (BLOCK) and pushed a fix to sha-B
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
