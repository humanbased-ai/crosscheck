import { describe, it, expect, vi, beforeEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { ConfigSchema } from '../config/schema.js'
import { runReview } from '../commands/review.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runCodexReview } from '../reviewers/codex.js'
import { postReviewComment } from '../github/client.js'

// `crosscheck review` classifies from its clone the way run and watch do. Only
// the network, the locks, and the vendor CLIs are faked: the clone is a real git
// repo, so classification reads a real `git diff` exactly as it does in production.

const h = vi.hoisted(() => ({
  config: undefined as unknown,
  files: [] as string[],
  withBaseRef: true,
  events: [] as Array<Record<string, unknown>>,
}))

const REVIEW = '## Summary\n\nLooks correct.\n\nVERDICT: APPROVE'

const PR = {
  number: 7,
  title: 'change',
  body: '',
  state: 'open',
  merged: false,
  mergeable: true,
  html_url: 'https://github.com/acme/app/pull/7',
  user: { login: 'dev' },
  labels: [],
  head: { ref: 'feature', sha: 'a'.repeat(40), repo: { full_name: 'acme/app' } },
  base: { ref: 'main', sha: 'b'.repeat(40), repo: { full_name: 'acme/app', default_branch: 'main' } },
}

vi.mock('ora', () => ({
  default: () => {
    const spinner = { text: '', start: () => spinner, succeed: () => spinner, fail: () => spinner, info: () => spinner }
    return spinner
  },
}))

vi.mock('../config/loader.js', async importOriginal => ({
  ...await importOriginal<typeof import('../config/loader.js')>(),
  loadConfig: vi.fn(() => h.config),
  getGithubToken: vi.fn(() => 'test-token'),
}))

vi.mock('../lib/logger.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/logger.js')>(),
  initLogger: vi.fn(),
  log: vi.fn((entry: Record<string, unknown>) => { h.events.push(entry) }),
  logError: vi.fn(),
}))

vi.mock('../github/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../github/client.js')>(),
  createGithubClient: vi.fn(() => ({ rest: { pulls: { get: vi.fn(async () => ({ data: PR })) } } })),
  postReviewComment: vi.fn(async () => 1),
}))

vi.mock('../github/review-status.js', async importOriginal => ({
  ...await importOriginal<typeof import('../github/review-status.js')>(),
  checkRemoteLock: vi.fn(async () => false),
  claimRemoteLock: vi.fn(async () => true),
  releaseRemoteLock: vi.fn(async () => undefined),
  startRemoteLockHeartbeat: vi.fn(() => () => undefined),
}))

vi.mock('../lib/pr-lock.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/pr-lock.js')>(),
  acquirePRLock: vi.fn(() => true),
  releasePRLock: vi.fn(),
}))

vi.mock('../lib/clone.js', async importOriginal => ({
  ...await importOriginal<typeof import('../lib/clone.js')>(),
  clonePRForReview: vi.fn(async ({ tmpDir }: { tmpDir: string }) => {
    buildClone(tmpDir)
    return { baseRefStatus: 'fetched' }
  }),
}))

vi.mock('../reviewers/claude.js', async importOriginal => ({
  ...await importOriginal<typeof import('../reviewers/claude.js')>(),
  runClaudeReview: vi.fn(async () => ({ review: REVIEW, model: 'claude-opus-5', effort: 'high' })),
}))

vi.mock('../reviewers/codex.js', async importOriginal => ({
  ...await importOriginal<typeof import('../reviewers/codex.js')>(),
  runCodexReview: vi.fn(async () => ({ review: REVIEW, model: 'gpt-5.6-sol', effort: 'high' })),
}))

// A PR clone as clone.ts leaves it: the base at refs/remotes/origin/main and the
// PR's changes on HEAD. Leaving out the base ref makes the diff unreadable.
function buildClone(dir: string): void {
  const git = (...args: string[]): void => {
    execFileSync('git', args, { cwd: dir, stdio: ['ignore', 'pipe', 'pipe'] })
  }
  const commit = (message: string): void => {
    git('-c', 'user.email=t@e.co', '-c', 'user.name=T', '-c', 'commit.gpgsign=false', 'commit', '-q', '-m', message)
  }
  git('init', '-q', '-b', 'feature')
  writeFileSync(join(dir, 'seed.txt'), 'seed\n')
  git('add', '.')
  commit('base')
  if (h.withBaseRef) git('update-ref', 'refs/remotes/origin/main', 'HEAD')
  for (const file of h.files) {
    mkdirSync(join(dir, dirname(file)), { recursive: true })
    writeFileSync(join(dir, file), 'export const changed = 1\n')
  }
  git('add', '.')
  commit('change')
}

const eventsNamed = (name: string): Array<Record<string, unknown>> => h.events.filter(e => e.event === name)
const printed = (): string => vi.mocked(console.log).mock.calls.map(args => args.join(' ')).join('\n')
const claudeCall = () => vi.mocked(runClaudeReview).mock.calls[0]
const codexCall = () => vi.mocked(runCodexReview).mock.calls[0]
// postReviewComment's trailing parameter is the strategy citation.
const citation = () => vi.mocked(postReviewComment).mock.calls[0][19]

const review = (reviewer: 'claude' | 'codex' = 'claude'): Promise<void> =>
  runReview('https://github.com/acme/app/pull/7', undefined, reviewer, true)

beforeEach(() => {
  vi.clearAllMocks()
  h.events = []
  h.withBaseRef = true
  h.config = ConfigSchema.parse({ quality: { mode: 'smart', tier: 'balanced', review_memory: false } })
  vi.spyOn(console, 'log').mockImplementation(() => undefined)
})

describe('crosscheck review under quality.mode: smart', () => {
  it('reviews a standard PR at the standard class tier and cites it', async () => {
    h.files = ['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts']
    await review()

    const [, , , quality, vendor] = claudeCall()
    expect(quality.tier).toBe('balanced')
    expect(vendor.effort).toBe('medium')
    expect(citation()).toMatchObject({ classId: 'standard', tier: 'balanced' })
    expect(eventsNamed('strategy_resolved')[0]).toMatchObject({ pr_class: 'standard', tier: 'balanced', effort: 'medium' })
    // The class tier matches the configured one, so nothing was overridden.
    expect(eventsNamed('strategy_overrode_configured_tier')).toHaveLength(0)
  })

  it('promotes a risky PR to thorough with high effort, and cites it', async () => {
    h.files = ['src/auth/session.ts']
    await review()

    const [, , , quality, vendor] = claudeCall()
    expect(quality.tier).toBe('thorough')
    expect(vendor.effort).toBe('high')
    expect(citation()).toMatchObject({ classId: 'risky', tier: 'thorough' })
    expect(eventsNamed('strategy_overrode_configured_tier')[0])
      .toMatchObject({ configured_tier: 'balanced', applied_tier: 'thorough', pr_class: 'risky' })
    expect(printed()).toMatch(/strategy v[\d.]+: risky → thorough tier \(high\)/)
  })

  it('hands the codex reviewer the class tier and effort too', async () => {
    h.files = ['src/auth/session.ts']
    await review('codex')

    const [, , , quality, vendor] = codexCall()
    expect(quality.tier).toBe('thorough')
    expect(vendor.effort).toBe('high')
    expect(citation()).toMatchObject({ classId: 'risky', tier: 'thorough' })
  })

  // The generated class skips a PR under run/watch. This command is an explicit
  // request, so it reviews anyway at the configured tier and records the bypass.
  it('reviews a generated-only PR at the configured tier and logs the bypass', async () => {
    h.config = ConfigSchema.parse({ quality: { mode: 'smart', tier: 'fast', review_memory: false }, vendors: { claude: { effort: 'low' } } })
    h.files = ['package-lock.json']
    await review()

    expect(vi.mocked(runClaudeReview)).toHaveBeenCalledTimes(1)
    const [, , , quality, vendor] = claudeCall()
    expect(quality.tier).toBe('fast')
    expect(vendor.effort).toBe('low')
    expect(eventsNamed('strategy_class_skip_bypassed')[0]).toMatchObject({ pr_class: 'generated' })
    expect(eventsNamed('pr_skipped')).toHaveLength(0)
    expect(printed()).toMatch(/generated would skip this PR .* honouring the explicit review/)
    expect(vi.mocked(postReviewComment)).toHaveBeenCalledTimes(1)
  })

  it('falls back to the configured tier, and says so, when the diff cannot be read', async () => {
    h.withBaseRef = false
    h.files = ['src/auth/session.ts']
    await review()

    const [, , , quality] = claudeCall()
    expect(quality.tier).toBe('balanced')
    expect(citation()).toBeUndefined()
    expect(eventsNamed('strategy_unresolved')[0]).toMatchObject({ reason: 'pr_context_unavailable', fallback_tier: 'balanced' })
  })
})

describe('crosscheck review under quality.mode: fixed', () => {
  it('runs the configured tier and effort, never classifies, and cites nothing', async () => {
    h.config = ConfigSchema.parse({ quality: { mode: 'fixed', tier: 'fast', review_memory: false } })
    h.files = ['src/auth/session.ts']
    await review()

    const [, , , quality, vendor] = claudeCall()
    expect(quality.tier).toBe('fast')
    expect(vendor.effort).toBe('medium')
    expect(citation()).toBeUndefined()
    expect(eventsNamed('strategy_resolved')).toHaveLength(0)
    expect(eventsNamed('strategy_unresolved')).toHaveLength(0)
    expect(printed()).not.toMatch(/strategy v/)
  })
})
