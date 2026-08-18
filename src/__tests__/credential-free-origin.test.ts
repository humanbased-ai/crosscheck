import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { withCredentialFreeOrigin } from '../lib/clone.js'

// An HTTPS clone stores https://x-access-token:<token>@github.com/... in
// .git/config, so the checkout carries a writable GitHub token as a plain file.
// Once a vendor agent runs shell commands in that checkout — which is what
// skills.codex_full_access permits — reading .git/config or running `git push`
// is enough to act on the repository. Flagged by review on #298.
describe('withCredentialFreeOrigin', () => {
  let dir: string
  const originUrl = (): string =>
    execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: dir, encoding: 'utf8' }).trim()

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crosscheck-origin-'))
    execFileSync('git', ['init', '-q'], { cwd: dir })
  })
  afterEach(() => rmSync(dir, { force: true, recursive: true }))

  const setOrigin = (url: string): void => {
    execFileSync('git', ['remote', 'add', 'origin', url], { cwd: dir })
  }

  it('strips the token for the duration and restores it after', async () => {
    const withToken = 'https://x-access-token:ghs_secret@github.com/o/r.git'
    setOrigin(withToken)

    let seen = ''
    await withCredentialFreeOrigin(dir, async () => { seen = originUrl() })

    expect(seen).toBe('https://github.com/o/r.git')
    expect(seen).not.toContain('ghs_secret')
    expect(originUrl()).toBe(withToken)
  })

  it('restores the token even when the body throws', async () => {
    const withToken = 'https://x-access-token:ghs_secret@github.com/o/r.git'
    setOrigin(withToken)

    await expect(withCredentialFreeOrigin(dir, async () => { throw new Error('vendor failed') }))
      .rejects.toThrow('vendor failed')
    // The fix step pushes through this remote after the agent exits, so a lost
    // restore would turn a vendor error into a failed push.
    expect(originUrl()).toBe(withToken)
  })

  it('returns the body result', async () => {
    setOrigin('https://x-access-token:ghs_secret@github.com/o/r.git')
    await expect(withCredentialFreeOrigin(dir, async () => 'value')).resolves.toBe('value')
  })

  it('leaves an SSH remote untouched — it carries no credential', async () => {
    const ssh = 'git@github.com:o/r.git'
    setOrigin(ssh)

    let seen = ''
    await withCredentialFreeOrigin(dir, async () => { seen = originUrl() })

    expect(seen).toBe(ssh)
    expect(originUrl()).toBe(ssh)
  })

  it('runs the body when there is no origin at all', async () => {
    let ran = false
    await withCredentialFreeOrigin(dir, async () => { ran = true })
    expect(ran).toBe(true)
  })
})
