import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { prepareReviewPlan, finishReview, savePublishedReview, findingId, assertReviewFresh } from '../lib/review-memory.js'

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
function plan(policy = 'v1', baseBranch = 'staging') {
  return prepareReviewPlan({ repoDir: repo, repository: 'team/project#1', baseBranch, instructions: 'Review code', policy, root: join(root, 'memory') })
}
const issue = { key: 'missing-label', path: 'screen.ts', line: 1, priority: 'P2' as const,
  title: 'Missing label', trigger: 'Open the screen', impact: 'The control is unnamed', evidence: 'No accessible name is assigned', status: 'open' as const }
function report(findings: unknown[] = [issue]): string { return JSON.stringify({ summary: 'Inspected source; tests not run.', coverage: 'complete', findings }) }
function published(): void { const p = plan(); savePublishedReview(p, finishReview(p, report()).snapshot) }
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-memory-test-')); repo = join(root, 'repo'); mkdirSync(repo)
  git('init', '-q'); git('config', 'user.name', 'Test Reviewer'); git('config', 'user.email', 'reviewer@example.test')
  commit('screen.ts', 'export const label = "initial"')
  git('update-ref', 'refs/remotes/origin/staging', 'HEAD')
  commit()
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

describe('review memory', () => {
  it('keeps first and unpublished reviews full; only published snapshots enable incremental review', () => {
    const p = plan(); expect(p.mode).toBe('full')
    const finished = finishReview(p, report()); expect(existsSync(p.filename)).toBe(false)
    commit('screen.ts', 'export const label = "third"'); expect(plan().mode).toBe('full')
    savePublishedReview(p, finished.snapshot)
    const next = plan(); expect(next.mode).toBe('incremental')
    expect(next.instructions).toContain('new regressions'); expect(next.instructions).toContain(issue.key)
  })
  it.each(['auth/session.ts', 'db/migrations/next.sql', 'funding.ts'])('fully reviews sensitive changes: %s', path => {
    published(); commit(path); expect(plan().mode).toBe('full'); expect(plan().reason).toContain('sensitive')
  })
  it('fully reviews changed bases, policies and rewritten history', () => {
    published(); commit('screen.ts', 'export const label = "third"')
    expect(plan('v2').reason).toBe('review policy changed')
    git('update-ref', 'refs/remotes/origin/staging', 'HEAD'); expect(plan().reason).toBe('base changed')
  })
  it('falls back on rewritten history without suppressing prior open findings', () => {
    published(); git('reset', '--hard', 'origin/staging'); commit('screen.ts', 'export const label = "rebased"')
    const p = plan(); expect(p.mode).toBe('full'); expect(p.reason).toContain('rewritten')
    expect(() => finishReview(p, report([]))).toThrow('omitted')
  })
  it('fully reviews large changes and corrupt memory', () => {
    published(); commit('screen.ts', Array.from({ length: 650 }, (_, n) => `line ${n}`).join('\n'))
    expect(plan().reason).toContain('large')
    writeFileSync(plan().filename, '{broken'); expect(plan().reason).toContain('invalid')
  })
  it('does not allow an open finding to vanish or a new finding to start resolved', () => {
    published(); commit('screen.ts', 'export const label = "third"'); const p = plan()
    expect(() => finishReview(p, report([]))).toThrow('omitted')
    expect(() => finishReview(p, report([issue, { ...issue, key: 'new', status: 'resolved' }]))).toThrow('cannot start')
  })
  it('requires valid complete structured output, including nonempty evidence', () => {
    expect(() => finishReview(plan(), 'VERDICT: APPROVE')).toThrow()
    expect(() => finishReview(plan(), report([{ ...issue, evidence: '' }]))).toThrow()
    expect(() => finishReview(plan(), '{"summary":"Could not review","coverage":"incomplete","findings":[]}')).toThrow()
    expect(() => finishReview(plan(), report([issue, issue]))).toThrow('Duplicate')
  })
  it.each([['P0', 'BLOCK'], ['P1', 'BLOCK'], ['P2', 'NEEDS WORK'], ['P3', 'APPROVE']])('computes %s verdict independently of summary wording', (priority, verdict) => {
    expect(finishReview(plan(), report([{ ...issue, priority }])).text).toMatch(`VERDICT: ${verdict}`)
  })
  it('keeps identity across line changes and resolves old issues without blocking', () => {
    published(); commit('screen.ts', 'export const label = "third"'); const p = plan()
    const resolved = { ...issue, line: 20, status: 'resolved', evidence: 'Label added at line 20' }
    expect(findingId(issue)).toBe(findingId(resolved))
    const review = finishReview(p, report([resolved])); expect(review.text).toContain('VERDICT: APPROVE')
    expect(review.text).not.toContain('[P2]')
  })
})

it('rejects stale publication for updated, retargeted and closed PRs', () => {
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
})
