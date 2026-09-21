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

async function acquireLock(lock: string, label: string): Promise<void> {
  const deadline = Date.now() + LOCK_WAIT_MS
  // Polling a filesystem lock is inherently sequential.
  for (;;) {
    if (await tryLock(lock)) return
    if (await lockIsStale(lock)) {
      await rm(lock, { recursive: true, force: true })
      continue
    }
    if (Date.now() >= deadline) throw new Error(`Repository cache busy: ${label}; retry later or remove ${lock} after verifying its owner stopped`)
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
  source: string; repository: string; prNumber: number; destination: string; root?: string; git?: CacheGitRunner
}): Promise<void> {
  const root = input.root ?? join(homedir(), '.crosscheck', 'repository-cache')
  const git = input.git ?? defaultRunner
  const key = createHash('sha256').update(input.repository).digest('hex')
  const cache = join(root, `${key}.git`)
  const lock = `${cache}.lock`
  await mkdir(root, { recursive: true, mode: 0o700 })
  // mkdir's mode only applies on creation; the cache holds private source.
  await chmod(root, 0o700)
  await acquireLock(lock, key)
  try {
    // Fetch by URL, not a stored remote: the operator's token never enters the cache config.
    const branch = `cache-pr-${input.prNumber}`
    try {
      await git('init', ['--bare', '--quiet', cache], { network: false })
      await git('fetch', ['--no-tags', '--depth=50', input.source,
        '+HEAD:refs/heads/cache-default', `+refs/pull/${input.prNumber}/head:refs/heads/${branch}`], { cwd: cache, network: true })
      await git('clone', ['--quiet', '--no-hardlinks', '--branch', branch, cache, input.destination], { network: false })
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
