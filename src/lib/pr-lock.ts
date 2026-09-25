import { openSync, closeSync, writeSync, readFileSync, rmSync, mkdirSync, statSync, utimesSync } from 'fs'
import { hostname } from 'os'
import { randomBytes } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'

const LOCK_DIR = join(homedir(), '.crosscheck', 'locks')

// A lock is abandoned when its holder has not heartbeated within this window.
// The holder refreshes every HEARTBEAT_INTERVAL_MS, so this only trips on a
// process that died without running its cleanup — a SIGKILL, an OOM, a power cut.
//
// It used to be 20 minutes measured from the lock file's CREATION time, which is
// the wrong clock: a review that legitimately ran longer than 20 minutes (routine
// on a large PR — the thorough tier alone allows 1200s per reviewer call, before
// clone, fix and recheck) had its lock declared stale and stolen while it was
// still running. Measuring from the last heartbeat means a live review is never
// stale no matter how long it takes, which in turn lets this window be short.
const STALE_MS = 5 * 60 * 1000
const HEARTBEAT_INTERVAL_MS = 60 * 1000

// Identifies this process for the lifetime of the process. The random suffix
// matters: pids are recycled, so host+pid alone can make a dead holder look alive
// once the OS hands its pid to something else.
export const INSTANCE_ID = `${hostname()}:${process.pid}:${randomBytes(4).toString('hex')}`

/** What a holder writes into its lock file so other instances can reason about it. */
interface LockRecord {
  instance: string
  host: string
  pid: number
  /** Head SHA being worked on. Diagnostic — the lock itself is per-PR. */
  sha?: string
  startedAt: number
  heartbeatAt: number
}

// Locks this process holds, by path, with the heartbeat timer keeping each fresh.
const heldLocks = new Map<string, { record: LockRecord; timer: ReturnType<typeof setInterval> }>()
let signalHandlersRegistered = false

// Exported for unit testing. Cleans up local lock files on signal, then —
// when no other listener will drive termination — restores the default
// behavior so the process actually exits.
//
// Background: registering ANY listener on SIGINT/SIGTERM suppresses Node's
// default exit. Previously this handler only deleted the lock and never
// terminated, so Ctrl-C during `crosscheck run` left the process running
// with its lock already removed — letting a second same-machine session
// start the same review concurrently. Now we re-raise after removing
// ourselves so default exit (or another graceful-shutdown handler in
// watch/serve) takes over. When OTHER listeners are registered (the
// watch/serve graceful shutdown handlers referenced in the original
// comment), we let them drive termination via their own finally blocks.
export function handleLockSignal(signal: NodeJS.Signals): void {
  for (const [path, held] of heldLocks) {
    clearInterval(held.timer)
    try { rmSync(path) } catch { /* ignore */ }
  }
  heldLocks.clear()
  if (process.listenerCount(signal) <= 1) {
    process.removeListener(signal, handleLockSignal)
    process.kill(process.pid, signal)
  }
}

function registerSignalCleanup() {
  if (signalHandlersRegistered) return
  signalHandlersRegistered = true
  process.on('SIGTERM', handleLockSignal)
  process.on('SIGINT', handleLockSignal)
}

function lockPath(owner: string, repo: string, pr: number): string {
  return join(LOCK_DIR, `${owner}-${repo}-${pr}.lock`)
}

function readRecord(path: string): LockRecord | null {
  try {
    const raw = readFileSync(path, 'utf8').trim()
    // A lock written by an older crosscheck is an empty file. It carries no owner
    // and no heartbeat, so the only honest reading is the file's mtime.
    if (raw === '') return null
    const parsed = JSON.parse(raw) as Partial<LockRecord>
    if (typeof parsed.instance !== 'string' || typeof parsed.pid !== 'number') return null
    return {
      instance: parsed.instance,
      host: typeof parsed.host === 'string' ? parsed.host : '',
      pid: parsed.pid,
      ...(typeof parsed.sha === 'string' && { sha: parsed.sha }),
      startedAt: typeof parsed.startedAt === 'number' ? parsed.startedAt : 0,
      heartbeatAt: typeof parsed.heartbeatAt === 'number' ? parsed.heartbeatAt : 0,
    }
  } catch {
    return null
  }
}

// Whether a process is still running on THIS host. Cross-host liveness is
// unknowable from here, which is what the heartbeat is for.
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (e: unknown) {
    // EPERM means the pid exists but belongs to another user — alive, not ours.
    return (e as NodeJS.ErrnoException).code === 'EPERM'
  }
}

/** Why a lock held by someone else was taken over. Exported for tests and logging. */
export type StealReason = 'holder_dead' | 'heartbeat_stale' | 'legacy_lock_expired'

// Decide whether an existing lock may be taken over. Ownership is proven two ways,
// in order of strength: a same-host holder whose pid is gone is definitively dead;
// otherwise the heartbeat is the only evidence, and only silence beyond STALE_MS
// counts. A lock held by a live peer is never stolen, however long it has run.
export function evaluateExistingLock(
  record: LockRecord | null,
  mtimeMs: number,
  now: number,
): { stealable: true; reason: StealReason } | { stealable: false } {
  if (record === null) {
    // Legacy empty lock file: mtime is all there is, and it is never refreshed,
    // so fall back to the old generous window rather than stealing from a run
    // that may still be going.
    return now - mtimeMs > 20 * 60 * 1000
      ? { stealable: true, reason: 'legacy_lock_expired' }
      : { stealable: false }
  }
  if (record.host === hostname() && !pidAlive(record.pid)) {
    return { stealable: true, reason: 'holder_dead' }
  }
  if (now - record.heartbeatAt > STALE_MS) {
    return { stealable: true, reason: 'heartbeat_stale' }
  }
  return { stealable: false }
}

function writeRecord(path: string, record: LockRecord): void {
  const fd = openSync(path, 'wx')
  try {
    writeSync(fd, JSON.stringify(record))
  } finally {
    closeSync(fd)
  }
}

function startHeartbeat(path: string, record: LockRecord): void {
  const timer = setInterval(() => {
    const held = heldLocks.get(path)
    if (!held) return
    held.record.heartbeatAt = Date.now()
    try {
      // Rewrite rather than touch: the timestamp inside the file is what a peer
      // on another host reads, and mtime alone would not reach it.
      const fd = openSync(path, 'w')
      try { writeSync(fd, JSON.stringify(held.record)) } finally { closeSync(fd) }
      utimesSync(path, new Date(), new Date())
    } catch { /* best-effort — a failed beat is covered by the next one */ }
  }, HEARTBEAT_INTERVAL_MS)
  // Never hold the event loop open on the heartbeat alone.
  timer.unref?.()
  heldLocks.set(path, { record, timer })
}

/**
 * Take the local lock for a PR. Returns false when another live process holds it.
 *
 * The lock records who holds it, so a peer can tell a live holder from a crashed
 * one instead of guessing from a fixed timeout.
 */
export function acquirePRLock(owner: string, repo: string, pr: number, sha?: string): boolean {
  mkdirSync(LOCK_DIR, { recursive: true })
  registerSignalCleanup()
  const path = lockPath(owner, repo, pr)
  const now = Date.now()
  const record: LockRecord = {
    instance: INSTANCE_ID,
    host: hostname(),
    pid: process.pid,
    ...(sha !== undefined && { sha }),
    startedAt: now,
    heartbeatAt: now,
  }

  try {
    writeRecord(path, record)
    startHeartbeat(path, record)
    return true
  } catch (e: unknown) {
    if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e
  }

  // Re-entering our own lock is not a collision: the same process asking twice for
  // the same PR means a second event arrived for it, and the caller's own inFlight
  // guard decides that. Report it as taken so the caller's skip path runs.
  const existing = readRecord(path)
  if (existing?.instance === INSTANCE_ID) return false

  let mtimeMs = 0
  try { mtimeMs = statSync(path).mtimeMs } catch { return false }

  const verdict = evaluateExistingLock(existing, mtimeMs, now)
  if (!verdict.stealable) return false

  try { rmSync(path) } catch { /* already gone */ }
  try {
    writeRecord(path, record)
    startHeartbeat(path, record)
    return true
  } catch {
    // Lost the race to another instance that cleared the same stale lock.
    return false
  }
}

/** Describe the current holder of a PR's lock, for diagnostics. Null when free. */
export function inspectPRLock(owner: string, repo: string, pr: number): LockRecord | null {
  return readRecord(lockPath(owner, repo, pr))
}

/**
 * Release the local lock — but only if this process still owns it.
 *
 * The ownership check is what stops a late release from clearing a lock that a
 * peer has since taken over: without it, an instance whose lock was stolen as
 * stale would delete the new holder's lock on its way out, and a third instance
 * would walk straight in on a PR two others were already working.
 */
export function releasePRLock(owner: string, repo: string, pr: number, _sha?: string): void {
  const path = lockPath(owner, repo, pr)
  const held = heldLocks.get(path)
  if (held) clearInterval(held.timer)
  heldLocks.delete(path)

  const existing = readRecord(path)
  // An unreadable or legacy record cannot prove another owner. Removing it matches
  // the pre-ownership behaviour and keeps an upgrade from stranding old locks.
  if (existing !== null && existing.instance !== INSTANCE_ID) return
  try { rmSync(path) } catch { /* already gone */ }
}
