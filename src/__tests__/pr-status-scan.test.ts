import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ConfigSchema } from '../config/schema.js'

vi.mock('../github/client.js', () => ({
  createGithubClient: vi.fn(() => ({})),
  listCheckRuns: vi.fn(),
  listCommitStatuses: vi.fn(),
  listIssueComments: vi.fn(),
  listOpenPRs: vi.fn(),
  listOrgRepos: vi.fn(),
  listPRCommitActivity: vi.fn(),
  listPRReviewComments: vi.fn(),
  listTimelineEvents: vi.fn(),
  listUserRepos: vi.fn(),
}))

vi.mock('../github/merge.js', () => ({
  getPRMergeSummary: vi.fn(),
}))

// Per-repo overrides are files under ~/.crosscheck/workflows/. Stub the lookup so
// the scan sees a review-only override for acme/web-reviewonly without touching disk.
vi.mock('../lib/repo-workflow.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/repo-workflow.js')>('../lib/repo-workflow.js')
  return {
    ...actual,
    getRepoWorkflowStepTypes: vi.fn((owner: string, name: string) =>
      owner === 'acme' && name === 'web-reviewonly' ? ['review'] : undefined),
  }
})

vi.mock('../lib/logger.js', async () => {
  const actual = await vi.importActual<typeof import('../lib/logger.js')>('../lib/logger.js')
  return {
    ...actual,
    logError: vi.fn(),
  }
})

const { scanOpenPRStatuses } = await import('../lib/pr-status.js')
const github = await import('../github/client.js')
const merge = await import('../github/merge.js')
const logger = await import('../lib/logger.js')

const mockListOpenPRs = vi.mocked(github.listOpenPRs)
const mockListIssueComments = vi.mocked(github.listIssueComments)
const mockListPRReviewComments = vi.mocked(github.listPRReviewComments)
const mockListPRCommitActivity = vi.mocked(github.listPRCommitActivity)
const mockListCommitStatuses = vi.mocked(github.listCommitStatuses)
const mockListCheckRuns = vi.mocked(github.listCheckRuns)
const mockListTimelineEvents = vi.mocked(github.listTimelineEvents)
const mockGetPRMergeSummary = vi.mocked(merge.getPRMergeSummary)
const mockLogError = vi.mocked(logger.logError)

function openPR(number: number) {
  return {
    number,
    title: `PR ${number}`,
    author: 'alice',
    headSha: `sha-${number}`,
    headRef: `branch-${number}`,
    headRepo: 'acme/web',
    baseRef: 'main',
    body: null,
    createdAt: '2026-05-27T00:00:00.000Z',
    updatedAt: '2026-05-27T00:00:00.000Z',
    url: `https://github.com/acme/web/pull/${number}`,
  }
}

beforeEach(() => {
  vi.clearAllMocks()
  mockListOpenPRs.mockResolvedValue([])
  mockListIssueComments.mockResolvedValue([])
  mockListPRReviewComments.mockResolvedValue([])
  mockListPRCommitActivity.mockResolvedValue([])
  mockListCommitStatuses.mockResolvedValue([])
  mockListCheckRuns.mockResolvedValue([])
  mockListTimelineEvents.mockResolvedValue([])
  mockGetPRMergeSummary.mockResolvedValue({ mergeable: null, protectedBase: null })
})

describe('scanOpenPRStatuses', () => {
  it('skips one PR when activity aggregation fails and continues scanning the rest', async () => {
    mockListOpenPRs.mockResolvedValue([openPR(1), openPR(2)])
    mockListIssueComments.mockImplementation(async (_owner, _repo, issueNumber) => {
      if (issueNumber === 1) throw new Error('rate limited')
      return []
    })

    const result = await scanOpenPRStatuses(
      ConfigSchema.parse({ repos: [{ owner: 'acme', name: 'web' }] }),
      'token',
      { now: new Date('2026-05-29T00:00:00.000Z'), staleAfterMs: 24 * 60 * 60 * 1000 },
    )

    expect(result.prs.map(pr => pr.number)).toEqual([2])
    expect(result.summary.total).toBe(1)
    expect(mockLogError).toHaveBeenCalledWith(
      expect.objectContaining({ event: 'scan_pr_skipped', owner: 'acme', repo: 'web', pr: 1 }),
      expect.any(Error),
    )
  })

  it('caps concurrent per-PR GitHub activity requests', async () => {
    mockListOpenPRs.mockResolvedValue(Array.from({ length: 20 }, (_, index) => openPR(index + 1)))
    let active = 0
    let maxActive = 0
    mockListIssueComments.mockImplementation(async () => {
      active += 1
      maxActive = Math.max(maxActive, active)
      await new Promise(resolve => setTimeout(resolve, 1))
      active -= 1
      return []
    })

    await scanOpenPRStatuses(
      ConfigSchema.parse({ repos: [{ owner: 'acme', name: 'web' }] }),
      'token',
      { now: new Date('2026-05-29T00:00:00.000Z'), staleAfterMs: 24 * 60 * 60 * 1000 },
    )

    expect(maxActive).toBeLessThanOrEqual(8)
  })

  it('removes disallowed next actions for repo workflow overrides', async () => {
    mockListOpenPRs.mockResolvedValue([openPR(1)])
    mockListIssueComments.mockResolvedValue([{
      body: '<!-- crosscheck: origin=claude reviewer=codex verdict=NEEDS_WORK type=review -->',
      createdAt: '2026-05-27T01:00:00.000Z',
      updatedAt: '2026-05-27T01:00:00.000Z',
    }])

    const result = await scanOpenPRStatuses(
      ConfigSchema.parse({ repos: [{ owner: 'acme', name: 'web-reviewonly' }] }),
      'token',
      { now: new Date('2026-05-29T00:00:00.000Z'), staleAfterMs: 24 * 60 * 60 * 1000 },
    )

    expect(result.prs[0].reviewState).toBe('NEEDS_FIX')
    expect(result.prs[0].nextAction).toBeNull()
    expect(result.summary.actionable).toBe(0)
  })
})
