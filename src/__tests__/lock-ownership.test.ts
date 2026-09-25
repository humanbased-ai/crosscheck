import { describe, it, expect, afterEach } from 'vitest'
import { writeFileSync, mkdirSync, readFileSync, existsSync, rmSync } from 'fs'
import { homedir, hostname } from 'os'
import { join } from 'path'
import { acquirePRLock, releasePRLock, inspectPRLock, evaluateExistingLock, INSTANCE_ID } from '../lib/pr-lock.js'
import { parseClaimOwner, claimRemoteLock } from '../github/review-status.js'

const OWNER = 'lock-owner-test'
const REPO = 'repo'
const PR = 4242
const SHA = 'deadbeefcafebabe0123456789abcdef01234567'
const LOCK = join(homedir(), '.crosscheck', 'locks', `${OWNER}-${REPO}-${PR}.lock`)

function writeForeignLock(record: Record<string, unknown>): void {
  mkdirSync(join(homedir(), '.crosscheck', 'locks'), { recursive: true })
  writeFileSync(LOCK, JSON.stringify(record))
}

afterEach(() => {
  releasePRLock(OWNER, REPO, PR, SHA)
  try { rmSync(LOCK) } catch { /* already gone */ }
})

describe('local lock ownership', () => {
  it('records who holds the lock, not just that it is held', () => {
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
    const held = inspectPRLock(OWNER, REPO, PR)
    expect(held?.instance).toBe(INSTANCE_ID)
    expect(held?.pid).toBe(process.pid)
    expect(held?.host).toBe(hostname())
    expect(held?.sha).toBe(SHA)
  })

  it('refuses a lock held by a live peer however long it has run', () => {
    // A three-hour-old lock that is still heartbeating belongs to a review that is
    // still going. The old mtime-based staleness stole these at 20 minutes.
    writeForeignLock({
      instance: 'peer-host:4321:aaaaaaaa',
      host: 'peer-host',
      pid: 4321,
      startedAt: Date.now() - 3 * 60 * 60 * 1000,
      heartbeatAt: Date.now() - 10_000,
    })
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(false)
    expect(inspectPRLock(OWNER, REPO, PR)?.instance).toBe('peer-host:4321:aaaaaaaa')
  })

  it('takes over a lock whose holder stopped heartbeating', () => {
    writeForeignLock({
      instance: 'peer-host:4321:bbbbbbbb',
      host: 'peer-host',
      pid: 4321,
      startedAt: Date.now() - 60 * 60 * 1000,
      heartbeatAt: Date.now() - 10 * 60 * 1000,
    })
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
    expect(inspectPRLock(OWNER, REPO, PR)?.instance).toBe(INSTANCE_ID)
  })

  it('takes over immediately when a same-host holder is gone, without waiting out the heartbeat', () => {
    // pid 1 exists; a pid this large does not. Same host means liveness is knowable,
    // so a dead holder should not cost another five minutes of staleness.
    writeForeignLock({
      instance: `${hostname()}:999999:cccccccc`,
      host: hostname(),
      pid: 999999,
      startedAt: Date.now() - 1000,
      heartbeatAt: Date.now() - 1000,
    })
    expect(acquirePRLock(OWNER, REPO, PR, SHA)).toBe(true)
  })

  it('does not delete a lock that now belongs to someone else', () => {
    acquirePRLock(OWNER, REPO, PR, SHA)
    // Simulate this process's lock having been taken over as stale while it ran.
    writeForeignLock({
      instance: 'peer-host:5555:dddddddd',
      host: 'peer-host',
      pid: 5555,
      startedAt: Date.now(),
      heartbeatAt: Date.now(),
    })
    releasePRLock(OWNER, REPO, PR, SHA)
    expect(existsSync(LOCK)).toBe(true)
    expect(JSON.parse(readFileSync(LOCK, 'utf8')).instance).toBe('peer-host:5555:dddddddd')
  })
})

describe('evaluateExistingLock', () => {
  const live = { instance: 'h:1:x', host: 'other-host', pid: 1, startedAt: 0, heartbeatAt: 1_000_000 }

  it('keeps a peer lock whose heartbeat is fresh', () => {
    expect(evaluateExistingLock(live, 0, 1_060_000)).toEqual({ stealable: false })
  })

  it('frees a peer lock once the heartbeat goes silent past the window', () => {
    expect(evaluateExistingLock(live, 0, 1_000_000 + 6 * 60 * 1000)).toEqual({
      stealable: true, reason: 'heartbeat_stale',
    })
  })

  it('holds a legacy empty lock for the full 20 minutes it was written under', () => {
    const now = 100 * 60 * 1000
    expect(evaluateExistingLock(null, now - 19 * 60 * 1000, now)).toEqual({ stealable: false })
    expect(evaluateExistingLock(null, now - 21 * 60 * 1000, now)).toEqual({
      stealable: true, reason: 'legacy_lock_expired',
    })
  })
})

describe('parseClaimOwner', () => {
  it('reads the instance id back out of a claim description', () => {
    expect(parseClaimOwner('crosscheck mac:123:abcd started 2026-09-20T00:00:00.000Z')).toBe('mac:123:abcd')
  })

  it('returns null for a status crosscheck did not write', () => {
    expect(parseClaimOwner('Review started at 2026-09-19T10:00:00.000Z')).toBeNull()
    expect(parseClaimOwner(null)).toBeNull()
    expect(parseClaimOwner('')).toBeNull()
  })
})

describe('claimRemoteLock arbitration', () => {
  function octokitStub(readBackDescription: string | null) {
    const created: Array<Record<string, unknown>> = []
    return {
      created,
      octokit: {
        rest: {
          repos: {
            createCommitStatus: async (args: Record<string, unknown>) => { created.push(args); return { data: {} } },
            getCombinedStatusForRef: async () => ({
              data: {
                statuses: readBackDescription === null ? [] : [{
                  context: 'crosscheck/review',
                  state: 'pending',
                  description: readBackDescription,
                  updated_at: new Date().toISOString(),
                }],
              },
            }),
          },
        },
      },
    }
  }

  it('proceeds when our own claim is the one that survived', async () => {
    const { octokit, created } = octokitStub(`crosscheck ${INSTANCE_ID} started now`)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Octokit surface for this call path
    await expect(claimRemoteLock(octokit as any, 'o', 'r', SHA, 0)).resolves.toBe(true)
    expect(created).toHaveLength(1)
    expect(String(created[0].description)).toContain(INSTANCE_ID)
  })

  it('stands down when a peer claim overwrote ours', async () => {
    const { octokit } = octokitStub('crosscheck other-host:77:eeee started now')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Octokit surface for this call path
    await expect(claimRemoteLock(octokit as any, 'o', 'r', SHA, 0)).resolves.toBe(false)
  })

  it('proceeds when the read-back shows a status with no readable owner', async () => {
    // A legacy status, or one GitHub truncated. Nothing proves we lost, and refusing
    // here would strand the PR on every pre-upgrade commit status.
    const { octokit } = octokitStub('Review started at 2026-09-19T10:00:00.000Z')
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Octokit surface for this call path
    await expect(claimRemoteLock(octokit as any, 'o', 'r', SHA, 0)).resolves.toBe(true)
  })

  it('proceeds when the read-back itself fails', async () => {
    const octokit = {
      rest: {
        repos: {
          createCommitStatus: async () => ({ data: {} }),
          getCombinedStatusForRef: async () => { throw new Error('502') },
        },
      },
    }
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- minimal Octokit surface for this call path
    await expect(claimRemoteLock(octokit as any, 'o', 'r', SHA, 0)).resolves.toBe(true)
  })
})
