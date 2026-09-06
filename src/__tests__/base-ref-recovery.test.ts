import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { resolveBaseRef, BaseRefUnavailableError, isBaseRefUnavailableError } from '../lib/clone.js'

// Exercised against a real local origin rather than a mock: the whole point of the
// recovery chain is which git invocations actually put a ref in place, and a mock
// that answers "fetched" proves nothing about git.
describe('resolveBaseRef', () => {
  let originDir: string
  let workDir: string
  let baseSha: string

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  const commit = (dir: string, file: string, message: string): string => {
    writeFileSync(join(dir, file), `${message}\n`)
    git(dir, 'add', '-A')
    git(dir, '-c', 'user.email=t@t.t', '-c', 'user.name=t', 'commit', '-m', message)
    return git(dir, 'rev-parse', 'HEAD')
  }

  beforeEach(() => {
    // origin: a normal repo with a `main` and a `feature-base` the PR targets.
    originDir = mkdtempSync(join(tmpdir(), 'crosscheck-origin-'))
    git(originDir, 'init', '--initial-branch=main', '.')
    commit(originDir, 'a.txt', 'root')
    git(originDir, 'checkout', '-b', 'feature-base')
    baseSha = commit(originDir, 'b.txt', 'base work')
    git(originDir, 'checkout', '-b', 'pr-head')
    commit(originDir, 'c.txt', 'pr work')
    git(originDir, 'checkout', 'main')

    // The consumer clone, with the PR head checked out — never the base branch.
    workDir = mkdtempSync(join(tmpdir(), 'crosscheck-work-'))
    git(workDir, 'clone', originDir, '.')
    git(workDir, 'checkout', '-b', 'pr-1', 'origin/pr-head')
    // Drop the tracking ref the clone created, so each case starts from "absent".
    git(workDir, 'update-ref', '-d', 'refs/remotes/origin/feature-base')
  })

  afterEach(() => {
    rmSync(originDir, { force: true, recursive: true })
    rmSync(workDir, { force: true, recursive: true })
  })

  it('fetches the base by name when the branch exists', async () => {
    const status = await resolveBaseRef({ tmpDir: workDir, baseRef: 'feature-base', prNumber: 1 })
    expect(status).toBe('fetched')
    expect(git(workDir, 'rev-parse', 'refs/remotes/origin/feature-base')).toBe(baseSha)
  })

  it('recovers by commit when the base branch has been deleted', async () => {
    // The incident: PR #3649's base branch was gone by the time the review ran.
    git(originDir, 'branch', '-D', 'feature-base')
    const recovered: string[] = []

    const status = await resolveBaseRef({
      tmpDir: workDir, baseRef: 'feature-base', prNumber: 1, baseSha,
      onBaseRefRecovered: s => recovered.push(s),
    })

    expect(status).toBe('recovered_by_sha')
    expect(recovered).toEqual(['recovered_by_sha'])
    // The ref must actually resolve — the whole failure was trusting an exit code.
    expect(git(workDir, 'rev-parse', 'refs/remotes/origin/feature-base')).toBe(baseSha)
  })

  it("recovers via the PR's merge ref when the base commit is not fetchable by name", async () => {
    // GitHub keeps refs/pull/<n>/merge for an open PR; its first parent is the base.
    const mergeSha = git(originDir, 'commit-tree', `${baseSha}^{tree}`,
      '-p', baseSha, '-p', git(originDir, 'rev-parse', 'pr-head'), '-m', 'merge')
    git(originDir, 'update-ref', 'refs/pull/1/merge', mergeSha)
    git(originDir, 'branch', '-D', 'feature-base')

    const status = await resolveBaseRef({
      tmpDir: workDir, baseRef: 'feature-base', prNumber: 1,
      // No baseSha, so recovery 1 cannot run and recovery 2 must carry it.
    })

    expect(status).toBe('recovered_by_merge_ref')
    expect(git(workDir, 'rev-parse', 'refs/remotes/origin/feature-base')).toBe(baseSha)
  })

  it('reports unavailable when no recovery path exists', async () => {
    git(originDir, 'branch', '-D', 'feature-base')
    const failed: number[] = []

    const status = await resolveBaseRef({
      tmpDir: workDir, baseRef: 'feature-base', prNumber: 1,
      onBaseFetchFailed: () => failed.push(1),
    })

    expect(status).toBe('unavailable')
    expect(failed.length).toBeGreaterThan(0)
  })

  it('reports unavailable when a stale base sha no longer resolves', async () => {
    git(originDir, 'branch', '-D', 'feature-base')
    const status = await resolveBaseRef({
      tmpDir: workDir, baseRef: 'feature-base', prNumber: 1,
      baseSha: '0'.repeat(40),
    })
    expect(status).toBe('unavailable')
  })
})

describe('BaseRefUnavailableError', () => {
  it('names the ref and says what to do', () => {
    const err = new BaseRefUnavailableError('chore/in-4439-registry-machine-ownership')
    expect(err.message).toContain('origin/chore/in-4439-registry-machine-ownership')
    expect(err.message).toContain('Retarget the PR')
  })

  it('is identifiable through the guard', () => {
    expect(isBaseRefUnavailableError(new BaseRefUnavailableError('x'))).toBe(true)
    expect(isBaseRefUnavailableError(new Error('x'))).toBe(false)
  })
})
