import { describe, it, expect, vi } from 'vitest'
import {
  autoFixBranchName,
  autoFixPRIntro,
  isCrosscheckAutoFixPR,
  buildSupersededComment,
  closeSupersededAutoFixPRs,
} from '../github/superseded-fix-pr.js'

const OWNER = 'humanbased-ai'
const REPO = 'monorepo'
// The pair from the reported regression: #2527 merged as 8ae3dc694, and the auto-fix
// PR #2532 cut from its pre-fix state stayed open and mergeable.
const SOURCE_PR = 2527
const FIX_PR = 2532
const MERGE_SHA = '8ae3dc694b1f2a3c5d7e9f0a1b2c3d4e5f60718a'

interface OctokitStubOptions {
  open?: Array<{ number: number; body: string | null }>
  listError?: unknown
  commentError?: unknown
  updateError?: unknown
}

function makeOctokit(options: OctokitStubOptions = {}) {
  const list = vi.fn(async () => {
    if (options.listError) throw options.listError
    return { data: options.open ?? [] }
  })
  const createComment = vi.fn(async () => {
    if (options.commentError) throw options.commentError
    return { data: { id: 1 } }
  })
  const update = vi.fn(async () => {
    if (options.updateError) throw options.updateError
    return { data: {} }
  })
  return {
    octokit: {
      rest: { pulls: { list, update }, issues: { createComment } },
    } as never,
    list,
    createComment,
    update,
  }
}

function autoFixPR(number = FIX_PR, sourcePrNumber = SOURCE_PR) {
  return {
    number,
    body: [
      autoFixPRIntro(sourcePrNumber),
      '',
      `Review: https://github.com/${OWNER}/${REPO}/pull/${sourcePrNumber}`,
    ].join('\n'),
  }
}

describe('autoFixBranchName', () => {
  it('matches the branch the fix step pushes', () => {
    expect(autoFixBranchName(SOURCE_PR)).toBe('fix/cr-2527-review-issues')
  })
})

describe('isCrosscheckAutoFixPR', () => {
  it('recognises the body the fix step writes', () => {
    expect(isCrosscheckAutoFixPR(autoFixPR().body, SOURCE_PR)).toBe(true)
  })

  it('rejects a body naming a different source PR', () => {
    expect(isCrosscheckAutoFixPR(autoFixPR(FIX_PR, 2444).body, SOURCE_PR)).toBe(false)
  })

  it('rejects a hand-written PR that only shares the branch name', () => {
    expect(isCrosscheckAutoFixPR('Picking up the review findings from #2527 by hand.', SOURCE_PR)).toBe(false)
  })

  it('rejects an empty body', () => {
    expect(isCrosscheckAutoFixPR(null, SOURCE_PR)).toBe(false)
  })
})

describe('buildSupersededComment', () => {
  it('names the merged source PR and links the merge commit', () => {
    const body = buildSupersededComment({ owner: OWNER, repo: REPO, sourcePrNumber: SOURCE_PR, mergeCommitSha: MERGE_SHA })

    expect(body).toContain('Superseded')
    expect(body).toContain(`#${SOURCE_PR} merged`)
    expect(body).toContain(`https://github.com/${OWNER}/${REPO}/commit/${MERGE_SHA}`)
  })

  it('omits the merge link when the merge commit is unknown', () => {
    const body = buildSupersededComment({ owner: OWNER, repo: REPO, sourcePrNumber: SOURCE_PR, mergeCommitSha: null })

    expect(body).toContain(`#${SOURCE_PR} merged,`)
    expect(body).not.toContain('/commit/')
  })
})

describe('closeSupersededAutoFixPRs', () => {
  it('comments then closes the auto-fix PR cut from the merged PR', async () => {
    const { octokit, list, createComment, update } = makeOctokit({ open: [autoFixPR()] })

    const outcomes = await closeSupersededAutoFixPRs(octokit, OWNER, REPO, SOURCE_PR, MERGE_SHA)

    expect(outcomes).toEqual([{ prNumber: FIX_PR, status: 'closed' }])
    expect(list).toHaveBeenCalledWith({
      owner: OWNER, repo: REPO, state: 'open', head: `${OWNER}:fix/cr-2527-review-issues`,
    })
    expect(createComment).toHaveBeenCalledWith(expect.objectContaining({
      issue_number: FIX_PR,
      body: expect.stringContaining('Superseded'),
    }))
    expect(update).toHaveBeenCalledWith({ owner: OWNER, repo: REPO, pull_number: FIX_PR, state: 'closed' })
    // The reason must land before the PR closes, or a reader sees a bare closed PR.
    expect(createComment.mock.invocationCallOrder[0]).toBeLessThan(update.mock.invocationCallOrder[0])
  })

  it('returns no outcomes when the merged PR had no auto-fix PR', async () => {
    const { octokit, update } = makeOctokit({ open: [] })

    const outcomes = await closeSupersededAutoFixPRs(octokit, OWNER, REPO, SOURCE_PR, MERGE_SHA)

    expect(outcomes).toEqual([])
    expect(update).not.toHaveBeenCalled()
  })

  it('leaves a PR crosscheck did not author open', async () => {
    const { octokit, createComment, update } = makeOctokit({
      open: [{ number: 2540, body: 'Manual follow-up on the same branch name.' }],
    })

    const outcomes = await closeSupersededAutoFixPRs(octokit, OWNER, REPO, SOURCE_PR, MERGE_SHA)

    expect(outcomes).toEqual([{ prNumber: 2540, status: 'not_crosscheck' }])
    expect(createComment).not.toHaveBeenCalled()
    expect(update).not.toHaveBeenCalled()
  })

  it('reports a close failure instead of throwing', async () => {
    const { octokit } = makeOctokit({ open: [autoFixPR()], updateError: new Error('Resource not accessible by integration') })

    const outcomes = await closeSupersededAutoFixPRs(octokit, OWNER, REPO, SOURCE_PR, MERGE_SHA)

    expect(outcomes).toEqual([
      { prNumber: FIX_PR, status: 'failed', reason: 'Resource not accessible by integration' },
    ])
  })

  it('does not close the PR when the superseded comment could not be posted', async () => {
    const { octokit, update } = makeOctokit({ open: [autoFixPR()], commentError: new Error('403 Forbidden') })

    const outcomes = await closeSupersededAutoFixPRs(octokit, OWNER, REPO, SOURCE_PR, MERGE_SHA)

    expect(outcomes[0].status).toBe('failed')
    expect(update).not.toHaveBeenCalled()
  })
})
