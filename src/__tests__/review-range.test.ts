import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { clonePRForReview, ReviewRangeMismatchError } from '../lib/clone.js'

// The review range is `origin/<base>...HEAD`, and every consumer — the vendor's
// own `git diff`, classification, the diff hash, the fixer — trusts it. These
// tests run the real clonePRForReview against a local origin; only the GitHub
// merge-base lookup is faked, answered from the origin's full history the way
// GitHub answers from its own.

const github = vi.hoisted(() => ({ origin: '', answer: undefined as string | undefined }))

vi.mock('../github/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../github/client.js')>(),
  getMergeBase: vi.fn(async (_owner: string, _repo: string, base: string, head: string) =>
    github.answer ?? execFileSync('git', ['merge-base', base, head], { cwd: github.origin, encoding: 'utf8' }).trim()),
}))

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

/**
 * A history shaped like the monorepo where the incident happened: staging is a
 * long run of squash commits, main is synced into it by merge commits, and a
 * side branch rooted below the PR's branch point merges in later. Those two side
 * paths are what let a cut base branch still reach *older* common ancestors, so
 * git answered with two wrong merge bases rather than none.
 *
 *   staging  m0 ── s1 … s300, linear except for three merges:
 *              s97 merges main's h, s250 merges side's F, s260 merges main's h2
 *   main     m0 ── h ── h2
 *   side     F, rooted at s95
 *   PR #2    3 doc commits on s100: the PR under review, 200 commits behind staging
 *   PR #3    60 commits on s100: deeper than the cache's 50-commit window
 *   PR #1    1 commit on s200: its depth-50 boundary, s152, lies between s100 and s300
 *
 * Built with one `git fast-import`; ~370 commits through plumbing calls take seconds.
 */
function buildHistory(dir: string): Record<string, string> {
  const specs: Array<{ name: string; parents: string[]; file: string }> = []
  const add = (name: string, parents: string[], file: string): void => { specs.push({ name, parents, file }) }
  add('m0', [], 'main.txt')
  add('h', ['m0'], 'billing.ts')
  for (let i = 1; i <= 300; i++) {
    if (i === 260) add('h2', ['h'], 'billing-fix.ts')
    const merged = i === 97 ? ['h'] : i === 250 ? ['F'] : i === 260 ? ['h2'] : []
    add(`s${i}`, [i === 1 ? 'm0' : `s${i - 1}`, ...merged], `services/s${i}.ts`)
    if (i === 95) add('F', ['s95'], 'side.ts')
    if (i === 100) {
      ;['a', 'b', 'c'].forEach((doc, n) => add(`p2-${n}`, [n === 0 ? 's100' : `p2-${n - 1}`], `docs/${doc}.md`))
      for (let n = 0; n < 60; n++) add(`p3-${n}`, [n === 0 ? 's100' : `p3-${n - 1}`], `deep/d${n}.md`)
    }
    if (i === 200) add('p1', ['s200'], 'other.ts')
  }

  const mark = new Map(specs.map((spec, n) => [spec.name, n + 1]))
  const data = (text: string): string => `data ${Buffer.byteLength(text)}\n${text}`
  const stream = specs.map((spec, n) => [
    'commit refs/fixture/build',
    `mark :${n + 1}`,
    `committer T <t@example.test> ${1_700_000_000 + n} +0000`,
    data(spec.name),
    ...spec.parents.map((parent, p) => `${p === 0 ? 'from' : 'merge'} :${mark.get(parent)}`),
    `M 100644 inline ${spec.file}`,
    data(`${spec.name}\n`),
    '',
  ].join('\n')).join('\n')
  const marks = join(dir, '..', 'marks')
  execFileSync('git', ['fast-import', '--quiet', `--export-marks=${marks}`], { cwd: dir, input: stream, stdio: ['pipe', 'pipe', 'pipe'] })
  git(dir, 'update-ref', '-d', 'refs/fixture/build')
  const bySha = new Map(readFileSync(marks, 'utf8').trim().split('\n').map(line => {
    const [m, sha] = line.split(' ')
    return [Number(m.slice(1)), sha] as const
  }))
  return Object.fromEntries(specs.map((spec, n) => [spec.name, bySha.get(n + 1) as string]))
}

let root: string
let origin: string
let sha: Record<string, string>
let cacheFailures: string[]
// Restored key by key: process.env is a special object, not one to replace.
const ENV_KEYS = ['HOME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

// Where the history stood when PR #1 was reviewed, and where it stood two days
// and 200 staging commits later when PR #2 was.
function at(time: 't1' | 't2'): void {
  git(origin, 'update-ref', 'refs/heads/main', time === 't1' ? sha.h : sha.h2)
  git(origin, 'update-ref', 'refs/heads/staging', time === 't1' ? sha.s200 : sha.s300)
}

function review(prNumber: number, options: { baseSha?: string; repositoryCache?: boolean } = {}): Promise<{ tmpDir: string; baseRefStatus: string }> {
  const tmpDir = mkdtempSync(join(root, `pr${prNumber}-`))
  return clonePRForReview({
    owner: 'team', repo: 'monorepo', prNumber, baseRef: 'staging', tmpDir,
    token: 'test-token', protocol: 'https', repositoryCache: options.repositoryCache ?? true,
    ...(options.baseSha !== undefined && { baseSha: options.baseSha }),
    onCacheFailed: message => cacheFailures.push(message),
  }).then(({ baseRefStatus }) => ({ tmpDir, baseRefStatus }))
}

// By fixture name, so a failure reads `['s95', 'h']` rather than two bare shas.
const mergeBases = (dir: string): string[] => {
  const name = new Map(Object.entries(sha).map(([n, s]) => [s, n]))
  try {
    return git(dir, 'merge-base', '--all', 'origin/staging', 'HEAD').split('\n').map(s => name.get(s) ?? s)
  } catch { return [] }
}
const changedFiles = (dir: string): string[] => git(dir, 'diff', '--name-only', 'origin/staging...HEAD').split('\n')

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'review-range-test-'))
  origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  sha = buildHistory(origin)
  git(origin, 'update-ref', 'refs/pull/1/head', sha.p1)
  git(origin, 'update-ref', 'refs/pull/2/head', sha['p2-2'])
  git(origin, 'update-ref', 'refs/pull/3/head', sha['p3-59'])
  at('t1')
  github.origin = origin
  github.answer = undefined
  cacheFailures = []
  // The repository cache lives under HOME; the clone URL is github.com, which
  // git rewrites to the local origin — file:// so `--depth` is honoured as it is
  // against GitHub, where a plain path would silently clone everything.
  process.env.HOME = join(root, 'home')
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/team/monorepo.git'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

// Each test builds a ~370-commit origin and clones it more than once: about 5s on a
// quiet machine, which is vitest's whole default timeout.
describe('the review range of a cached checkout', { timeout: 60_000 }, () => {
  it("is the PR's own diff when another PR's shallow boundary sits on the base branch", async () => {
    // humanbased-ai/monorepo#5681 round 2: earlier reviews of other PRs had left
    // their depth-50 boundaries in the shared cache. One sat on staging between
    // the PR's branch point and staging's tip, so staging no longer reached the
    // true merge base and git answered with two older ones and a 1,721-file diff.
    await review(1)
    at('t2')
    const { tmpDir } = await review(2)

    expect(mergeBases(tmpDir)).toEqual(['s100'])
    expect(changedFiles(tmpDir)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
    // Right first time, not rescued by the fresh-clone fallback.
    expect(cacheFailures).toEqual([])
  })

  it('keeps the path to the merge base when a deleted base is recovered by its commit', async () => {
    // A depth-limited recovery fetch draws a new shallow boundary 50 commits below
    // the base tip — here above the PR's branch point, cutting the same path.
    await review(1)
    at('t2')
    git(origin, 'update-ref', '-d', 'refs/heads/staging')
    const { tmpDir, baseRefStatus } = await review(2, { baseSha: sha.s300 })

    expect(baseRefStatus).toBe('recovered_by_sha')
    expect(mergeBases(tmpDir)).toEqual(['s100'])
    expect(changedFiles(tmpDir)).toEqual(['docs/a.md', 'docs/b.md', 'docs/c.md'])
  })

  it('is rebuilt from a fresh clone when the cached checkout cannot reach the merge base', async () => {
    // A PR deeper than the cache's 50-commit window: its checkout ends before the
    // branch point, so there is no merge base to find.
    at('t2')
    const { tmpDir } = await review(3)

    expect(cacheFailures).toHaveLength(1)
    expect(cacheFailures[0]).toMatch(/no merge base/)
    expect(mergeBases(tmpDir)).toEqual(['s100'])
    expect(changedFiles(tmpDir)).toHaveLength(60)
  })

  it("reaches the merge base of an old PR whose base is the repository's default branch", async () => {
    // A fresh clone is depth-50 of the default branch. Here that is the PR's base, so
    // the base ends 150 commits above the PR's branch point at a shallow boundary, and
    // fetching the PR head and the already-present base ref added nothing below it.
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/staging')
    at('t2')
    const { tmpDir } = await review(3)

    expect(mergeBases(tmpDir)).toEqual(['s100'])
    expect(changedFiles(tmpDir)).toHaveLength(60)
    // The cache cannot reach it either; the fresh clone it falls back to deepens.
    expect(cacheFailures).toHaveLength(1)
  })

  it('does the same from a fresh clone, with no cache', async () => {
    git(origin, 'symbolic-ref', 'HEAD', 'refs/heads/staging')
    at('t2')
    const { tmpDir } = await review(3, { repositoryCache: false })

    expect(mergeBases(tmpDir)).toEqual(['s100'])
    expect(changedFiles(tmpDir)).toHaveLength(60)
  })

  it('refuses a checkout whose range GitHub does not confirm, rather than review a different diff', async () => {
    github.answer = sha.s99
    const failure = review(2)

    await expect(failure).rejects.toBeInstanceOf(ReviewRangeMismatchError)
    await expect(failure).rejects.toThrow(sha.s99.slice(0, 10))
    // Tried from the cache, then from a fresh clone, before giving up.
    expect(cacheFailures).toHaveLength(1)
  })

  it('verifies a fresh clone too', async () => {
    github.answer = sha.s99
    await expect(review(2, { repositoryCache: false })).rejects.toBeInstanceOf(ReviewRangeMismatchError)
  })
})
