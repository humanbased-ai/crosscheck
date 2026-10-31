import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { createVerify, generateKeyPairSync } from 'crypto'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  clearGithubAppCache,
  getInstallationToken,
  probeGithubApp,
  signAppJwt,
  type GithubAppKey,
} from '../github/client.js'
import {
  clearGithubAppConfig,
  resolveGithubAppKey,
  resolveReviewerToken,
  writeGithubAppConfig,
} from '../config/loader.js'
import { ConfigSchema } from '../config/schema.js'

const { privateKey, publicKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const key: GithubAppKey = { appId: 1234567, privateKey }

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

interface Route {
  match: (url: string, method: string) => boolean
  respond: () => Response
}

function stubFetch(routes: Route[]): ReturnType<typeof vi.fn> {
  const calls: Array<{ url: string; method: string }> = []
  const fn = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input)
    const method = init?.method ?? 'GET'
    calls.push({ url, method })
    const route = routes.find(r => r.match(url, method))
    if (!route) throw new Error(`unexpected fetch ${method} ${url}`)
    return route.respond()
  })
  vi.stubGlobal('fetch', fn)
  return fn
}

function configWithApp(overrides: Record<string, unknown> = {}) {
  return ConfigSchema.parse({
    github: {
      app: {
        app_id: 1234567,
        installation_id: null,
        private_key_path: '~/.crosscheck/app.pem',
        private_key_env: 'CK_TEST_APP_KEY',
        ...overrides,
      },
    },
  })
}

const happyRoutes: Route[] = [
  { match: (url, method) => url.endsWith('/app') && method === 'GET', respond: () => json({ id: 1234567, slug: 'crosscheck-bot', name: 'crosscheck-bot' }) },
  { match: url => url.includes('/repos/acme/widgets/installation'), respond: () => json({ id: 9, account: { login: 'acme' }, target_type: 'Organization', permissions: { pull_requests: 'write', issues: 'write' } }) },
  { match: (url, method) => url.includes('/app/installations/9/access_tokens') && method === 'POST', respond: () => json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() }) },
  { match: (url, method) => url.endsWith('/repos/acme/widgets') && method === 'GET', respond: () => json({ id: 1 }) },
]

beforeEach(() => {
  clearGithubAppCache()
  delete process.env.CK_TEST_APP_KEY
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearGithubAppCache()
  delete process.env.CK_TEST_APP_KEY
})

describe('signAppJwt', () => {
  it('builds a verifiable RS256 JWT with the app id as issuer', () => {
    const now = 1_700_000_000_000
    const jwt = signAppJwt(key, now)
    const [header, payload, signature] = jwt.split('.')
    expect(JSON.parse(Buffer.from(header, 'base64url').toString())).toEqual({ alg: 'RS256', typ: 'JWT' })
    expect(JSON.parse(Buffer.from(payload, 'base64url').toString())).toEqual({
      iat: Math.floor(now / 1000) - 60,
      exp: Math.floor(now / 1000) + 540,
      iss: 1234567,
    })
    const verifier = createVerify('RSA-SHA256')
    verifier.update(`${header}.${payload}`)
    expect(verifier.verify(publicKey, Buffer.from(signature, 'base64url'))).toBe(true)
  })

  it('throws on a key that is not a private RSA key', () => {
    expect(() => signAppJwt({ appId: 1, privateKey: 'not a pem' })).toThrow()
  })
})

describe('getInstallationToken', () => {
  it('mints once and reuses the cached token', async () => {
    const fetchMock = stubFetch(happyRoutes.filter(r => r.match('https://api.github.com/app/installations/9/access_tokens', 'POST')))
    const first = await getInstallationToken(key, 9)
    const second = await getInstallationToken(key, 9)
    expect(first).toBe('ghs_test')
    expect(second).toBe('ghs_test')
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('re-mints before expiry', async () => {
    let n = 0
    const fetchMock = stubFetch([{
      match: (url, method) => url.includes('/access_tokens') && method === 'POST',
      respond: () => {
        n++
        return json({ token: `ghs_${n}`, expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      },
    }])
    expect(await getInstallationToken(key, 9)).toBe('ghs_1')
    // Inside the 60s refresh margin: a token that expires in 30s must not be reused.
    expect(await getInstallationToken(key, 9, Date.now() + 3_570_000)).toBe('ghs_2')
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })
})

describe('probeGithubApp', () => {
  it('passes every check for a installed app with the right permissions', async () => {
    stubFetch(happyRoutes)
    const result = await probeGithubApp({ key, owner: 'acme', repo: 'widgets' })
    expect(result.ok).toBe(true)
    expect(result.login).toBe('crosscheck-bot[bot]')
    expect(result.installation?.id).toBe(9)
    expect(result.checks.map(c => c.step)).toEqual([
      'private key', 'app credentials', 'installation', 'repo access', 'permissions',
    ])
  })

  it('reports a rejected app id/key and stops before installation checks', async () => {
    stubFetch([{ match: url => url.endsWith('/app'), respond: () => json({ message: 'Bad credentials' }, 401) }])
    const result = await probeGithubApp({ key, owner: 'acme', repo: 'widgets' })
    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(2)
    expect(result.checks[1].step).toBe('app credentials')
    expect(result.checks[1].ok).toBe(false)
    expect(result.checks[1].fix).toMatch(/app-id/)
  })

  it('reports an unknown app id separately from a rejected key', async () => {
    stubFetch([{ match: url => url.endsWith('/app'), respond: () => json({ message: 'Integration not found' }, 404) }])
    const result = await probeGithubApp({ key, owner: 'acme', repo: 'widgets' })
    expect(result.ok).toBe(false)
    const credentials = result.checks.find(c => c.step === 'app credentials')
    expect(credentials?.detail).toContain('no app with id 1234567')
    expect(credentials?.fix).toContain('check --app-id')
  })

  it('reports an app that is not installed on the repo', async () => {
    stubFetch([
      { match: url => url.endsWith('/app'), respond: () => json({ id: 1234567, slug: 'crosscheck-bot', name: 'crosscheck-bot' }) },
      { match: url => url.includes('/installation'), respond: () => json({ message: 'Not Found' }, 404) },
    ])
    const result = await probeGithubApp({ key, owner: 'acme', repo: 'widgets' })
    expect(result.ok).toBe(false)
    const installation = result.checks.find(c => c.step === 'installation')
    expect(installation?.ok).toBe(false)
    expect(installation?.detail).toContain('not installed on acme/widgets')
    expect(installation?.fix).toContain('installations/new')
  })

  it('reports missing write permissions with the settings URL', async () => {
    stubFetch([
      { match: url => url.endsWith('/app'), respond: () => json({ id: 1234567, slug: 'crosscheck-bot', name: 'crosscheck-bot' }) },
      { match: url => url.includes('/repos/acme/widgets/installation'), respond: () => json({ id: 9, account: { login: 'acme' }, target_type: 'Organization', permissions: { pull_requests: 'read', issues: 'write' } }) },
      { match: (url, method) => url.includes('/app/installations/9/access_tokens') && method === 'POST', respond: () => json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() }) },
      { match: (url, method) => url.endsWith('/repos/acme/widgets') && method === 'GET', respond: () => json({ id: 1 }) },
    ])
    const result = await probeGithubApp({ key, owner: 'acme', repo: 'widgets' })
    expect(result.ok).toBe(false)
    const permissions = result.checks.find(c => c.step === 'permissions')
    expect(permissions?.ok).toBe(false)
    expect(permissions?.fix).toContain('organizations/acme/settings/apps/crosscheck-bot/permissions')
  })

  it('fails the private key check without touching the network', async () => {
    const fetchMock = stubFetch([])
    const result = await probeGithubApp({ key: { appId: 1, privateKey: 'bad' } })
    expect(result.ok).toBe(false)
    expect(result.checks).toHaveLength(1)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('resolveGithubAppKey', () => {
  it('returns null when no app is configured', () => {
    expect(resolveGithubAppKey(ConfigSchema.parse({}))).toBeNull()
  })

  it('reads the PEM from the configured env var', () => {
    process.env.CK_TEST_APP_KEY = privateKey
    const resolved = resolveGithubAppKey(configWithApp())
    expect(resolved?.appId).toBe(1234567)
    expect(resolved?.privateKey).toContain('BEGIN PRIVATE KEY')
  })

  it('normalises a one-line PEM with literal \\n escapes', () => {
    process.env.CK_TEST_APP_KEY = privateKey.replace(/\n/g, '\\n')
    const resolved = resolveGithubAppKey(configWithApp())
    expect(resolved?.privateKey).toContain('\n')
  })

  it('throws with the fix when the key file is missing', () => {
    const config = configWithApp({ private_key_env: 'CK_TEST_APP_KEY_UNSET', private_key_path: '/nonexistent/crosscheck/app.pem' })
    expect(() => resolveGithubAppKey(config)).toThrow(/not found at \/nonexistent\/crosscheck\/app\.pem/)
    expect(() => resolveGithubAppKey(config)).toThrow(/ck auth app/)
  })
})

describe('resolveReviewerToken', () => {
  it('falls back to the user token when no app is configured', async () => {
    process.env.GITHUB_TOKEN = 'ghp_user_token'
    const result = await resolveReviewerToken(ConfigSchema.parse({}))
    expect(result.source).toBe('user')
    expect(result.token.length).toBeGreaterThan(0)
    expect(result.login).toBeNull()
    delete process.env.GITHUB_TOKEN
  })

  it('resolves the installation from the repo and returns the bot login', async () => {
    process.env.CK_TEST_APP_KEY = privateKey
    stubFetch(happyRoutes)
    const result = await resolveReviewerToken(configWithApp(), { owner: 'acme', repo: 'widgets' })
    expect(result).toMatchObject({ source: 'app', appId: 1234567, installationId: 9, login: 'crosscheck-bot[bot]' })
    expect(result.token).toBe('ghs_test')
  })

  it('does not silently fall back when a configured app is broken', async () => {
    process.env.CK_TEST_APP_KEY = privateKey
    stubFetch([{ match: url => url.endsWith('/app'), respond: () => json({ message: 'Bad credentials' }, 401) }])
    await expect(resolveReviewerToken(configWithApp(), { owner: 'acme', repo: 'widgets' }))
      .rejects.toThrow(/configured but unusable[\s\S]*ck auth app --check/)
  })
})

describe('config write helpers', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ck-app-'))
    configPath = join(dir, 'config.yml')
    writeFileSync(configPath, 'mode: cross-vendor\nbrand:\n  service_name: acme\n')
  })

  afterEach(() => rmSync(dir, { recursive: true, force: true }))

  it('writes the app block without disturbing other fields', () => {
    writeGithubAppConfig(configPath, { appId: 1234567, installationId: 98765432, privateKeyPath: '~/.crosscheck/app.pem' })
    const raw = readFileSync(configPath, 'utf8')
    expect(raw).toContain('mode: cross-vendor')
    expect(raw).toContain('service_name: acme')
    expect(raw).toContain('app_id: 1234567')
    expect(raw).toContain('installation_id: 98765432')
  })

  it('clears only the app block', () => {
    writeGithubAppConfig(configPath, { appId: 1234567, installationId: null, privateKeyPath: null })
    expect(clearGithubAppConfig(configPath)).toBe(true)
    const raw = readFileSync(configPath, 'utf8')
    expect(raw).not.toContain('app_id')
    expect(raw).toContain('mode: cross-vendor')
    expect(clearGithubAppConfig(configPath)).toBe(false)
  })
})
