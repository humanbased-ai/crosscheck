import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { generateKeyPairSync } from 'crypto'
import { ConfigSchema, type Config } from '../config/schema.js'
import { clearGithubAppCache } from '../github/client.js'
import {
  branchProtectionAdvisory,
  inspectReviewerIdentity,
  resolveReviewerIdentity,
} from '../lib/reviewer-identity.js'

// detectGitHubLogin shells out to `gh`; the identity logic is what is under test.
vi.mock('../config/loader.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../config/loader.js')>()
  return { ...actual, detectGitHubLogin: () => 'beingzy' }
})

const { privateKey } = generateKeyPairSync('rsa', {
  modulusLength: 2048,
  publicKeyEncoding: { type: 'spki', format: 'pem' },
  privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
})

const APP_ENV = 'CK_TEST_IDENTITY_APP_KEY'

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
}

function stubFetch(handler: (url: string, method: string) => Response | undefined): void {
  vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    // Octokit percent-encodes path segments (`.github%2FCODEOWNERS`); match on the
    // readable form. Unmatched requests get a 404 rather than a throw — a thrown
    // error is retried by Octokit and turns a wrong route into a timeout.
    const url = decodeURIComponent(String(input))
    return handler(url, init?.method ?? 'GET') ?? json({ message: 'not found' }, 404)
  }))
}

function config(overrides: Record<string, unknown> = {}, repos: Array<{ owner: string; name: string }> = []): Config {
  return ConfigSchema.parse({
    repos,
    github: { app: { app_id: null, installation_id: null, private_key_env: APP_ENV, ...overrides } },
  })
}

const appConfig = (repos: Array<{ owner: string; name: string }> = []) =>
  config({ app_id: 1234567 }, repos)

beforeEach(() => {
  clearGithubAppCache()
  process.env[APP_ENV] = privateKey
})

afterEach(() => {
  vi.unstubAllGlobals()
  clearGithubAppCache()
  delete process.env[APP_ENV]
})

describe('reviewer identity without an app', () => {
  it('reports the operator and warns that self-reviews look like self-review', async () => {
    const report = await inspectReviewerIdentity(config())
    expect(report.ok).toBe(true)
    expect(report.detail).toContain('@beingzy')
    expect(report.detail).toContain('comments post as you')
    expect(report.notes[0]).toContain('ck auth app')
  })

  it('describes the board label as the operator', async () => {
    await expect(resolveReviewerIdentity(config())).resolves.toEqual({ label: '@beingzy', kind: 'user' })
  })
})

describe('reviewer identity with an app', () => {
  it('reports the bot login when every probe passes', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/app') && method === 'GET') return json({ id: 1234567, slug: 'crosscheck-bot', name: 'crosscheck-bot' })
      if (url.includes('/repos/acme/widgets/installation')) return json({ id: 9, account: { login: 'acme' }, target_type: 'Organization', permissions: { pull_requests: 'write', issues: 'write' } })
      if (url.includes('/app/installations/9/access_tokens') && method === 'POST') return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      if (url.endsWith('/repos/acme/widgets') && method === 'GET') return json({ id: 1, default_branch: 'main' })
      return undefined
    })
    const report = await inspectReviewerIdentity(appConfig([{ owner: 'acme', name: 'widgets' }]))
    expect(report.ok).toBe(true)
    expect(report.detail).toContain('crosscheck-bot[bot]')
    expect(report.notes).toEqual([])
  })

  it('fails the row, with the fix, when the app cannot post', async () => {
    stubFetch((url) => {
      if (url.endsWith('/app')) return json({ message: 'Bad credentials' }, 401)
      return undefined
    })
    const report = await inspectReviewerIdentity(appConfig([{ owner: 'acme', name: 'widgets' }]))
    expect(report.ok).toBe(false)
    expect(report.detail).toContain('app credentials')
    expect(report.fix).toMatch(/app-id/)
  })

  it('fails the row when the key file is missing', async () => {
    delete process.env[APP_ENV]
    const report = await inspectReviewerIdentity(config({ app_id: 1234567, private_key_path: '/nonexistent/app.pem' }))
    expect(report.ok).toBe(false)
    expect(report.detail).toContain('not found')
    expect(report.fix).toContain('ck auth app --check')
  })

  it('falls back to a numeric label when the slug cannot be resolved', async () => {
    stubFetch(() => json({ message: 'Bad credentials' }, 401))
    await expect(resolveReviewerIdentity(appConfig())).resolves.toEqual({
      label: 'app 1234567',
      kind: 'app',
      appId: 1234567,
    })
  })
})

describe('branchProtectionAdvisory', () => {
  const protection = (requireCodeOwner: boolean) => ({
    url: 'https://api.github.com/repos/acme/widgets/branches/main/protection',
    required_pull_request_reviews: {
      require_code_owner_reviews: requireCodeOwner,
      required_approving_review_count: 1,
    },
  })

  function stubProtection(options: { codeOwners: boolean; status?: number }): void {
    stubFetch((url, method) => {
      if (url.endsWith('/repos/acme/widgets') && method === 'GET') return json({ default_branch: 'main' })
      if (url.includes('/branches/main/protection')) {
        if (options.status) return json({ message: 'nope' }, options.status)
        return json(protection(options.codeOwners))
      }
      if (url.includes('/contents/.github/CODEOWNERS')) {
        return json({ content: Buffer.from('* @beingzy @Trump-One\n').toString('base64') })
      }
      if (url.includes('/contents/CODEOWNERS') || url.includes('/contents/docs/CODEOWNERS')) {
        return json({ message: 'Not Found' }, 404)
      }
      return undefined
    })
  }

  const cfg = () => appConfig([{ owner: 'acme', name: 'widgets' }])

  it('returns null when the branch is not protected', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/repos/acme/widgets') && method === 'GET') return json({ default_branch: 'main' })
      if (url.includes('/branches/main/protection')) return json({ message: 'Branch not protected' }, 404)
      return undefined
    })
    await expect(branchProtectionAdvisory(cfg(), 'ghp_token')).resolves.toBeNull()
  })

  it('returns null when protection cannot be read', async () => {
    stubProtection({ codeOwners: true, status: 403 })
    await expect(branchProtectionAdvisory(cfg(), 'ghp_token')).resolves.toBeNull()
  })

  it('returns null when code-owner review is not required', async () => {
    stubProtection({ codeOwners: false })
    await expect(branchProtectionAdvisory(cfg(), 'ghp_token')).resolves.toBeNull()
  })

  it('warns with the branch, code owners, and the reason', async () => {
    stubProtection({ codeOwners: true })
    const advisory = await branchProtectionAdvisory(cfg(), 'ghp_token')
    expect(advisory).toContain('acme/widgets@main')
    expect(advisory).toContain('@beingzy @Trump-One')
    expect(advisory).toContain('human must approve')
  })

  it('is attached to the identity report when a token is available', async () => {
    stubFetch((url, method) => {
      if (url.endsWith('/app') && method === 'GET') return json({ id: 1234567, slug: 'crosscheck-bot', name: 'crosscheck-bot' })
      if (url.includes('/repos/acme/widgets/installation')) return json({ id: 9, account: { login: 'acme' }, target_type: 'Organization', permissions: { pull_requests: 'write', issues: 'write' } })
      if (url.includes('/app/installations/9/access_tokens') && method === 'POST') return json({ token: 'ghs_test', expires_at: new Date(Date.now() + 3_600_000).toISOString() })
      if (url.endsWith('/repos/acme/widgets') && method === 'GET') return json({ id: 1, default_branch: 'main' })
      if (url.includes('/branches/main/protection')) return json(protection(true))
      if (url.includes('/contents/CODEOWNERS') || url.includes('/contents/docs/CODEOWNERS')) return json({ message: 'Not Found' }, 404)
      if (url.includes('/contents/.github/CODEOWNERS')) return json({ content: Buffer.from('* @beingzy\n').toString('base64') })
      return undefined
    })
    const report = await inspectReviewerIdentity(appConfig([{ owner: 'acme', name: 'widgets' }]), { token: 'ghp_token' })
    expect(report.ok).toBe(true)
    expect(report.notes.join('\n')).toContain('needs a code-owner approval')
  })
})
