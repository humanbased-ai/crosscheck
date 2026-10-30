import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { delimiter, join } from 'path'
import { fileURLToPath } from 'url'
import { clonePRForReview, gitCredentialEnv, isolateGitConfig } from '../lib/clone.js'
import { pushWithNonFastForwardHandling } from '../lib/runner.js'

// `ps` and `pgrep -fl` show every git process's arguments to anyone on the machine, so
// these tests collect those same arguments in one file. GIT_TRACE records the children,
// including the git-remote-http that a URL-borne token also reaches, but prints each
// command after git has consumed options like `-c`. A shim ahead of git on PATH records
// the command lines crosscheck itself starts, exactly as `ps` shows them. Each assertion
// also checks that the file caught the command it is about, so an empty one cannot pass.

const TOKEN = 'ghs_doNotShowThisInPs'

const fakeGithub = vi.hoisted(() => ({ origin: '', credentialHost: 'https://github.com' }))

vi.mock('../github/client.js', async importOriginal => ({
  ...await importOriginal<typeof import('../github/client.js')>(),
  getMergeBase: vi.fn(async (_owner: string, _repo: string, base: string, head: string) =>
    execFileSync('git', ['merge-base', base, head], { cwd: fakeGithub.origin, encoding: 'utf8' }).trim()),
}))

// The helper answers for github.com only, so the tests that talk to the local server
// point just that one key at it. Everything else is the real environment.
vi.mock('../lib/clone.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/clone.js')>()
  return {
    ...actual,
    gitCredentialEnv: (token: string): NodeJS.ProcessEnv => {
      const env = actual.gitCredentialEnv(token)
      const key = Object.keys(env).find(name => env[name] === 'credential.https://github.com.helper') as string
      return { ...env, [key]: `credential.${fakeGithub.credentialHost}.helper` }
    },
  }
})

const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

const ENV_KEYS = ['HOME', 'PATH', 'GIT_TRACE', 'GIT_CONFIG_COUNT', 'GIT_CONFIG_KEY_0', 'GIT_CONFIG_VALUE_0'] as const
const savedEnv = Object.fromEntries(ENV_KEYS.map(key => [key, process.env[key]]))

let root: string
let traceFile: string
const trace = (): string => readFileSync(traceFile, 'utf8')

// Started before GIT_TRACE is set, so only the client's git processes write to the trace.
function serveGitRepositories(projectRoot: string, token: string): Promise<{ server: ChildProcess; url: string }> {
  const server = spawn(process.execPath, [fileURLToPath(new URL('./fixtures/git-http-server.mjs', import.meta.url))], {
    env: {
      ...process.env,
      GIT_PROJECT_ROOT: projectRoot,
      EXPECTED_AUTHORIZATION: `Basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}`,
    },
    stdio: ['ignore', 'pipe', 'inherit'],
  })
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.stdout?.once('data', (port: Buffer) => resolve({ server, url: `http://127.0.0.1:${String(port).trim()}` }))
  })
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'clone-token-test-'))
  traceFile = join(root, 'git-trace.log')
  writeFileSync(traceFile, '')
  process.env.HOME = join(root, 'home')
  const realGit = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim()
  const shimDir = join(root, 'bin')
  mkdirSync(shimDir)
  writeFileSync(join(shimDir, 'git'), `#!/bin/sh\n[ -n "$GIT_TRACE" ] && printf 'argv: git %s\\n' "$*" >> "$GIT_TRACE"\nexec "${realGit}" "$@"\n`, { mode: 0o755 })
  process.env.PATH = `${shimDir}${delimiter}${process.env.PATH}`
  isolateGitConfig()
  fakeGithub.credentialHost = 'https://github.com'
})

afterEach(() => {
  for (const key of ENV_KEYS) {
    const value = savedEnv[key]
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  rmSync(root, { recursive: true, force: true })
})

describe('gitCredentialEnv', () => {
  const fill = (host: string, env: NodeJS.ProcessEnv): string =>
    execFileSync('git', ['credential', 'fill'], {
      input: `protocol=https\nhost=${host}\n\n`,
      env: { ...process.env, ...env },
      encoding: 'utf8',
      stdio: ['pipe', 'pipe', 'pipe'],
    })

  it('answers git for github.com', () => {
    expect(fill('github.com', gitCredentialEnv(TOKEN))).toContain(`username=x-access-token\npassword=${TOKEN}\n`)
  })

  it('gives the token to no other host', () => {
    expect(() => fill('example.com', gitCredentialEnv(TOKEN))).toThrow(/terminal prompts disabled/)
  })

  it('does not write the token into the helper command, which a shell would show in ps', () => {
    const env = gitCredentialEnv(TOKEN)
    const configValues = Object.entries(env).filter(([name]) => name.startsWith('GIT_CONFIG_')).map(([, value]) => value)

    expect(configValues.join('\n')).not.toContain(TOKEN)
  })

  it('keeps config entries already in the environment', () => {
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = 'url.https://mirror.example.test/.insteadOf'
    process.env.GIT_CONFIG_VALUE_0 = 'https://github.com/'

    const env = { ...process.env, ...gitCredentialEnv(TOKEN) }

    expect(execFileSync('git', ['config', '--get-regexp', '^url\\.'], { env, encoding: 'utf8' })).toContain('mirror.example.test')
    expect(fill('github.com', gitCredentialEnv(TOKEN))).toContain(`password=${TOKEN}`)
  })

  it('leaves process.env alone, because vendor agents inherit it', () => {
    gitCredentialEnv(TOKEN)

    expect(JSON.stringify(process.env)).not.toContain(TOKEN)
  })
})

describe('talking to a remote that requires the token', { timeout: 30_000 }, () => {
  let remote: { server: ChildProcess; url: string }
  let bare: string

  beforeEach(async () => {
    const seed = join(root, 'seed')
    bare = join(root, 'remote', 'team', 'repo.git')
    mkdirSync(seed)
    mkdirSync(join(root, 'remote', 'team'), { recursive: true })
    git(seed, 'init', '-q', '-b', 'main')
    git(seed, 'config', 'user.name', 'Test Reviewer')
    git(seed, 'config', 'user.email', 'reviewer@example.test')
    writeFileSync(join(seed, 'file.txt'), 'first\n')
    git(seed, 'add', '.')
    git(seed, 'commit', '-qm', 'Initial')
    git(root, 'clone', '-q', '--bare', seed, bare)
    remote = await serveGitRepositories(join(root, 'remote'), TOKEN)
    fakeGithub.credentialHost = remote.url
    process.env.GIT_TRACE = traceFile
  })

  afterEach(async () => {
    delete process.env.GIT_TRACE
    remote.server.kill()
    await new Promise(resolve => remote.server.once('close', resolve))
  })

  const cloneAuthenticated = async (destination: string, token: string): Promise<void> => {
    await new Promise<void>((resolve, reject) => {
      const child = spawn('git', ['clone', '-q', `${remote.url}/team/repo.git`, destination], {
        env: { ...process.env, ...gitCredentialEnv(token) },
        stdio: ['ignore', 'ignore', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', chunk => { stderr += String(chunk) })
      child.on('close', code => { if (code === 0) resolve(); else reject(new Error(stderr)) })
    })
  }

  it('clones over HTTP with the token nowhere in any command line or on disk', async () => {
    const checkout = join(root, 'checkout')

    await cloneAuthenticated(checkout, TOKEN)

    expect(readFileSync(join(checkout, 'file.txt'), 'utf8')).toBe('first\n')
    expect(trace()).toContain('remote-http')
    expect(trace()).not.toContain(TOKEN)
    expect(readFileSync(join(checkout, '.git', 'config'), 'utf8')).not.toContain(TOKEN)
  })

  it('fails on a rejected token instead of waiting on a prompt', async () => {
    await expect(cloneAuthenticated(join(root, 'denied'), 'ghs_revoked')).rejects.toThrow(/Authentication failed/)
  })

  it("pushes a fix through the runner's push path from a checkout whose origin has no token", async () => {
    const checkout = join(root, 'checkout')
    await cloneAuthenticated(checkout, TOKEN)
    git(checkout, 'config', 'user.name', 'Test Reviewer')
    git(checkout, 'config', 'user.email', 'reviewer@example.test')
    writeFileSync(join(checkout, 'file.txt'), 'fixed\n')
    git(checkout, 'commit', '-qam', 'Fix')
    writeFileSync(traceFile, '')

    await pushWithNonFastForwardHandling({
      tmpDir: checkout, branch: 'fix-branch', token: TOKEN,
      log: () => {}, fileLog: () => {},
      owner: 'team', repoName: 'repo', prNumber: 7,
    })

    expect(git(bare, 'rev-parse', 'refs/heads/fix-branch')).toBe(git(checkout, 'rev-parse', 'HEAD'))
    expect(trace()).toContain('argv: git -c core.hooksPath=/dev/null push origin')
    expect(trace()).not.toContain(TOKEN)
  })
})

describe('clonePRForReview', { timeout: 30_000 }, () => {
  const CLONE_URL = 'https://github.com/team/repo.git'
  let origin: string

  beforeEach(() => {
    origin = join(root, 'origin')
    mkdirSync(origin)
    git(origin, 'init', '-q', '-b', 'main')
    git(origin, 'config', 'user.name', 'Test Reviewer')
    git(origin, 'config', 'user.email', 'reviewer@example.test')
    writeFileSync(join(origin, 'file.txt'), 'first\n')
    git(origin, 'add', '.')
    git(origin, 'commit', '-qm', 'Initial')
    git(origin, 'branch', 'staging')
    git(origin, 'checkout', '-qb', 'feature')
    writeFileSync(join(origin, 'file.txt'), 'second\n')
    git(origin, 'commit', '-qam', 'Change')
    git(origin, 'update-ref', 'refs/pull/7/head', 'HEAD')
    git(origin, 'checkout', '-q', 'main')
    fakeGithub.origin = origin
    // The clone URL is github.com; git rewrites it to the local origin.
    process.env.GIT_CONFIG_COUNT = '1'
    process.env.GIT_CONFIG_KEY_0 = `url.file://${origin}.insteadOf`
    process.env.GIT_CONFIG_VALUE_0 = CLONE_URL
    process.env.GIT_TRACE = traceFile
  })

  afterEach(() => { delete process.env.GIT_TRACE })

  it.each([
    ['a fresh clone', false],
    ['a cached checkout', true],
  ])('never puts the token in a command line or the checkout for %s', async (_label, repositoryCache) => {
    const tmpDir = mkdtempSync(join(root, 'checkout-'))

    await clonePRForReview({
      owner: 'team', repo: 'repo', prNumber: 7, baseRef: 'staging',
      tmpDir, token: TOKEN, protocol: 'https', repositoryCache,
    })

    expect(readFileSync(join(tmpDir, 'file.txt'), 'utf8')).toBe('second\n')
    expect(trace()).toContain(`argv: git -c http.postBuffer`)
    expect(trace()).toContain(CLONE_URL)
    expect(trace()).not.toContain(TOKEN)
    // Read from the config: `remote get-url` would answer with the rewritten URL.
    expect(git(tmpDir, 'config', '--get', 'remote.origin.url')).toBe(CLONE_URL)
    expect(readFileSync(join(tmpDir, '.git', 'config'), 'utf8')).not.toContain(TOKEN)
    const cacheRoot = join(root, 'home', '.crosscheck', 'repository-cache')
    if (existsSync(cacheRoot)) {
      const caches = readdirSync(cacheRoot).filter(name => name.endsWith('.git'))
      expect(caches.map(name => readFileSync(join(cacheRoot, name, 'config'), 'utf8')).join('')).not.toContain(TOKEN)
    }
  })
})
