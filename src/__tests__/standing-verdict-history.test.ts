import { beforeEach, describe, expect, it, vi } from 'vitest'
import { buildAnnotation } from '../lib/annotation.js'
import type { RawPRComment } from '../github/client.js'

const fetchPRCommentPage = vi.fn()
const fetchPRCommitPage = vi.fn()

vi.mock('../github/client.js', () => ({
  fetchPRCommentPage: (...args: unknown[]) => fetchPRCommentPage(...args),
  fetchPRCommitPage: (...args: unknown[]) => fetchPRCommitPage(...args),
}))

const { fetchStandingVerdictRecords } = await import('../lib/pr-workflow-state.js')

function review(id: number, opts: { verdict: string; sha?: string; type?: 'review' | 'recheck'; next_step?: string }): RawPRComment {
  return {
    id,
    body: `### Code Review by 🤖 Claude Code\n\nSummary.\n\n${buildAnnotation({
      origin: 'claude',
      reviewer: 'claude',
      model: 'sonnet',
      type: opts.type ?? 'review',
      round: 1,
      verdict: opts.verdict,
      service: 'crosscheck',
      ...(opts.sha !== undefined && { sha: opts.sha }),
      ...(opts.next_step !== undefined && { next_step: opts.next_step }),
    })}`,
    created_at: `2026-08-2${id % 10}T00:00:00Z`,
    user: { login: 'beingzy' },
    author_association: 'NONE',
  } as RawPRComment
}

/** A review that ran, posted, and recorded no parseable verdict — the record
 *  that step detection's fast path anchors on, and that judges nothing. */
function unjudgedReview(id: number, sha: string): RawPRComment {
  return review(id, { verdict: 'UNKNOWN', sha, next_step: 'fix' })
}

function pages(byPage: Record<number, RawPRComment[]>, lastPage: number | null) {
  fetchPRCommentPage.mockImplementation(async (_o: string, _r: string, _n: number, _t: string, opts: { page?: number } = {}) => ({
    comments: byPage[opts.page ?? 1] ?? [],
    lastPage,
    ok: true,
  }))
}

/** What the client returns for a request GitHub refused. */
const REFUSED = { comments: [], lastPage: null, ok: false }

const OLD_SHA = 'df95a6b1111111111111111111111111111111aa'
const HEAD_SHA = '57ef3ef2d46d35af5b0361b362c8069394d7133c'

beforeEach(() => {
  fetchPRCommentPage.mockReset()
  fetchPRCommitPage.mockReset()
})

describe('fetchStandingVerdictRecords', () => {
  // The regression this function exists for: fetchStepHistory's fast path would
  // anchor on the malformed review and return only it, so the BLOCK still
  // gating the PR would read as "no verdict standing".
  it('finds a blocking verdict on an earlier page behind a malformed review', async () => {
    pages({
      1: [review(1, { verdict: 'NEEDS_WORK', sha: OLD_SHA }), review(2, { verdict: 'BLOCK', sha: OLD_SHA })],
      2: [unjudgedReview(3, HEAD_SHA)],
    }, 2)

    expect(await fetchStandingVerdictRecords('o', 'r', 7, 't')).toMatchObject([
      { type: 'review', verdict: 'BLOCK', sha: OLD_SHA, commentId: 2 },
    ])
  })

  it('takes the newest verdict on the newest page and reads no earlier page', async () => {
    pages({
      1: [review(1, { verdict: 'BLOCK', sha: OLD_SHA })],
      2: [review(2, { verdict: 'NEEDS_WORK', sha: HEAD_SHA }), review(3, { verdict: 'APPROVE', sha: HEAD_SHA, type: 'recheck' })],
    }, 2)

    expect(await fetchStandingVerdictRecords('o', 'r', 7, 't')).toMatchObject([
      { type: 'recheck', verdict: 'APPROVE', sha: HEAD_SHA },
    ])
    // One call to discover the page count, one for the last page. The first
    // page's comments come back with that discovery, so a verdict there costs
    // no third request either.
    expect(fetchPRCommentPage).toHaveBeenCalledTimes(2)
  })

  it('reads a single-page thread without a second request', async () => {
    pages({ 1: [review(1, { verdict: 'BLOCK', sha: OLD_SHA })] }, null)

    expect(await fetchStandingVerdictRecords('o', 'r', 7, 't')).toMatchObject([{ verdict: 'BLOCK' }])
    expect(fetchPRCommentPage).toHaveBeenCalledTimes(1)
  })

  it('returns nothing when the PR has never been judged', async () => {
    pages({ 1: [unjudgedReview(1, HEAD_SHA)], 2: [unjudgedReview(2, HEAD_SHA)] }, 2)

    expect(await fetchStandingVerdictRecords('o', 'r', 7, 't')).toEqual([])
  })

  it('returns nothing on an empty thread', async () => {
    pages({}, null)

    expect(await fetchStandingVerdictRecords('o', 'r', 7, 't')).toEqual([])
  })

  // An empty read and a failed read mean opposite things: the caller falls back
  // to the pre-run selection on a throw, and would print "no verdict standing"
  // on an empty array.
  it('throws rather than reporting no verdict when the thread cannot be read', async () => {
    fetchPRCommentPage.mockResolvedValue(REFUSED)

    await expect(fetchStandingVerdictRecords('o', 'r', 7, 't')).rejects.toThrow(/could not read PR comments/)
  })

  it('throws when an earlier page fails mid-scan', async () => {
    pages({ 1: [review(1, { verdict: 'BLOCK', sha: OLD_SHA })], 2: [unjudgedReview(2, HEAD_SHA)] }, 2)
    fetchPRCommentPage.mockImplementationOnce(async () => ({ comments: [], lastPage: 2, ok: true }))
      .mockImplementationOnce(async () => REFUSED)

    await expect(fetchStandingVerdictRecords('o', 'r', 7, 't')).rejects.toThrow(/page 2/)
  })

  // Only review and recheck carry verdicts, so the commit pagination
  // fetchStepHistory pays for is dead weight here.
  it('never fetches PR commits', async () => {
    pages({ 1: [review(1, { verdict: 'BLOCK', sha: OLD_SHA })] }, null)

    await fetchStandingVerdictRecords('o', 'r', 7, 't')
    expect(fetchPRCommitPage).not.toHaveBeenCalled()
  })
})
