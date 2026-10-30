import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { homedir, tmpdir } from 'os'
import { join } from 'path'
import { setTimeout as sleep } from 'node:timers/promises'
import { clonePRForReview } from '../lib/clone.js'
import {
  claimFreshClone,
  cloneFromCache,
  RepositoryCacheBusyError,
  tryClaimFreshClone,
  type ReleaseFreshClone,
} from '../lib/repository-cache.js'

// On 2026-10-30 a slow run held the repository cache, every review waiting on it gave
// up at the same moment, and a burst of 12 PR events became 12 full clones on a disk
// with under 6 GB free. Only the cache and the GitHub merge-base lookup are faked here;
// the clones are real, against a local origin, and counted as they start and finish.

const fake = vi.hoisted(() => ({
  origin: '',
  cacheAttempt: null as null | ((input: { destination: string; lockWaitMs?: number }) => Promise<void>),
  activeClones: 0,
  peakClones: 0,
  startedClones: 0,
}))

vi.mock('../github/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../github/client.js')>(),
  getMergeBase: vi.fn(async (_owner: string, _repo: string, base: string, head: string) =>
    execFileSync('git', ['merge-base', base, head], { cwd: fake.origin, encoding: 'utf8' }).trim()),
}))

vi.mock('../lib/repository-cache.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/repository-cache.js')>()
  return {
    ...actual,
    cloneFromCache: vi.fn(async (input: Parameters<typeof actual.cloneFromCache>[0]) =>
      fake.cacheAttempt ? fake.cacheAttempt(input) : actual.cloneFromCache(input)),
  }
})

vi.mock('execa', async importOriginal => {
  const actual = await importOriginal<typeof import('execa')>()
  return {
    ...actual,
    execa: (file: string, args: string[], options: Record<string, unknown>) => {
      const subprocess = actual.execa(file, args, options)
      if (args.includes('clone') && args.includes('--depth=50')) {
        fake.startedClones++
        fake.peakClones = Math.max(fake.peakClones, ++fake.activeClones)
        const done = (): void => { fake.activeClones-- }
        subprocess.then(done, done)
      }
      return subprocess
    },
  }
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const ENV_KEYS = ['HOME', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let root: string
const slotsDir = (): string => join(homedir(), '.crosscheck', 'fresh-clone-slots')

const holdAllSlots = async (): Promise<() => Promise<void>> => {
  const held = await Promise.all([tryClaimFreshClone(), tryClaimFreshClone()])
  expect(held).not.toContain(null)
  return async () => { await Promise.all(held.map(release => (release as ReleaseFreshClone)())) }
}

function review(options: { repositoryCache?: boolean; prNumber?: number; events?: string[] } = {}): Promise<{ tmpDir: string }> {
  const tmpDir = mkdtempSync(join(root, 'checkout-'))
  const { events = [] } = options
  return clonePRForReview({
    owner: 'team', repo: 'repo', prNumber: options.prNumber ?? 7, baseRef: 'staging',
    tmpDir, token: 'ghs_test', protocol: 'https', repositoryCache: options.repositoryCache ?? true,
    onCacheFailed: () => events.push('cache-failed'),
    onCloneWaiting: status => events.push(status === null ? 'wait-over' : 'waiting'),
  }).then(() => ({ tmpDir }))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'fresh-clone-cap-test-'))
  process.env.HOME = join(root, 'home')
  const origin = join(root, 'origin')
  mkdirSync(origin)
  git(origin, 'init', '-q', '-b', 'main')
  git(origin, 'config', 'user.name', 'Test Reviewer')
  git(origin, 'config', 'user.email', 'reviewer@example.test')
  writeFileSync(join(origin, 'file.txt'), 'first\n')
  git(origin, 'add', '.')
  git(origin, 'commit', '-qm', 'Initial')
  git(origin, 'branch', 'staging')
  git(origin, 'checkout', '-qb', 'feature')
  writeFileSync(join(origin, 'file.txt'), 'second\n')
  git(origin, 'commit', '-qam', 'Change')
  git(origin, 'update-ref', 'refs/pull/7/head', 'HEAD')
  git(origin, 'checkout', '-q', 'main')
  fake.origin = origin
  fake.cacheAttempt = null
  fake.activeClones = 0
  fake.peakClones = 0
  fake.startedClones = 0
  // The clone URL is github.com; git rewrites it to the local origin.
  process.env.GIT_CONFIG_COUNT = '1'
  process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
  process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/team/repo.git'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('fresh clones from clonePRForReview', { timeout: 60_000 }, () => {
  it('runs at most two at once for a burst of 12 reviews while the cache stays busy, and finishes them all', async () => {
    fake.cacheAttempt = async () => {
      await sleep(10)
      throw new RepositoryCacheBusyError('team/repo', '/cache.lock')
    }

    const reviews = await Promise.all(Array.from({ length: 12 }, () => review()))

    expect(fake.startedClones).toBe(12)
    expect(fake.peakClones).toBeLessThanOrEqual(2)
    for (const { tmpDir } of reviews) expect(readFileSync(join(tmpDir, 'file.txt'), 'utf8')).toBe('second\n')
  })

  it('caps a burst the same way when the cache is turned off', async () => {
    await Promise.all(Array.from({ length: 6 }, () => review({ repositoryCache: false })))

    expect(fake.startedClones).toBe(6)
    expect(fake.peakClones).toBeLessThanOrEqual(2)
  })

  it('waits for the cache rather than clone past the cap, and uses it once it frees up', async () => {
    const releaseSlots = await holdAllSlots()
    const events: string[] = []
    let attempts = 0
    fake.cacheAttempt = async ({ destination }) => {
      if (++attempts < 3) throw new RepositoryCacheBusyError('team/repo', '/cache.lock')
      fake.cacheAttempt = null
      await cloneFromCache({ source: 'https://github.com/team/repo.git', repository: 'team/repo', prNumber: 7, destination })
    }

    const { tmpDir } = await review({ events })
    await releaseSlots()

    expect(attempts).toBe(3)
    expect(fake.startedClones).toBe(0)
    expect(readFileSync(join(tmpDir, 'file.txt'), 'utf8')).toBe('second\n')
    // A wait is not a failure: repository_cache_failed means a fresh clone was used.
    // And one wait, however many rounds it takes, is one report.
    expect(events).toEqual(['waiting', 'wait-over'])
  })

  it('rechecks for a free slot within seconds once a review is queued', async () => {
    const releaseSlots = await holdAllSlots()
    const waits: Array<number | undefined> = []
    fake.cacheAttempt = async ({ lockWaitMs }) => {
      waits.push(lockWaitMs)
      if (waits.length === 2) await releaseSlots()
      throw new RepositoryCacheBusyError('team/repo', '/cache.lock')
    }

    await review()

    // The first round is the cache's own long wait; a long second one would leave a
    // freed slot idle for minutes while this review sits in the lock queue.
    expect(waits[0]).toBeUndefined()
    expect(waits[1]).toBeLessThan(10_000)
    expect(fake.startedClones).toBe(1)
  })

  it('falls back to a fresh clone from a busy cache when a slot is free, and reports that', async () => {
    const events: string[] = []
    fake.cacheAttempt = async () => { throw new RepositoryCacheBusyError('team/repo', '/cache.lock') }

    await review({ events })

    expect(fake.startedClones).toBe(1)
    expect(events).toEqual(['cache-failed'])
  })

  it('makes a review whose cache really failed wait for a slot, without trying the cache again', async () => {
    const releaseSlots = await holdAllSlots()
    const events: string[] = []
    let attempts = 0
    fake.cacheAttempt = async () => {
      attempts++
      throw new Error('fatal: not a git repository')
    }

    const pending = review({ events })
    await vi.waitFor(() => expect(events).toContain('waiting'), { timeout: 5_000 })
    expect(fake.startedClones).toBe(0)

    await releaseSlots()
    await pending

    expect(attempts).toBe(1)
    expect(fake.startedClones).toBe(1)
    expect(events).toEqual(['cache-failed', 'waiting', 'wait-over'])
  })

  it('gives the slot back when the clone fails', async () => {
    await expect(review({ repositoryCache: false, prNumber: 404 })).rejects.toThrow()

    expect(readdirSync(slotsDir())).toEqual([])
  })
})

describe('fresh clone slots', () => {
  it('holds a third claimer back until a slot is released, and says it is waiting once', async () => {
    const releaseSlots = await holdAllSlots()
    let waits = 0
    let claimed = false

    const third = claimFreshClone(() => { waits++ }).then(release => { claimed = true; return release })
    await sleep(600)
    expect(claimed).toBe(false)
    expect(waits).toBe(1)

    await releaseSlots()
    await (await third)()
    expect(claimed).toBe(true)
  })

  it('takes over a slot left by a process that died holding it', async () => {
    const releaseSlots = await holdAllSlots()
    await releaseSlots()
    for (const slot of ['0.lock', '1.lock']) {
      mkdirSync(join(slotsDir(), slot))
      writeFileSync(join(slotsDir(), slot, 'owner'), '999999\n')
    }

    const release = await tryClaimFreshClone()

    expect(release).not.toBeNull()
    await (release as ReleaseFreshClone)()
  })
})

describe('cloneFromCache', () => {
  it('reports a lock held past its wait as busy, leaving the lock and the destination alone', async () => {
    const cacheRoot = join(root, 'cache')
    mkdirSync(cacheRoot)
    const actual = await vi.importActual<typeof import('../lib/repository-cache.js')>('../lib/repository-cache.js')
    const destination = mkdtempSync(join(root, 'destination-'))
    const attempt = (): Promise<void> => actual.cloneFromCache({
      source: 'https://github.com/team/repo.git', repository: 'team/repo', prNumber: 7, destination, root: cacheRoot, lockWaitMs: 50,
    })
    // First run makes the cache, so its lock path is known.
    await attempt()
    rmSync(destination, { recursive: true, force: true })
    const lock = `${join(cacheRoot, readdirSync(cacheRoot).find(name => name.endsWith('.git')) as string)}.lock`
    mkdirSync(lock)
    writeFileSync(join(lock, 'owner'), `${process.pid}\n`)
    mkdirSync(destination)

    await expect(attempt()).rejects.toBeInstanceOf(actual.RepositoryCacheBusyError)

    expect(existsSync(lock)).toBe(true)
    expect(existsSync(destination)).toBe(true)
  })
})
