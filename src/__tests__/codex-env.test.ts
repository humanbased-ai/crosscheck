import { describe, it, expect } from 'vitest'
import { buildCodexEnv, isAllowedCodexEnvKey } from '../reviewers/codex-env.js'

// Codex reads attacker-controlled text and, with skills.codex_full_access, runs
// unsandboxed. Every codex subprocess used to inherit the whole of process.env,
// so a prompt-injected shell command could print GITHUB_TOKEN. Six BLOCK reviews
// on #298 named this. The guarantee under test: what is not in the process cannot
// be taken out of it.
describe('buildCodexEnv', () => {
  const source = {
    PATH: '/usr/bin',
    HOME: '/home/dev',
    LANG: 'en_US.UTF-8',
    LC_ALL: 'en_US.UTF-8',
    HTTPS_PROXY: 'http://proxy:8080',
    OPENAI_API_KEY: 'sk-real',
    GIT_CONFIG_NOSYSTEM: '1',
    GIT_CONFIG_GLOBAL: '/dev/null',
    // None of these may survive.
    GITHUB_TOKEN: 'ghp_secret',
    GH_TOKEN: 'gho_secret',
    ANTHROPIC_API_KEY: 'sk-ant-secret',
    LINEAR_API_KEY: 'lin_secret',
    CROSSCHECK_WEBHOOK_SECRET: 'whsec',
    AWS_SECRET_ACCESS_KEY: 'aws_secret',
    NPM_TOKEN: 'npm_secret',
  }

  it('keeps what codex needs to run and authenticate', () => {
    const env = buildCodexEnv({}, source)
    expect(env.PATH).toBe('/usr/bin')
    expect(env.HOME).toBe('/home/dev')
    expect(env.OPENAI_API_KEY).toBe('sk-real')
    expect(env.HTTPS_PROXY).toBe('http://proxy:8080')
    expect(env.LC_ALL).toBe('en_US.UTF-8')
    expect(env.GIT_CONFIG_NOSYSTEM).toBe('1')
    expect(env.GIT_CONFIG_GLOBAL).toBe('/dev/null')
  })

  it('drops every credential that is not codex\'s own', () => {
    const env = buildCodexEnv({}, source)
    for (const key of ['GITHUB_TOKEN', 'GH_TOKEN', 'ANTHROPIC_API_KEY', 'LINEAR_API_KEY',
      'CROSSCHECK_WEBHOOK_SECRET', 'AWS_SECRET_ACCESS_KEY', 'NPM_TOKEN']) {
      expect(env).not.toHaveProperty(key)
    }
  })

  // The property that matters more than any single name: a secret nobody thought
  // to denylist is still absent, because the default is to drop.
  it('drops an unknown variable it has never heard of', () => {
    const env = buildCodexEnv({}, { PATH: '/usr/bin', SOME_FUTURE_INTEGRATION_TOKEN: 'nope' })
    expect(env).not.toHaveProperty('SOME_FUTURE_INTEGRATION_TOKEN')
    expect(env.PATH).toBe('/usr/bin')
  })

  it('applies overrides last and without filtering them', () => {
    const env = buildCodexEnv({ PATH: '/repo/node_modules/.bin:/usr/bin', CODEX_QUIET_MODE: '1' }, source)
    expect(env.PATH).toBe('/repo/node_modules/.bin:/usr/bin')
    // Deliberately set by the caller, so it is not subject to the allowlist.
    expect(env.CODEX_QUIET_MODE).toBe('1')
  })

  it('omits an allowed key that is simply unset', () => {
    const env = buildCodexEnv({}, { PATH: '/usr/bin' })
    expect(env).not.toHaveProperty('HOME')
  })
})

describe('isAllowedCodexEnvKey', () => {
  it('allows exact names and the LC_ prefix', () => {
    expect(isAllowedCodexEnvKey('HOME')).toBe(true)
    expect(isAllowedCodexEnvKey('LC_TIME')).toBe(true)
    expect(isAllowedCodexEnvKey('no_proxy')).toBe(true)
  })

  it('rejects near-misses rather than pattern-matching loosely', () => {
    expect(isAllowedCodexEnvKey('HOMEBREW_GITHUB_API_TOKEN')).toBe(false)
    expect(isAllowedCodexEnvKey('PATH_TO_SECRET')).toBe(false)
    expect(isAllowedCodexEnvKey('MY_LC_KEY')).toBe(false)
  })
})
