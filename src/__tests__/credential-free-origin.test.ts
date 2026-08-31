import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync, appendFileSync } from 'fs'
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

  // A hook planted by the agent would otherwise fire on the runner's own commit
  // and push in this same clone — after the credential is restored, and with
  // crosscheck's environment, which carries GITHUB_TOKEN. Flagged by review on #313.
  describe('hooks planted by the agent', () => {
    const withToken = 'https://x-access-token:ghs_secret@github.com/o/r.git'
    const effectiveHooksPath = (): string => {
      try {
        return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: dir, encoding: 'utf8' }).trim()
      } catch { return '' }
    }

    it('disables hooks for the body, so a dropped .git/hooks script never runs', async () => {
      setOrigin(withToken)
      let seen = ''
      await withCredentialFreeOrigin(dir, async () => { seen = effectiveHooksPath() })
      expect(seen).toBe('/dev/null')
    })

    // A plain re-point writes the key in place, so re-asserting after the agent
    // genuinely wins and the clone is safe again — no need to fail the step.
    it('neutralises a plain core.hooksPath re-point and restores the credential', async () => {
      setOrigin(withToken)

      await withCredentialFreeOrigin(dir, async () => {
        execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir })
      })

      expect(effectiveHooksPath()).toBe('/dev/null')
      expect(originUrl()).toBe(withToken)
    })

    it('refuses when the body hides the re-point behind an include, which re-setting cannot beat', async () => {
      setOrigin(withToken)

      await expect(withCredentialFreeOrigin(dir, async () => {
        writeFileSync(join(dir, 'evil.cfg'), '[core]\n\thooksPath = .git/hooks\n')
        appendFileSync(join(dir, '.git', 'config'), '[include]\n\tpath = ../evil.cfg\n')
      })).rejects.toThrow(/core\.hooksPath is no longer/)

      expect(originUrl()).not.toContain('ghs_secret')
    })

    it('still restores the credential on the honest path', async () => {
      setOrigin(withToken)
      await withCredentialFreeOrigin(dir, async () => { /* well-behaved agent */ })
      expect(originUrl()).toBe(withToken)
    })
  })

  it('runs the body when there is no origin at all', async () => {
    let ran = false
    await withCredentialFreeOrigin(dir, async () => { ran = true })
    expect(ran).toBe(true)
  })
})
