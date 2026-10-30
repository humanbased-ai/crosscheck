import { createHash } from 'crypto'
import { chmod, mkdir, readdir, readFile, rm, stat, utimes, writeFile } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execa } from 'execa'

/**
 * Runs `git <subcommand> ...args`. `network` marks the fetch that
 * talks to the remote, so the caller can apply its HTTP resilience settings,
 * transient-error retries and progress reporting to it. Errors must already be redacted.
 */
export type CacheGitRunner = (subcommand: string, args: string[], opts: { cwd?: string; network: boolean }) => Promise<void>

const defaultRunner: CacheGitRunner = async (subcommand, args, { cwd }) => { await execa('git', [subcommand, ...args], { cwd }) }

const LOCK_WAIT_MS = 120_000
// A fetch into the cache can legitimately run long on a big repo; only a lock whose
// owner process is gone, or one far older than any real fetch, is broken.
const LOCK_STALE_MS = 30 * 60_000
const UNUSED_CACHE_MS = 30 * 24 * 60 * 60_000
const MAX_FRESH_CLONES = 2
const FRESH_CLONE_POLL_MS = 250

export class RepositoryCacheBusyError extends Error {
  constructor(label: string, lock: string) {
    super(`Repository cache busy: ${label}; retry later or remove ${lock} after verifying its owner stopped`)
    this.name = 'RepositoryCacheBusyError'
  }
}

function isErrorCode(err: unknown, code: string): boolean {
  return err instanceof Error && 'code' in err && err.code === code
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (err) {
    // EPERM: the process exists but belongs to another user.
    return isErrorCode(err, 'EPERM')
  }
}

async function lockIsStale(lock: string): Promise<boolean> {
  try {
    const [owner, info] = await Promise.all([readFile(join(lock, 'owner'), 'utf8').catch(() => ''), stat(lock)])
    const pid = Number(owner.split('\n')[0])
    if (Number.isInteger(pid) && pid > 0 && !processAlive(pid)) return true
    return Date.now() - info.mtimeMs > LOCK_STALE_MS
  } catch (err) {
    // Released between our mkdir and this check: not stale, just retry.
    if (isErrorCode(err, 'ENOENT')) return false
    throw err
  }
}

async function tryLock(lock: string): Promise<boolean> {
  try {
    await mkdir(lock)
  } catch (err) {
    if (isErrorCode(err, 'EEXIST')) return false
    throw err
  }
  await writeFile(join(lock, 'owner'), `${process.pid}\n${new Date().toISOString()}\n`)
  return true
}

async function acquireLock(lock: string, label: string, waitMs: number): Promise<void> {
  const deadline = Date.now() + waitMs
  // Polling a filesystem lock is inherently sequential.
  for (;;) {
    if (await tryLock(lock)) return
    if (await lockIsStale(lock)) {
      await rm(lock, { recursive: true, force: true })
      continue
    }
    if (Date.now() >= deadline) throw new RepositoryCacheBusyError(label, lock)
    await sleep(100)
  }
}

// Drop caches nobody has used for a month, skipping any that are locked.
async function pruneUnused(root: string, keep: string): Promise<void> {
  const names = (await readdir(root)).filter(n => n.endsWith('.git') && join(root, n) !== keep)
  const cutoff = Date.now() - UNUSED_CACHE_MS
  await Promise.all(names.map(async name => {
    const cache = join(root, name)
    const lock = `${cache}.lock`
    try {
      if ((await stat(cache)).mtimeMs >= cutoff || !(await tryLock(lock))) return
      try { await rm(cache, { recursive: true, force: true }) } finally { await rm(lock, { recursive: true, force: true }) }
    } catch { /* pruning is best effort; a busy or vanished cache is skipped */ }
  }))
}

// Each checkout owns its objects and config. Agents never receive an alternates
// link or shared worktree metadata pointing back into the cache.
export async function cloneFromCache(input: {
  source: string; repository: string; prNumber: number; destination: string; root?: string; git?: CacheGitRunner; lockWaitMs?: number
}): Promise<void> {
  const root = input.root ?? join(homedir(), '.crosscheck', 'repository-cache')
  const git = input.git ?? defaultRunner
  const key = createHash('sha256').update(input.repository).digest('hex')
  const cache = join(root, `${key}.git`)
  const lock = `${cache}.lock`
  await mkdir(root, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies on creation; the cache holds private source.
  await chmod(root, 0o700)
  await acquireLock(lock, key, input.lockWaitMs ?? LOCK_WAIT_MS)
  try {
    // Fetch by URL, not a stored remote: the operator's token never enters the cache config.
    const branch = `cache-pr-${input.prNumber}`
    try {
      await git('init', ['--bare', '--quiet', cache], { network: false })
      await git('fetch', ['--no-tags', '--depth=50', input.source,
        '+HEAD:refs/heads/cache-default', `+refs/pull/${input.prNumber}/head:refs/heads/${branch}`], { cwd: cache, network: true })
      // --single-branch: the checkout takes this PR's history and nothing else. The
      // cache holds every PR it has served, each fetched 50 commits deep, and each of
      // those fetches left a shallow boundary in the cache. A boundary is a graft — the
      // commit has no parents from then on — so cloning every branch carried every
      // other PR's boundaries into this checkout. Those sitting on the base branch above
      // this PR's branch point cut the base off from the true merge base, and
      // `origin/<base>...HEAD` diffed against older common ancestors reached through
      // merges instead (humanbased-ai/monorepo#5681: a 1,721-file range for a 3-file PR).
      //
      // This PR's own boundaries cannot cut that path: every commit on it is a
      // descendant of the merge base, and none of those is in this PR's history.
      await git('clone', ['--quiet', '--no-hardlinks', '--single-branch', '--branch', branch, cache, input.destination], { network: false })
      await git('remote', ['set-url', 'origin', input.source], { cwd: input.destination, network: false })
    } catch (err) {
      // A killed fetch can leave the cache corrupt, and `git init --bare` does not
      // repair it. Drop it so the next review rebuilds from scratch, and leave no
      // partial checkout behind for the caller's fresh-clone fallback.
      await Promise.all([rm(cache, { recursive: true, force: true }), rm(input.destination, { recursive: true, force: true })])
      throw err
    }
    const now = new Date()
    await utimes(cache, now, now)
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
  await pruneUnused(root, cache)
}

export type ReleaseFreshClone = () => Promise<void>

/**
 * Takes one of the machine-wide slots a fresh clone must hold, or returns null when
 * none is free. Reviews waiting on a busy cache all give up at the same moment, so
 * without a cap a burst of PR events turns into the same number of full clones, each
 * writing a checkout to disk at once. Slots are lock directories because the reviews
 * can be separate processes: `watch` clones in-process, `run` and `review` do not.
 */
export async function tryClaimFreshClone(): Promise<ReleaseFreshClone | null> {
  const dir = join(homedir(), '.crosscheck', 'fresh-clone-slots')
  await mkdir(dir, { recursive: true, mode: 0o700 })
  // Sequential on purpose: the first free slot ends the search.
  for (let slot = 0; slot < MAX_FRESH_CLONES; slot++) {
    const lock = join(dir, `${slot}.lock`)
    if (await lockIsStale(lock)) await rm(lock, { recursive: true, force: true })
    if (await tryLock(lock)) return () => rm(lock, { recursive: true, force: true })
  }
  return null
}

export async function claimFreshClone(onWaiting?: () => void): Promise<ReleaseFreshClone> {
  let release = await tryClaimFreshClone()
  if (release === null) onWaiting?.()
  // Polling a filesystem lock is inherently sequential. Bounded by the holders: a clone
  // that stalls is killed by git's low-speed limit, and a dead or ancient slot is stale.
  while (release === null) {
    await sleep(FRESH_CLONE_POLL_MS)
    release = await tryClaimFreshClone()
  }
  return release
}
