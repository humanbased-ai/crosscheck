import { describe, expect, it, vi } from 'vitest'
import {
  buildProgressSummary,
  computeLastActive,
  computeTokenTotals,
  derivePRStatus,
  foldPRStatus,
  isStale,
  parseCrosscheckAnnotation,
  type PRStatusComment,
  type PRStatusInput,
  type PRStatusLogEvent,
  type PRStatusPullRequest,
} from '../lib/pr-status.js'

const NOW = Date.parse('2026-05-29T12:00:00.000Z')

function input(overrides: Partial<PRStatusInput> = {}): PRStatusInput {
  return {
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: 'Add dashboard',
    author: 'alice',
    url: 'https://github.com/acme/web/pull/7',
    headSha: 'abc123',
    headRef: 'feature',
    headRepo: 'acme/web',
    baseRef: 'main',
    prUpdatedAt: '2026-05-28T10:00:00.000Z',
    comments: [],
    reviewComments: [],
    commits: [],
    commitStatuses: [],
    checkRuns: [],
    timelineEvents: [],
    logEvents: [],
    ...overrides,
  }
}

const BASE_PR: PRStatusPullRequest = {
  owner: 'acme',
  repo: 'api',
  number: 42,
  title: 'Add scanner',
  author: 'alice',
  headSha: 'abc123',
  headRef: 'feat/scanner',
  headRepo: 'acme/api',
  baseRef: 'main',
  body: null,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:10:00Z',
}

function comment(body: string, createdAt: string): PRStatusComment {
  return { id: 1, body, createdAt, updatedAt: createdAt }
}

function reviewComment(verdict: 'APPROVE' | 'NEEDS_WORK' | 'BLOCK', createdAt: string, type = 'review'): PRStatusComment {
  return comment(
    `### Code Review by ⚡ Codex\n\nBody\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=${verdict} type=${type} -->`,
    createdAt,
  )
}

describe('parseCrosscheckAnnotation', () => {
  it('parses the last footer annotation and normalizes verdict underscores', () => {
    const annotation = parseCrosscheckAnnotation(
      'quoted <!-- crosscheck: fix_applied -->\n\n<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
    )
    expect(annotation).toEqual({
      origin: 'claude',
      reviewer: 'codex',
      verdict: 'NEEDS_WORK',
      type: 'review',
    })
  })

  it('parses bare crosscheck markers', () => {
    expect(parseCrosscheckAnnotation('<!-- crosscheck: fix_applied -->')).toEqual({ marker: 'fix_applied' })
  })

  it('ignores quoted and fenced annotations', () => {
    expect(parseCrosscheckAnnotation([
      'The text mentions `<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->`.',
      '',
      '```',
      '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
      '```',
      '',
      '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
    ].join('\n'))).toEqual({
      origin: 'claude',
      reviewer: 'codex',
      verdict: 'BLOCK',
      type: 'review',
    })
  })
})

describe('derivePRStatus', () => {
  it('marks untouched PRs as NEEDS_REVIEW with UNREVIEWED verdict', () => {
    const status = derivePRStatus(input(), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_REVIEW')
    expect(status.verdict).toBe('UNREVIEWED')
    expect(status.freshness).toBe('stale')
    expect(status.nextAction).toBe('review')
  })

  it('moves to APPROVED stage when the APPROVE covers HEAD', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('APPROVED')
    expect(status.verdict).toBe('APPROVE')
    expect(status.nextAction).toBe('merge')
    expect(status.freshness).toBe('stale')
  })

  // An approval covers a commit, not a PR. Reporting `merge` for an approval that
  // predates the current HEAD would put never-reviewed code in kickass's read-only
  // "needs merge (manual)" list instead of dispatching the review it is owed.
  it('needs review again when the APPROVE covers an older SHA', () => {
    const status = derivePRStatus(input({
      headSha: 'def456',
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_REVIEW')
    expect(status.nextAction).toBe('review')
    // The verdict field still reports the last verdict on record — it is the review
    // state, not the history, that HEAD invalidates.
    expect(status.verdict).toBe('APPROVE')
  })

  // A legacy annotation predates the `sha=` field, so it cannot prove which commit it
  // describes. Fail open: one review re-establishes the SHA and the approval sticks.
  it('needs review again when the APPROVE carries no SHA', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_REVIEW')
    expect(status.nextAction).toBe('review')
  })

  it('matches the approved SHA in short and long form', () => {
    const status = derivePRStatus(input({
      headSha: 'abc123456789abcdef',
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc1234 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.nextAction).toBe('merge')
  })

  // Only APPROVE is SHA-scoped: a stale NEEDS_WORK still means the PR has unresolved
  // findings, and kickass separately demotes a fix to a review when the annotation
  // covers an older SHA.
  it('still reports fix for a NEEDS_WORK that covers an older SHA', () => {
    const status = derivePRStatus(input({
      headSha: 'def456',
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.nextAction).toBe('fix')
  })

  // Logging is on by default, and runWorkflow writes workflow_complete AFTER posting the
  // review comment — so the newest verdict on a freshly approved PR is a SHA-less log
  // entry. Reading the approval SHA from it would fail every check and have scan/kickass
  // re-dispatch approved PRs forever.
  it('stays APPROVED when a newer workflow_complete log follows the approval comment', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T11:00:05.000Z',
        event: 'workflow_complete',
        repo: 'acme/web',
        pr: 7,
        last_verdict: 'APPROVE',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('APPROVED')
    expect(status.nextAction).toBe('merge')
  })

  // The SHA still has to cover HEAD — the log entry must not paper over a later push.
  it('needs review when a workflow_complete log follows an approval of an older SHA', () => {
    const status = derivePRStatus(input({
      headSha: 'def456',
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T11:00:05.000Z',
        event: 'workflow_complete',
        repo: 'acme/web',
        pr: 7,
        last_verdict: 'APPROVE',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_REVIEW')
    expect(status.nextAction).toBe('review')
  })

  // A newer annotation disagreeing with an older APPROVE must win: the approval SHA is
  // read only when the newest verdict-bearing annotation is itself the APPROVE.
  it('does not resurrect an older approval when a newer annotation disagrees', () => {
    const status = derivePRStatus(input({
      comments: [
        {
          body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
          createdAt: '2026-05-27T11:00:00.000Z',
          updatedAt: '2026-05-27T11:00:00.000Z',
        },
        {
          body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review sha=abc123 -->',
          createdAt: '2026-05-27T12:00:00.000Z',
          updatedAt: '2026-05-27T12:00:00.000Z',
        },
      ],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.nextAction).toBe('fix')
  })

  // Fix log events carry no SHA, so one that no longer describes HEAD — force-pushed
  // away, or delivered as its own PR — must not pin an approved commit to NEEDS_RECHECK
  // and have kickass dispatch no-op rechecks at it forever.
  it('stays APPROVED when a post-approval fix left HEAD untouched', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T12:00:00.000Z',
        event: 'fix_complete',
        repo: 'acme/web',
        pr: 7,
        applied_count: 2,
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('APPROVED')
    expect(status.nextAction).toBe('merge')
  })

  // The self-correcting half: a fix that really did change HEAD moves HEAD off the
  // approved SHA, so the approval stops covering it and the recheck is owed again.
  it('needs a recheck when the post-approval fix moved HEAD', () => {
    const status = derivePRStatus(input({
      headSha: 'def456',
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review sha=abc123 -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T12:00:00.000Z',
        event: 'fix_complete',
        repo: 'acme/web',
        pr: 7,
        applied_count: 2,
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_RECHECK')
    expect(status.nextAction).toBe('recheck')
  })

  it('keeps the latest verdict when a newer bare crosscheck marker exists', () => {
    const status = derivePRStatus(input({
      comments: [
        {
          body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
          createdAt: '2026-05-27T11:00:00.000Z',
          updatedAt: '2026-05-27T11:00:00.000Z',
        },
        {
          body: '<!-- crosscheck: fix_applied -->',
          createdAt: '2026-05-27T12:00:00.000Z',
          updatedAt: '2026-05-27T12:00:00.000Z',
        },
      ],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.verdict).toBe('NEEDS_WORK')
    expect(status.nextAction).toBe('fix')
  })

  it('orders annotation verdicts by creation time, not later edits', () => {
    const status = derivePRStatus(input({
      comments: [
        {
          body: '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
          createdAt: '2026-05-27T11:00:00.000Z',
          updatedAt: '2026-05-29T11:30:00.000Z',
        },
        {
          body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
          createdAt: '2026-05-28T11:00:00.000Z',
          updatedAt: '2026-05-28T11:00:00.000Z',
        },
      ],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.verdict).toBe('NEEDS_WORK')
    expect(status.lastActiveAt).toBe('2026-05-29T11:30:00.000Z')
  })

  it('moves to NEEDS_RECHECK when a fix lands after a review', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [{
        ts: '2026-05-27T12:00:00.000Z',
        event: 'fix_complete',
        repo: 'acme/web',
        pr: 7,
        applied_count: 2,
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_RECHECK')
    expect(status.verdict).toBe('NEEDS_WORK')
    expect(status.nextAction).toBe('recheck')
    expect(status.freshness).toBe('stale')
  })

  it('treats same-timestamp fix activity as needing recheck', () => {
    const timestamp = '2026-05-27T11:00:00.000Z'
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: timestamp,
        updatedAt: timestamp,
      }],
      logEvents: [{
        ts: timestamp,
        event: 'fix_complete',
        repo: 'acme/web',
        pr: 7,
        applied_count: 1,
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_RECHECK')
    expect(status.verdict).toBe('NEEDS_WORK')
    expect(status.nextAction).toBe('recheck')
  })

  it('BLOCK verdict lands in NEEDS_FIX stage (severity on verdict field)', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.verdict).toBe('BLOCK')
    expect(status.nextAction).toBe('fix')
    expect(status.freshness).toBe('stale')
  })

  it('keeps NEEDS_FIX stage when no fix has landed yet', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.reviewState).toBe('NEEDS_FIX')
    expect(status.verdict).toBe('NEEDS_WORK')
    expect(status.nextAction).toBe('fix')
    expect(status.freshness).toBe('stale')
  })

  it('uses every activity source when computing last active time', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      commits: [{ sha: 'def456', committedAt: '2026-05-29T11:55:00.000Z' }],
    }), { nowMs: NOW, staleAfterMs: 30 * 60 * 1000 })

    expect(status.lastActiveAt).toBe('2026-05-29T11:55:00.000Z')
    expect(status.freshness).toBe('not_stale')
  })

  it('does not let no-op workflow bookkeeping hide stale actionable PRs', () => {
    const status = derivePRStatus(input({
      comments: [{
        body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
        createdAt: '2026-05-27T11:00:00.000Z',
        updatedAt: '2026-05-27T11:00:00.000Z',
      }],
      logEvents: [
        {
          ts: '2026-05-29T11:55:00.000Z',
          event: 'step_skipped',
          repo: 'acme/web',
          pr: 7,
          reason: 'when_condition',
        },
        {
          ts: '2026-05-29T11:56:00.000Z',
          event: 'comment_posted',
          repo: 'acme/web',
          pr: 7,
        },
      ],
    }), { nowMs: NOW, staleAfterMs: 24 * 60 * 60 * 1000 })

    expect(status.lastActiveAt).toBe('2026-05-28T10:00:00.000Z')
    expect(status.freshness).toBe('stale')
    expect(status.nextAction).toBe('fix')
  })
})

describe('foldPRStatus', () => {
  it('returns NEEDS_REVIEW when there is no crosscheck comment', () => {
    const status = foldPRStatus(BASE_PR, [], [])

    expect(status.state).toBe('NEEDS_REVIEW')
    expect(status.nextAction).toBe('review')
    expect(status.verdict).toBeNull()
  })

  it('returns APPROVED from the latest crosscheck annotation', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T01:00:00Z'),
      reviewComment('APPROVE', '2026-01-01T02:00:00Z', 'recheck'),
    ], [])

    expect(status.state).toBe('APPROVED')
    expect(status.nextAction).toBe('none')
    expect(status.verdict).toBe('APPROVE')
  })

  it('returns NEEDS_RECHECK when NEEDS_WORK has a later fix but no later recheck', () => {
    const logs: PRStatusLogEvent[] = [
      {
        ts: '2026-01-01T03:00:00Z',
        level: 'info',
        event: 'fix_complete',
        repo: 'acme/api',
        pr: 42,
        sha: 'def456',
        applied_count: 3,
        tokens_used: 8400,
      },
    ]

    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T02:00:00Z'),
    ], logs)

    expect(status.state).toBe('NEEDS_RECHECK')
    expect(status.nextAction).toBe('recheck')
    expect(buildProgressSummary(status)).toBe('PR -> CR(NEEDS_WORK) -> Fix(3, 8.4K)')
  })

  it('maps BLOCK verdict to NEEDS_FIX with next action fix', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('BLOCK', '2026-01-01T02:00:00Z'),
    ], [])

    expect(status.state).toBe('NEEDS_FIX')
    expect(status.nextAction).toBe('fix')
    expect(status.verdict).toBe('BLOCK')
  })

  it('ignores quoted annotations and uses the footer annotation', () => {
    const status = foldPRStatus(BASE_PR, [
      comment(
        [
          'The review text mentions `<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->` as an example.',
          '> <!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
          '',
          '```',
          '<!-- crosscheck: origin=claude reviewer=codex verdict=APPROVE type=review -->',
          '```',
          '',
          '<!-- crosscheck: origin=claude reviewer=codex verdict=BLOCK type=review -->',
        ].join('\n'),
        '2026-01-01T02:00:00Z',
      ),
    ], [])

    expect(status.state).toBe('NEEDS_FIX')
    expect(status.verdict).toBe('BLOCK')
  })

  it('builds a capped progress summary with two fix/recheck rounds', () => {
    const status = foldPRStatus(BASE_PR, [
      reviewComment('NEEDS_WORK', '2026-01-01T01:00:00Z'),
      reviewComment('NEEDS_WORK', '2026-01-01T03:00:00Z', 'recheck'),
      reviewComment('APPROVE', '2026-01-01T05:00:00Z', 'recheck'),
    ], [
      { ts: '2026-01-01T02:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 3, tokens_used: 8400 },
      { ts: '2026-01-01T04:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 1, tokens_used: 1200 },
      { ts: '2026-01-01T06:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, applied_count: 2, tokens_used: 2200 },
    ])

    expect(buildProgressSummary(status)).toBe('PR -> CR(NEEDS_WORK) -> Fix(3, 8.4K) -> Recheck(NEEDS_WORK) -> Fix(1, 1.2K) -> Recheck(APPROVE) -> +1 more')
  })
})

describe('stale activity', () => {
  it('uses the latest activity instead of PR creation time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-01-10T00:00:00Z'))
    try {
      const pr: PRStatusPullRequest = {
        ...BASE_PR,
        createdAt: '2025-01-01T00:00:00Z',
        updatedAt: '2025-01-01T00:00:00Z',
        commits: [{ sha: 'abc123', committedAt: '2026-01-09T23:00:00Z' }],
      }
      const status = foldPRStatus(pr, [], [])

      expect(computeLastActive(pr, [], []).toISOString()).toBe('2026-01-09T23:00:00.000Z')
      expect(isStale(status, 2 * 60 * 60 * 1000)).toBe(false)
      expect(isStale(status, 30 * 60 * 1000)).toBe(true)
    } finally {
      vi.useRealTimers()
    }
  })

  it('uses normal PR comments as activity', () => {
    const pr: PRStatusPullRequest = {
      ...BASE_PR,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    }

    expect(computeLastActive(pr, [
      comment('human reply', '2026-01-02T00:00:00Z'),
    ], []).toISOString()).toBe('2026-01-02T00:00:00.000Z')
  })
})

describe('computeTokenTotals', () => {
  it('aggregates review, fix, and recheck tokens per PR and head SHA', () => {
    const totals = computeTokenTotals([
      { ts: '2026-01-01T01:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', step_type: 'review', tokens_used: 1000 },
      { ts: '2026-01-01T02:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42, sha: 'abc123', tokens_used: 2500 },
      { ts: '2026-01-01T03:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', step_type: 'recheck', tokens_used: 1500 },
      { ts: '2026-01-01T04:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/web', pr: 7, tokens_used: 500 },
      { ts: '2026-01-01T05:00:00Z', level: 'info', event: 'fix_complete', repo: 'acme/api', pr: 42 },
    ])

    expect(totals.byPR['acme/api#42']).toEqual({ review: 1000, fix: 2500, recheck: 1500, total: 5000 })
    expect(totals.byPRHeadSha['acme/api#42@abc123']).toEqual({ review: 1000, fix: 2500, recheck: 1500, total: 5000 })
    expect(totals.byPR['acme/web#7']).toEqual({ review: 500, fix: 0, recheck: 0, total: 500 })
  })

  it('counts legacy review_complete logs with type=recheck as recheck tokens', () => {
    const totals = computeTokenTotals([
      { ts: '2026-01-01T01:00:00Z', level: 'info', event: 'review_complete', repo: 'acme/api', pr: 42, sha: 'abc123', type: 'recheck', tokens_used: 700 },
    ])

    expect(totals.byPR['acme/api#42']).toEqual({ review: 0, fix: 0, recheck: 700, total: 700 })
    expect(totals.byPRHeadSha['acme/api#42@abc123']).toEqual({ review: 0, fix: 0, recheck: 700, total: 700 })
  })
})
