import { describe, it, expect, vi } from 'vitest'
import { postReviewComment } from '../github/client.js'

function makeOctokit() {
  const createComment = vi.fn().mockResolvedValue({ data: { id: 123 } })
  return {
    octokit: {
      rest: {
        issues: { createComment },
      },
    } as never,
    createComment,
  }
}

describe('postReviewComment', () => {
  it('emits a v2 review annotation even when verdict parsing failed', async () => {
    const { octokit, createComment } = makeOctokit()

    await postReviewComment(
      octokit,
      'owner',
      'repo',
      42,
      'Review body',
      'codex',
      {},
      'claude',
      null,
    )

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining(
        '<!-- crosscheck: origin=claude reviewer=codex model=default type=review round=1 verdict=UNKNOWN service=crosscheck -->',
      ),
    }))
  })

  it('emits type=recheck with the supplied workflow round', async () => {
    const { octokit, createComment } = makeOctokit()

    await postReviewComment(
      octokit,
      'owner',
      'repo',
      42,
      'Recheck body',
      'claude',
      {},
      'codex',
      'APPROVE',
      99,
      true,
      undefined,
      'recheck',
      2,
    )

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining(
        '<!-- crosscheck: origin=codex reviewer=claude model=default type=recheck round=2 verdict=APPROVE service=crosscheck -->',
      ),
    }))
  })

  it('threads model, stepType, and round into the annotation', async () => {
    const { octokit, createComment } = makeOctokit()

    await postReviewComment(
      octokit, 'owner', 'repo', 42, 'Review', 'claude', {}, 'codex', 'NEEDS_WORK',
      undefined, false, 'claude-opus-4-8', 'review', 3,
    )

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('model=claude-opus-4-8 type=review round=3'),
    }))
  })

  it('threads the selected head sha into the annotation when provided', async () => {
    const { octokit, createComment } = makeOctokit()

    await postReviewComment(
      octokit, 'owner', 'repo', 42, 'Review', 'codex', {}, 'claude', 'BLOCK',
      undefined, false, 'gpt-5', 'review', 1, 'abc1234',
    )

    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      body: expect.stringContaining('service=crosscheck sha=abc1234'),
    }))
  })
})
