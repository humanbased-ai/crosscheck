import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readFileSync, utimesSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareReviewPlan, finishReview, finishReviewOrFallback, savePublishedReview, findingId, assertReviewFresh, STRUCTURED_FALLBACK_WARNING, type ReviewPlan } from '../lib/review-memory.js'

let root: string
let repo: string
function git(...args: string[]): string {
  return execFileSync('git', args, { cwd: repo, encoding: 'utf8', stdio: 'pipe' }).trim()
}
function commit(path = 'screen.ts', content = 'export const label = "updated"'): void {
  mkdirSync(join(repo, path, '..'), { recursive: true })
  writeFileSync(join(repo, path), content)
  git('add', '.'); git('commit', '-qm', 'Update screen')
}
function plan(policy = 'v1', baseBranch = 'staging'): ReviewPlan {
  const p = prepareReviewPlan({ repoDir: repo, subject: 'team/project#1', baseBranch, instructions: 'Review code', policy, root: join(root, 'memory') })
  if (!p) throw new Error('expected a review plan')
  return p
}
const issue = { key: 'missing-label', path: 'screen.ts', line: 1, priority: 'P2' as const,
  title: 'Missing label', trigger: 'Open the screen', impact: 'The control is unnamed', evidence: 'No accessible name is assigned', status: 'open' as const }
function report(findings: unknown[] = [issue]): string { return JSON.stringify({ summary: 'Inspected source; tests not run.', coverage: 'complete', findings }) }
async function published(findings: unknown[] = [issue]): Promise<void> { const p = plan(); await savePublishedReview(p, finishReview(p, report(findings)).snapshot) }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-memory-test-')); repo = join(root, 'repo'); mkdirSync(repo)
  git('init', '-q'); git('config', 'user.name', 'Test Reviewer'); git('config', 'user.email', 'reviewer@example.test')
  commit('screen.ts', 'export const label = "initial"')
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD')
  commit()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('review memory', () => {
  it('keeps first and unpublished reviews full; only published snapshots enable incremental review', async () => {
    const p = plan(); expect(p.mode).toBe('full')
    const finished = finishReview(p, report()); expect(existsSync(p.filename)).toBe(false)
    commit('screen.ts', 'export const label = "third"'); expect(plan().mode).toBe('full')
    await savePublishedReview(p, finished.snapshot)
    const next = plan(); expect(next.mode).toBe('incremental')
    expect(next.instructions).toContain('new regressions'); expect(next.instructions).toContain(issue.key)
  })
  it('skips memory instead of failing when the base ref cannot be resolved', () => {
    expect(prepareReviewPlan({ repoDir: repo, subject: 'team/project#1', baseBranch: 'deleted', instructions: 'Review code', policy: 'v1', root: join(root, 'memory') })).toBeUndefined()
  })
  it.each(['auth/session.ts', 'src/oauth.ts', 'authorization.ts', 'db/migrations/next.sql', 'funding.ts'])('fully reviews sensitive changes: %s', async path => {
    await published(); commit(path); expect(plan().mode).toBe('full'); expect(plan().reason).toContain('sensitive')
  })
  it('does not treat author paths as sensitive', async () => {
    await published(); commit('src/author-card.ts'); expect(plan().mode).toBe('incremental')
  })
  it('fully reviews changed bases, policies and rewritten history', async () => {
    await published(); commit('screen.ts', 'export const label = "third"')
    expect(plan('v2').reason).toBe('review policy changed')
    git('update-ref', 'refs/remotes/origin/staging', 'HEAD'); expect(plan().reason).toBe('base changed')
  })
  it('falls back on rewritten history without suppressing prior open findings', async () => {
    await published(); git('reset', '--hard', 'origin/staging'); commit('screen.ts', 'export const label = "rebased"')
    const p = plan(); expect(p.mode).toBe('full'); expect(p.reason).toContain('rewritten')
    expect(() => finishReview(p, report([]))).toThrow('omitted')
  })
  it('fully reviews large and binary changes and corrupt memory', async () => {
    await published(); commit('screen.ts', Array.from({ length: 650 }, (_, n) => `line ${n}`).join('\n'))
    expect(plan().reason).toContain('large')
    await published(); writeFileSync(join(repo, 'logo.bin'), Buffer.from([0, 1, 2, 0, 255])); git('add', '.'); git('commit', '-qm', 'Logo')
    expect(plan().reason).toBe('binary change')
    writeFileSync(plan().filename, '{broken'); expect(plan().reason).toContain('invalid')
  })
  it('reviews an empty descendant commit incrementally', async () => {
    await published(); git('commit', '-q', '--allow-empty', '-m', 'Empty'); expect(plan().mode).toBe('incremental')
  })
  it('forces a full review while a prior blocking finding is open', async () => {
    await published([{ ...issue, priority: 'P1' }]); commit('screen.ts', 'export const label = "third"')
    const p = plan(); expect(p.mode).toBe('full'); expect(p.reason).toContain('blocking')
  })
  it('does not let an incremental review dismiss or downgrade a prior open finding', async () => {
    await published(); commit('screen.ts', 'export const label = "third"'); const p = plan(); expect(p.mode).toBe('incremental')
    expect(() => finishReview(p, report([{ ...issue, status: 'dismissed' }]))).toThrow('dismissed')
    expect(() => finishReview(p, report([{ ...issue, priority: 'P3' }]))).toThrow('downgraded')
    expect(finishReview(p, report([{ ...issue, priority: 'P1' }])).text).toContain('VERDICT: BLOCK')
  })
  it('caps the prior findings replayed into the prompt', async () => {
    await published([{ ...issue, evidence: 'x'.repeat(4000) }]); commit('screen.ts', 'export const label = "third"')
    const p = plan(); expect(p.instructions).not.toContain('x'.repeat(501)); expect(p.instructions).toContain('x'.repeat(500))
  })
  it('does not allow an open finding to vanish or a new finding to start resolved', async () => {
    await published(); commit('screen.ts', 'export const label = "third"'); const p = plan()
    expect(() => finishReview(p, report([]))).toThrow('omitted')
    expect(() => finishReview(p, report([issue, { ...issue, key: 'new', status: 'resolved' }]))).toThrow('cannot start')
  })
  it('requires valid complete structured output, including nonempty evidence', () => {
    expect(() => finishReview(plan(), 'VERDICT: APPROVE')).toThrow()
    expect(() => finishReview(plan(), report([{ ...issue, evidence: '' }]))).toThrow()
    expect(() => finishReview(plan(), '{"summary":"Could not review","coverage":"incomplete","findings":[]}')).toThrow()
    expect(() => finishReview(plan(), report([issue, issue]))).toThrow('Duplicate')
  })
  it('extracts JSON wrapped in prose, fences or a trailing safety-net verdict', () => {
    expect(finishReview(plan(), `Here is the review:\n${report()}\nDone.`).text).toContain('VERDICT: NEEDS WORK')
    expect(finishReview(plan(), `\`\`\`json\n${report()}\n\`\`\``).text).toContain('VERDICT: NEEDS WORK')
    expect(finishReview(plan(), `${report([])}\n\nVERDICT: BLOCK`).text).toContain('VERDICT: APPROVE')
  })
  it('falls back to a verdict-free raw review instead of failing on unusable output', () => {
    const truncated = finishReviewOrFallback(plan(), '{"summary":"cut off')
    expect(truncated.snapshot).toBeUndefined(); expect(truncated.fallbackReason).toContain('JSON')
    expect(truncated.text.startsWith(STRUCTURED_FALLBACK_WARNING)).toBe(true)
    const blocked = finishReviewOrFallback(plan(), 'I could not run the review.\n\nVERDICT: APPROVE')
    expect(blocked.text).not.toMatch(/VERDICT/); expect(blocked.text).toContain('could not run')
    expect(finishReviewOrFallback(plan(), report()).fallbackReason).toBeUndefined()
  })
  it.each([['P0', 'BLOCK'], ['P1', 'BLOCK'], ['P2', 'NEEDS WORK'], ['P3', 'APPROVE']])('computes %s verdict independently of summary wording', (priority, verdict) => {
    expect(finishReview(plan(), report([{ ...issue, priority }])).text).toMatch(`VERDICT: ${verdict}`)
  })
  it('keeps identity across line changes and resolves old issues without blocking', async () => {
    await published(); commit('screen.ts', 'export const label = "third"'); const p = plan()
    const resolved = { ...issue, line: 20, status: 'resolved', evidence: 'Label added at line 20' }
    expect(findingId(issue)).toBe(findingId(resolved))
    const review = finishReview(p, report([resolved])); expect(review.text).toContain('VERDICT: APPROVE')
    expect(review.text).not.toContain('[P2]')
  })
  it('does not let a slower concurrent review overwrite a snapshot published while it ran', async () => {
    const slow = plan(); const slowResult = finishReview(slow, report())
    commit('screen.ts', 'export const label = "third"')
    const fast = plan(); expect(await savePublishedReview(fast, finishReview(fast, report()).snapshot)).toBe(true)
    const future = new Date(Date.now() + 5_000); utimesSync(fast.filename, future, future)
    expect(await savePublishedReview(slow, slowResult.snapshot)).toBe(false)
    expect(JSON.parse(readFileSync(fast.filename, 'utf8')).head).toBe(fast.snapshot.head)
  })
  it('breaks a stale memory lock left by a crashed writer', async () => {
    const p = plan(); mkdirSync(join(root, 'memory'), { recursive: true })
    writeFileSync(`${p.filename}.lock`, '999999'); const old = new Date(Date.now() - 60_000); utimesSync(`${p.filename}.lock`, old, old)
    expect(await savePublishedReview(p, finishReview(p, report()).snapshot)).toBe(true)
    expect(existsSync(`${p.filename}.lock`)).toBe(false)
  })
})

it('rejects stale publication for updated, retargeted and newly closed PRs', () => {
  const p = plan()
  const current = { state: 'open', head: { sha: p.snapshot.head }, base: { sha: p.snapshot.base, ref: p.snapshot.baseBranch } }
  expect(() => assertReviewFresh(p, current, p.snapshot.head)).not.toThrow()
  expect(() => assertReviewFresh(p, { ...current, state: 'closed' }, p.snapshot.head)).toThrow('stale')
  expect(() => assertReviewFresh(p, { ...current, head: { sha: 'a'.repeat(40) } }, p.snapshot.head)).toThrow('stale')
  expect(() => assertReviewFresh(p, { ...current, base: { ...current.base, ref: 'main' } }, p.snapshot.head)).toThrow('stale')
  expect(() => assertReviewFresh(p, current, 'b'.repeat(40))).toThrow('stale')
  expect(() => assertReviewFresh(p, current, p.snapshot.head, null)).toThrow('stale')
  // The runner independently verifies an auto-fix descendant before using this expected source head.
  expect(() => assertReviewFresh(p, { ...current, head: { sha: 'a'.repeat(40) } }, p.snapshot.head, 'a'.repeat(40))).not.toThrow()
  // A manual review of an already-closed PR may still publish.
  expect(() => assertReviewFresh(p, { ...current, state: 'closed' }, p.snapshot.head, p.snapshot.head, 'closed')).not.toThrow()
})

// The API's base.sha stays at the PR's last sync while the snapshot holds the live
// base tip, so the two differ whenever the base branch has advanced since then.
// Nothing moved during the review, and the PR's own diff is unchanged.
it('publishes when only the base branch advanced', () => {
  const p = plan()
  const baseAdvanced = { state: 'open', head: { sha: p.snapshot.head }, base: { sha: 'c'.repeat(40), ref: p.snapshot.baseBranch } }
  expect(() => assertReviewFresh(p, baseAdvanced, p.snapshot.head)).not.toThrow()
})
