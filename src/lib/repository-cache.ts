import { createHash } from 'crypto'
import { mkdir, rm } from 'fs/promises'
import { homedir } from 'os'
import { join } from 'path'
import { setTimeout as sleep } from 'node:timers/promises'
import { execa } from 'execa'

// Each checkout owns its objects and config. Agents never receive an alternates
// link or shared worktree metadata pointing back into the cache.
export async function cloneFromCache(input: {
  source: string; repository: string; prNumber: number; destination: string; root?: string
}): Promise<void> {
  const root = input.root ?? join(homedir(), '.crosscheck', 'repository-cache')
  const key = createHash('sha256').update(input.repository).digest('hex')
  const cache = join(root, `${key}.git`)
  const lock = `${cache}.lock`
  await mkdir(root, { recursive: true, mode: 0o700 })
  const deadline = Date.now() + 120_000
  async function acquire(): Promise<void> {
    try { await mkdir(lock) } catch (err) {
      if (!(err instanceof Error) || !('code' in err) || err.code !== 'EEXIST') throw err
      if (Date.now() >= deadline) throw new Error(`Repository cache busy: ${key}; retry later or remove the lock after verifying its owner stopped`)
      await sleep(100)
      return acquire()
    }
  }
  await acquire()
  try {
    await execa('git', ['init', '--bare', cache])
    // Fetch by URL, not a stored remote: the operator's token never enters the cache config.
    const branch = `cache-pr-${input.prNumber}`
    await execa('git', ['-C', cache, 'fetch', '--no-tags', '--depth=50', input.source,
      `+HEAD:refs/heads/cache-default`, `+refs/pull/${input.prNumber}/head:refs/heads/${branch}`])
    await execa('git', ['clone', '--no-hardlinks', '--branch', branch, cache, input.destination])
    await execa('git', ['-C', input.destination, 'remote', 'set-url', 'origin', input.source])
  } finally {
    await rm(lock, { recursive: true, force: true })
  }
}
