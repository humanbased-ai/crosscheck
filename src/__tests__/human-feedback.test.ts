import { afterEach, describe, expect, it, vi } from 'vitest'
import { buildAnnotation } from '../lib/annotation.js'
import { fetchCommentsAfter, formatHumanFeedback, selectHumanFeedback } from '../lib/human-feedback.js'
import type { RawPRComment } from '../github/client.js'

function comment(overrides: Partial<RawPRComment> & { login?: string }): RawPRComment {
  const { login = 'alice', ...rest } = overrides
  return {
    id: 1,
    body: 'a comment',
    created_at: '2026-08-20T00:00:00Z',
    user: { login },
    ...rest,
  }
}

const crosscheckReviewComment = comment({
  id: 10,
  login: 'beingzy',
  body: `## Summary\nLooks fine.\n\n${buildAnnotation({
    origin: 'claude', reviewer: 'claude', verdict: 'NEEDS_WORK', type: 'review',
    model: 'sonnet', round: 1, service: 'crosscheck',
  })}`,
})

describe('selectHumanFeedback', () => {
  it('excludes crosscheck\'s own annotated review/recheck/fix comments', () => {
    const humanReply = comment({ id: 11, login: 'hao-li', body: 'already fixed in the last commit' })
    const result = selectHumanFeedback([crosscheckReviewComment, humanReply])
    expect(result).toEqual([{ author: 'hao-li', body: 'already fixed in the last commit' }])
  })

  it('excludes legacy crosscheck review comments with no annotation marker', () => {
    const legacyReview = comment({ id: 12, login: 'beingzy', body: '### Code Review by Claude\n\nVERDICT: APPROVE' })
    const humanReply = comment({ id: 13, login: 'hao-li', body: 'not applicable, skip this one' })
    const result = selectHumanFeedback([legacyReview, humanReply])
    expect(result).toEqual([{ author: 'hao-li', body: 'not applicable, skip this one' }])
  })

  it('keeps a reply from the PR author\'s own coding agent, not just humans', () => {
    const agentReply = comment({ id: 14, login: 'hao-li-claude-bot', body: 'Addressed: renamed the variable per the review.' })
    const result = selectHumanFeedback([agentReply])
    expect(result).toEqual([{ author: 'hao-li-claude-bot', body: 'Addressed: renamed the variable per the review.' }])
  })

  it('returns an empty array when every comment is crosscheck\'s own', () => {
    expect(selectHumanFeedback([crosscheckReviewComment])).toEqual([])
  })
})

describe('formatHumanFeedback', () => {
  it('returns an empty string for no feedback', () => {
    expect(formatHumanFeedback([])).toBe('')
  })

  it('renders each entry under a labeled heading', () => {
    const block = formatHumanFeedback([{ author: 'hao-li', body: 'this finding does not apply here' }])
    expect(block).toContain('## Reply from the PR thread since the last review')
    expect(block).toContain('**@hao-li:**')
    expect(block).toContain('this finding does not apply here')
  })

  it('does not tell the model to treat a reply as an approval instruction', () => {
    const block = formatHumanFeedback([{ author: 'hao-li', body: 'skip it' }])
    expect(block).toContain('use your own judgment')
  })

  it('truncates an oversized feedback thread instead of blowing the prompt budget', () => {
    const hugeBody = 'x'.repeat(10_000)
    const block = formatHumanFeedback([{ author: 'hao-li', body: hugeBody }])
    expect(block.length).toBeLessThan(hugeBody.length)
    expect(block).not.toContain(hugeBody)
  })
})

describe('fetchCommentsAfter', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('paginates and returns only comments newer than the anchor id', async () => {
    const page1 = Array.from({ length: 100 }, (_, i) => comment({ id: i + 1, body: `c${i + 1}` }))
    const page2 = [comment({ id: 101, body: 'c101' }), comment({ id: 102, body: 'c102' })]
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
      .mockResolvedValueOnce(new Response(JSON.stringify(page2), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchCommentsAfter('acme', 'repo', 42, 'token', 99)

    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(result.map(c => c.id)).toEqual([100, 101, 102])
  })

  it('stops after the first short page', async () => {
    const page1 = [comment({ id: 1 }), comment({ id: 2 })]
    const fetchMock = vi.fn().mockResolvedValueOnce(new Response(JSON.stringify(page1), { status: 200 }))
    vi.stubGlobal('fetch', fetchMock)

    const result = await fetchCommentsAfter('acme', 'repo', 42, 'token', 0)

    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(result).toHaveLength(2)
  })
})
