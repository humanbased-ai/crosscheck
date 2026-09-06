import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { appendFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { CompromisedCloneError, isolateGitConfig, withCredentialFreeOrigin } from '../lib/clone.js'

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

    // The trusted config snapshot removes the re-point after the agent exits.
    it('neutralises a plain core.hooksPath re-point and restores the credential', async () => {
      setOrigin(withToken)

      await withCredentialFreeOrigin(dir, async () => {
        execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir })
      })

      expect(effectiveHooksPath()).toBe('/dev/null')
      expect(originUrl()).toBe(withToken)
    })

    it('neutralises a core.hooksPath re-point for an SSH remote', async () => {
      const ssh = 'git@github.com:o/r.git'
      setOrigin(ssh)

      await withCredentialFreeOrigin(dir, async () => {
        execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir })
      })

      expect(effectiveHooksPath()).toBe('/dev/null')
      expect(originUrl()).toBe(ssh)
    })

    it('neutralises a core.hooksPath re-point without an origin', async () => {
      await withCredentialFreeOrigin(dir, async () => {
        execFileSync('git', ['config', 'core.hooksPath', '.git/hooks'], { cwd: dir })
      })

      expect(effectiveHooksPath()).toBe('/dev/null')
    })

    it('removes a re-point hidden behind an include', async () => {
      setOrigin(withToken)

      await withCredentialFreeOrigin(dir, async () => {
        writeFileSync(join(dir, 'evil.cfg'), '[core]\n\thooksPath = .git/hooks\n')
        appendFileSync(join(dir, '.git', 'config'), '[include]\n\tpath = ../evil.cfg\n')
      })

      expect(effectiveHooksPath()).toBe('/dev/null')
      expect(originUrl()).toBe(withToken)
    })

    it('restores non-hook config that could execute during later Git commands', async () => {
      const monitor = join(dir, 'fsmonitor.sh')
      const marker = join(dir, 'fsmonitor-ran')
      writeFileSync(monitor, '#!/bin/sh\nprintf ran > fsmonitor-ran\n')
      chmodSync(monitor, 0o755)

      await withCredentialFreeOrigin(dir, async () => {
        execFileSync('git', ['config', 'core.fsmonitor', monitor], { cwd: dir })
        execFileSync('git', ['status', '--short'], { cwd: dir, stdio: 'pipe' })
        expect(existsSync(marker)).toBe(true)
        rmSync(marker)
      })

      execFileSync('git', ['status', '--short'], { cwd: dir, stdio: 'pipe' })
      expect(existsSync(marker)).toBe(false)
      expect(() => execFileSync('git', ['config', '--get', 'core.fsmonitor'], { cwd: dir, stdio: 'pipe' })).toThrow()
    })

    it('leaves the origin scrubbed when a pre-existing include is changed', async () => {
      const included = join(dir, 'trusted.cfg')
      writeFileSync(included, '[user]\n\tname = trusted\n')
      appendFileSync(join(dir, '.git', 'config'), `[include]\n\tpath = ${included}\n`)
      setOrigin(withToken)

      await expect(withCredentialFreeOrigin(dir, async () => {
        writeFileSync(included, '[user]\n\tname = changed\n')
      })).rejects.toBeInstanceOf(CompromisedCloneError)

      expect(originUrl()).toBe('https://github.com/o/r.git')
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

describe('isolated Git config', () => {
  const envKeys = [
    'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
    'GIT_AUTHOR_NAME', 'GIT_AUTHOR_EMAIL', 'GIT_COMMITTER_NAME', 'GIT_COMMITTER_EMAIL',
  ] as const
  let root: string
  let savedEnv: Partial<Record<(typeof envKeys)[number], string>>

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), 'crosscheck-git-config-'))
    savedEnv = {}
    for (const key of envKeys) {
      if (process.env[key] !== undefined) savedEnv[key] = process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      const value = savedEnv[key]
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(root, { force: true, recursive: true })
  })

  it('prevents a poisoned global hooksPath from reaching a later clone', () => {
    const source = join(root, 'source')
    const hooks = join(root, 'hooks')
    const marker = join(root, 'hook-ran')
    const poisonedConfig = join(root, 'global.gitconfig')
    execFileSync('git', ['init', '-q', source])
    writeFileSync(join(source, 'file.txt'), 'content\n')
    execFileSync('git', ['-C', source, 'add', 'file.txt'])
    execFileSync('git', ['-C', source, '-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-qm', 'initial'])
    mkdirSync(hooks)
    writeFileSync(join(hooks, 'post-checkout'), `#!/bin/sh\nprintf ran > ${JSON.stringify(marker)}\n`)
    chmodSync(join(hooks, 'post-checkout'), 0o755)
    execFileSync('git', ['config', '--file', poisonedConfig, 'core.hooksPath', hooks])

    const poisonedEnv = { ...process.env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: poisonedConfig }
    execFileSync('git', ['clone', '-q', source, join(root, 'control')], { env: poisonedEnv })
    expect(existsSync(marker)).toBe(true)
    rmSync(marker)

    process.env.GIT_CONFIG_GLOBAL = poisonedConfig
    isolateGitConfig()
    execFileSync('git', ['clone', '-q', source, join(root, 'isolated')])

    expect(process.env.GIT_CONFIG_GLOBAL).toBe(process.platform === 'win32' ? 'NUL' : '/dev/null')
    expect(existsSync(marker)).toBe(false)
  })
})
