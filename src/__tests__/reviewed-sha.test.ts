import { describe, it, expect, vi } from 'vitest'
import { verifyReviewedSha, isVerifiedReviewedSha, reviewedShaRejection } from '../github/reviewed-sha.js'

const HEAD_SHA = 'e20470fd4e33bc1d83db776556359bb8ff30bb31'
// The sha the recheck on monorepo#2444 stamped: a clone-local fix commit whose push
// never landed, so it resolves nowhere in the repository.
const PHANTOM_SHA = 'db266729cc9af2fd504379206094dbba0729a1b2'

interface OctokitStubOptions {
  headSha?: string
  pullsGetError?: unknown
  compareStatus?: 'ahead' | 'behind' | 'identical' | 'diverged'
  compareError?: unknown
}

function makeOctokit(options: OctokitStubOptions = {}) {
  const get = vi.fn(async () => {
    if (options.pullsGetError) throw options.pullsGetError
    return { data: { head: { sha: options.headSha ?? HEAD_SHA } } }
  })
  const compareCommits = vi.fn(async () => {
    if (options.compareError) throw options.compareError
    return { data: { status: options.compareStatus ?? 'ahead' } }
  })
  return {
    octokit: { rest: { pulls: { get }, repos: { compareCommits } } } as never,
    get,
    compareCommits,
  }
}

function httpError(status: number, message: string): Error & { status: number } {
  return Object.assign(new Error(message), { status })
}

describe('verifyReviewedSha', () => {
  it('accepts a sha identical to the PR head without comparing commits', async () => {
    const { octokit, compareCommits } = makeOctokit()

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, HEAD_SHA)

    expect(verification).toEqual({ status: 'head', headSha: HEAD_SHA })
    expect(compareCommits).not.toHaveBeenCalled()
  })

  it('accepts a sha the PR head descends from', async () => {
    const parentSha = '68ca46efd0f4b8a1cf3c6d2e5a7b9014d3f8e6a2'
    const { octokit, compareCommits } = makeOctokit({ compareStatus: 'ahead' })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, parentSha)

    expect(verification).toEqual({ status: 'ancestor', headSha: HEAD_SHA })
    expect(compareCommits).toHaveBeenCalledWith({
      owner: 'humanbased-ai', repo: 'monorepo', base: parentSha, head: HEAD_SHA,
    })
  })

  it('accepts a short sha that resolves to the head commit', async () => {
    const { octokit } = makeOctokit({ compareStatus: 'identical' })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, 'e20470fd4')

    expect(verification.status).toBe('ancestor')
  })

  it('rejects a sha that does not resolve in the repository', async () => {
    const { octokit } = makeOctokit({ compareError: httpError(404, 'Not Found') })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, PHANTOM_SHA)

    expect(verification).toEqual({ status: 'unknown_commit', headSha: HEAD_SHA })
    expect(isVerifiedReviewedSha(verification.status)).toBe(false)
  })

  it('rejects a sha sharing no history with the PR head', async () => {
    const { octokit } = makeOctokit({ compareStatus: 'diverged' })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, PHANTOM_SHA)

    expect(verification.status).toBe('diverged')
    expect(isVerifiedReviewedSha(verification.status)).toBe(false)
  })

  it('accepts a fix commit pushed to the auto-fix branch, which descends from the PR head', async () => {
    const fixBranchSha = 'e358bdba70c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5'
    const { octokit } = makeOctokit({ compareStatus: 'behind' })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, fixBranchSha)

    expect(verification.status).toBe('descendant')
    expect(isVerifiedReviewedSha(verification.status)).toBe(true)
  })

  it('compares against the freshly-read head, not a head passed in by the caller', async () => {
    const pushedHead = '8ae3dc694b1f2a3c5d7e9f0a1b2c3d4e5f60718a'
    const { octokit, compareCommits } = makeOctokit({ headSha: pushedHead, compareStatus: 'ahead' })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, HEAD_SHA)

    expect(verification.headSha).toBe(pushedHead)
    expect(compareCommits).toHaveBeenCalledWith(expect.objectContaining({ head: pushedHead }))
  })

  it('reports unverifiable when the PR head cannot be read', async () => {
    const { octokit } = makeOctokit({ pullsGetError: httpError(502, 'Bad Gateway') })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, HEAD_SHA)

    expect(verification).toEqual({ status: 'unverifiable', headSha: null, error: 'Bad Gateway' })
    expect(isVerifiedReviewedSha(verification.status)).toBe(false)
  })

  it('reports unverifiable — not unknown_commit — when the compare call fails non-404', async () => {
    const { octokit } = makeOctokit({ compareError: httpError(500, 'Internal Server Error') })

    const verification = await verifyReviewedSha(octokit, 'humanbased-ai', 'monorepo', 2444, PHANTOM_SHA)

    expect(verification.status).toBe('unverifiable')
    expect(verification.error).toBe('Internal Server Error')
  })
})

describe('isVerifiedReviewedSha', () => {
  it('verifies commits on the PR head line and nothing else', () => {
    expect(isVerifiedReviewedSha('head')).toBe(true)
    expect(isVerifiedReviewedSha('ancestor')).toBe(true)
    expect(isVerifiedReviewedSha('descendant')).toBe(true)
    expect(isVerifiedReviewedSha('unknown_commit')).toBe(false)
    expect(isVerifiedReviewedSha('diverged')).toBe(false)
    expect(isVerifiedReviewedSha('unverifiable')).toBe(false)
  })
})

describe('reviewedShaRejection', () => {
  it('names the verdict, the phantom sha, and the head that would merge', () => {
    const message = reviewedShaRejection(
      { status: 'unknown_commit', headSha: HEAD_SHA },
      PHANTOM_SHA,
      'APPROVE',
    )

    expect(message).toContain('APPROVE not posted')
    expect(message).toContain(PHANTOM_SHA)
    expect(message).toContain(HEAD_SHA)
    expect(message).toContain('never pushed')
  })

  it('explains a diverged sha as code this PR would not merge', () => {
    const message = reviewedShaRejection(
      { status: 'diverged', headSha: HEAD_SHA },
      PHANTOM_SHA,
      'BLOCK',
    )

    expect(message).toContain('BLOCK not posted')
    expect(message).toContain('shares no history')
  })

  it('quotes the API failure when the repository could not be asked', () => {
    const message = reviewedShaRejection(
      { status: 'unverifiable', headSha: null, error: 'Bad Gateway' },
      PHANTOM_SHA,
      null,
    )

    expect(message).toContain('verdict not posted')
    expect(message).toContain('Bad Gateway')
  })
})
