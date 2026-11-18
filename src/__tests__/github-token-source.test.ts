/**
 * Which credential posts a verdict (IN-7752, Revision 6.1).
 *
 * On `main` the hotfix autopilot runs in `autonomous` mode and decides whether a
 * review verdict is trustworthy from the account that posted it. Crosscheck used
 * to post as a person, so anything holding that login could approve a merge. An
 * App installation token is the fix — but only if it actually wins the
 * resolution, which is what these cases pin.
 *
 * The trap they exist for: `getGithubTokenSource()` asks `gh auth token` first
 * (with the env token stripped so the keyring answers). A new source added
 * *after* that call would therefore do nothing on any machine with a `gh`
 * session — which is every machine that runs crosscheck. The App token has to
 * come first, and a test is the only thing that notices if a later refactor
 * moves it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'

const execSync = vi.fn()
vi.mock('child_process', () => ({ execSync: (...args: unknown[]) => execSync(...args) }))

import { getGithubTokenSource } from '../config/loader.js'

const ENV_KEYS = ['CROSSCHECK_APP_TOKEN', 'CROSSCHECK_APP_TOKEN_FILE', 'GITHUB_TOKEN', 'GH_TOKEN'] as const
let saved: Record<string, string | undefined> = {}
let tmpDir = ''

beforeEach(() => {
  saved = {}
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
    delete process.env[k]
  }
  execSync.mockReset()
  tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-apptoken-'))
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('an App token outranks the keyring', () => {
  it('uses CROSSCHECK_APP_TOKEN even when gh would answer', () => {
    execSync.mockReturnValue('gho_keyring_token\n')
    process.env.CROSSCHECK_APP_TOKEN = 'ghs_app_token'

    expect(getGithubTokenSource()).toEqual({ token: 'ghs_app_token', source: 'app' })
    expect(execSync).not.toHaveBeenCalled()
  })

  it('reads CROSSCHECK_APP_TOKEN_FILE, trimming the trailing newline', () => {
    const file = join(tmpDir, 'token')
    writeFileSync(file, 'ghs_from_file\n')
    process.env.CROSSCHECK_APP_TOKEN_FILE = file

    expect(getGithubTokenSource()).toEqual({ token: 'ghs_from_file', source: 'app' })
  })

  it('re-reads the file on every call, so a re-mint is picked up', () => {
    const file = join(tmpDir, 'token')
    writeFileSync(file, 'ghs_first\n')
    process.env.CROSSCHECK_APP_TOKEN_FILE = file
    expect(getGithubTokenSource()?.token).toBe('ghs_first')

    writeFileSync(file, 'ghs_second\n')
    expect(getGithubTokenSource()?.token).toBe('ghs_second')
  })
})

describe('nothing about the existing sources changed when no App token is set', () => {
  it('still prefers the gh keyring', () => {
    execSync.mockReturnValue('gho_keyring_token\n')

    expect(getGithubTokenSource()).toEqual({ token: 'gho_keyring_token', source: 'gh-keyring' })
  })

  it('still falls back to GITHUB_TOKEN when gh has no session', () => {
    execSync.mockImplementation(() => { throw new Error('no session') })
    process.env.GITHUB_TOKEN = 'ghp_personal'

    expect(getGithubTokenSource()).toEqual({ token: 'ghp_personal', source: 'env' })
  })

  it('ignores an empty App token instead of shadowing everything', () => {
    execSync.mockReturnValue('gho_keyring_token\n')
    process.env.CROSSCHECK_APP_TOKEN = '   '

    expect(getGithubTokenSource()).toEqual({ token: 'gho_keyring_token', source: 'gh-keyring' })
  })

  it('falls through to the keyring when the token file cannot be read', () => {
    execSync.mockReturnValue('gho_keyring_token\n')
    process.env.CROSSCHECK_APP_TOKEN_FILE = join(tmpDir, 'missing')

    expect(getGithubTokenSource()).toEqual({ token: 'gho_keyring_token', source: 'gh-keyring' })
  })
})
