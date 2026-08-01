import { describe, it, expect, vi } from 'vitest'
import { renderSignature, mintAppToken, normalizeScopes, resolveLinearAuth, isLinearConfigError, type FetchLike } from '../linear/identity.js'
import { LinearConfigSchema } from '../config/schema.js'

const SECRET = 'super-secret-value'
const CLIENT_ID = 'client-abc'
const MINTED = 'minted-app-token'

function cfg(overrides: Record<string, unknown> = {}) {
  return LinearConfigSchema.parse({ enabled: true, ...overrides })
}

function okMint(): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify({ access_token: MINTED }), { status: 200 }))
}

describe('renderSignature', () => {
  it('expands {actor} and {product}', () => {
    expect(renderSignature('🤖 {actor} · {product}', { actor: 'crosscheck', product: 'crosscheck' })).toBe('🤖 crosscheck · crosscheck')
  })

  it('expands repeated placeholders', () => {
    expect(renderSignature('{actor}/{actor} on {product}', { actor: 'cc', product: 'p' })).toBe('cc/cc on p')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(renderSignature('{actor} {nope}', { actor: 'cc', product: 'p' })).toBe('cc {nope}')
  })
})

describe('mintAppToken', () => {
  it('posts client_credentials as a form body and returns the access token', async () => {
    const fetchImpl = okMint()
    const token = await mintAppToken(
      { clientId: CLIENT_ID, clientSecret: SECRET, scopes: 'read write' },
      { fetchImpl },
    )

    expect(token).toBe(MINTED)
    const [url, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.linear.app/oauth/token')
    expect(init.method).toBe('POST')
    expect(init.headers['Content-Type']).toBe('application/x-www-form-urlencoded')

    // The secret travels in the request body — never a URL parameter, never argv.
    expect(String(url)).not.toContain(SECRET)
    const body = new URLSearchParams(init.body as string)
    expect(body.get('grant_type')).toBe('client_credentials')
    expect(body.get('client_id')).toBe(CLIENT_ID)
    expect(body.get('client_secret')).toBe(SECRET)
    expect(body.get('scope')).toBe('read,write')
  })

  it('throws without leaking the secret when the mint is rejected', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('{"error":"invalid_client"}', { status: 401 }))
    const err = await mintAppToken({ clientId: CLIENT_ID, clientSecret: SECRET, scopes: 'read write' }, { fetchImpl })
      .then(() => null, (e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect(err!.message).toContain('401')
    expect(err!.message).not.toContain(SECRET)
    expect(err!.message).not.toContain(CLIENT_ID)
  })

  it('throws when the response has no access_token', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('{"ok":true}', { status: 200 }))
    await expect(
      mintAppToken({ clientId: CLIENT_ID, clientSecret: SECRET, scopes: 'read write' }, { fetchImpl }),
    ).rejects.toThrow(/no access_token/i)
  })

  it('throws on a non-JSON response', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('<html>gateway</html>', { status: 200 }))
    await expect(
      mintAppToken({ clientId: CLIENT_ID, clientSecret: SECRET, scopes: 'read write' }, { fetchImpl }),
    ).rejects.toThrow()
  })
})

describe('resolveLinearAuth — api_key mode (T0)', () => {
  it('uses the supplied key with a bare Authorization header and no createAsUser', async () => {
    const auth = await resolveLinearAuth(cfg(), { apiKey: 'lin_api_xyz' })

    expect(auth.mode).toBe('api_key')
    expect(auth.token).toBe('lin_api_xyz')
    expect(auth.bearer).toBe(false)
    expect(auth.createAsUser).toBeUndefined()
    expect(auth.signature).toBe('🤖 crosscheck')
  })

  it('honours a configured actor in the signature', async () => {
    const auth = await resolveLinearAuth(cfg({ identity: { actor: 'crosscheck/reviewer' } }), { apiKey: 'k' })
    expect(auth.signature).toBe('🤖 crosscheck/reviewer')
  })

  it('aborts when no key is available, naming the env var to set', async () => {
    await expect(resolveLinearAuth(cfg(), {})).rejects.toThrow(/LINEAR_API_KEY/)
  })

  it('never performs a network call', async () => {
    const fetchImpl = okMint()
    await resolveLinearAuth(cfg(), { apiKey: 'k' }, { fetchImpl })
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('resolveLinearAuth — client_credentials mode (T1)', () => {
  const t1 = () => cfg({ auth: { mode: 'client_credentials' }, identity: { actor: 'crosscheck' } })

  it('mints a per-run token and sets createAsUser to the actor', async () => {
    const fetchImpl = okMint()
    const auth = await resolveLinearAuth(t1(), { clientId: CLIENT_ID, clientSecret: SECRET }, { fetchImpl })

    expect(auth.mode).toBe('client_credentials')
    expect(auth.token).toBe(MINTED)
    expect(auth.bearer).toBe(true)
    expect(auth.createAsUser).toBe('crosscheck')
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('keeps the signature line as T1 fallback text', async () => {
    const auth = await resolveLinearAuth(t1(), { clientId: CLIENT_ID, clientSecret: SECRET }, { fetchImpl: okMint() })
    expect(auth.signature).toBe('🤖 crosscheck')
  })

  it('passes the configured scopes through to the mint', async () => {
    const fetchImpl = okMint()
    const config = cfg({ auth: { mode: 'client_credentials', scopes: 'read write initiative:read' } })
    await resolveLinearAuth(config, { clientId: CLIENT_ID, clientSecret: SECRET }, { fetchImpl })

    const [, init] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(new URLSearchParams(init.body as string).get('scope')).toBe('read,write,initiative:read')
  })

  describe('abort semantics — never silently fall back to api_key', () => {
    it('aborts when the mint fails even though an api_key is available', async () => {
      const fetchImpl: FetchLike = vi.fn(async () => new Response('nope', { status: 500 }))
      await expect(
        resolveLinearAuth(t1(), { clientId: CLIENT_ID, clientSecret: SECRET, apiKey: 'lin_api_fallback' }, { fetchImpl }),
      ).rejects.toThrow(/client_credentials/)
    })

    it('aborts when credentials are missing even though an api_key is available', async () => {
      const fetchImpl = okMint()
      await expect(
        resolveLinearAuth(t1(), { apiKey: 'lin_api_fallback' }, { fetchImpl }),
      ).rejects.toThrow(/LINEAR_CLIENT_ID/)
      expect(fetchImpl).not.toHaveBeenCalled()
    })

    it('names both env vars when only one is set', async () => {
      await expect(
        resolveLinearAuth(t1(), { clientId: CLIENT_ID }, { fetchImpl: okMint() }),
      ).rejects.toThrow(/LINEAR_CLIENT_SECRET/)
    })

    it('does not leak the secret in the abort message', async () => {
      const fetchImpl: FetchLike = vi.fn(async () => new Response('nope', { status: 500 }))
      const err = await resolveLinearAuth(t1(), { clientId: CLIENT_ID, clientSecret: SECRET }, { fetchImpl })
        .then(() => null, (e: unknown) => e as Error)
      expect(err!.message).not.toContain(SECRET)
    })
  })

  it('respects custom env var names in the abort message', async () => {
    const config = cfg({ auth: { mode: 'client_credentials', client_id_env: 'LINEAR_HB_AGENT_GATEWAY_CLIENT_ID' } })
    await expect(resolveLinearAuth(config, {})).rejects.toThrow(/LINEAR_HB_AGENT_GATEWAY_CLIENT_ID/)
  })
})

describe('normalizeScopes', () => {
  // Linear documents comma-separated; OAuth 2.0 specifies space-separated. Operators
  // write both, so accept either and always send what Linear asks for.
  it('passes a comma-separated list through', () => {
    expect(normalizeScopes('read,write')).toBe('read,write')
  })

  it('converts a space-separated list', () => {
    expect(normalizeScopes('read write')).toBe('read,write')
  })

  it('handles mixed separators and stray whitespace', () => {
    expect(normalizeScopes('  read,  write   initiative:read ')).toBe('read,write,initiative:read')
  })

  it('drops empty entries rather than sending blanks', () => {
    expect(normalizeScopes('read,,write,')).toBe('read,write')
  })

  it('returns empty for an empty input', () => {
    expect(normalizeScopes('   ')).toBe('')
  })
})

describe('LinearConfigError — exit-code classification', () => {
  // The CLI contract reserves exit 2 for unexpected errors; a missing env var is a
  // user error and must be 1, matching what `crosscheck review` already returns.
  it('flags a missing api_key as a config error', async () => {
    const err = await resolveLinearAuth(cfg(), {}).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })

  it('flags missing client credentials as a config error', async () => {
    const config = cfg({ auth: { mode: 'client_credentials' } })
    const err = await resolveLinearAuth(config, {}).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })

  it('flags a rejected mint as a config error', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('nope', { status: 401 }))
    const config = cfg({ auth: { mode: 'client_credentials' } })
    const err = await resolveLinearAuth(config, { clientId: 'a', clientSecret: 'b' }, { fetchImpl })
      .then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })

  it('does not flag unrelated errors', () => {
    expect(isLinearConfigError(new Error('network down'))).toBe(false)
    expect(isLinearConfigError(undefined)).toBe(false)
  })
})

describe('outage vs misconfiguration', () => {
  // A 5xx is Linear's problem, not the operator's — blaming it on the config
  // would exit 1 and send someone hunting a broken env var that is fine.
  const t1 = () => cfg({ auth: { mode: 'client_credentials' } })
  const creds = { clientId: 'id', clientSecret: 'secret' }
  const status = (code: number): FetchLike => vi.fn(async () => new Response('x', { status: code }))

  it('treats a rejected credential (401) as a config error', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(401) }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })

  it('treats a bad request (400) as a config error', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(400) }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })

  it('does NOT blame the config for a 500', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(500) }).then(() => null, (e: unknown) => e)
    expect(err).toBeInstanceOf(Error)
    expect(isLinearConfigError(err)).toBe(false)
  })

  it('does NOT blame the config for a 503', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(503) }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(false)
  })

  it('does NOT blame the config for a transport failure', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => { throw new Error('ECONNRESET') })
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(false)
  })

  it('aborts either way — never falls back to api_key', async () => {
    for (const code of [401, 500]) {
      const err = await resolveLinearAuth(t1(), { ...creds, apiKey: 'lin_api_fallback' }, { fetchImpl: status(code) })
        .then(() => null, (e: unknown) => e as Error)
      expect(err!.message).toMatch(/aborting rather than falling back/)
    }
  })
})

describe('rate limiting is transient, not misconfiguration', () => {
  const t1 = () => cfg({ auth: { mode: 'client_credentials' } })
  const creds = { clientId: 'id', clientSecret: 'secret' }
  const status = (code: number): FetchLike => vi.fn(async () => new Response('x', { status: code }))

  it('does not blame the config for a 429', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(429) }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(false)
  })

  it('still blames the config for a 403', async () => {
    const err = await resolveLinearAuth(t1(), creds, { fetchImpl: status(403) }).then(() => null, (e: unknown) => e)
    expect(isLinearConfigError(err)).toBe(true)
  })
})

describe('a rejected mint names the variables to check', () => {
  // A bare "HTTP 401" leaves an operator with custom env names guessing which
  // credential to rotate. Names only — never values.
  const rejected = (): FetchLike => vi.fn(async () => new Response('nope', { status: 401 }))
  const creds = { clientId: 'the-id', clientSecret: 'the-secret' }

  it('names the default variables', async () => {
    const config = cfg({ auth: { mode: 'client_credentials' } })
    const err = await resolveLinearAuth(config, creds, { fetchImpl: rejected() })
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toContain('LINEAR_CLIENT_ID')
    expect(err!.message).toContain('LINEAR_CLIENT_SECRET')
  })

  it('names custom variables', async () => {
    const config = cfg({
      auth: {
        mode: 'client_credentials',
        client_id_env: 'LINEAR_HB_AGENT_GATEWAY_CLIENT_ID',
        client_secret_env: 'LINEAR_HB_AGENT_GATEWAY_CLIENT_SECRET',
      },
    })
    const err = await resolveLinearAuth(config, creds, { fetchImpl: rejected() })
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).toContain('LINEAR_HB_AGENT_GATEWAY_CLIENT_ID')
    expect(err!.message).toContain('LINEAR_HB_AGENT_GATEWAY_CLIENT_SECRET')
  })

  it('still never leaks the values', async () => {
    const config = cfg({ auth: { mode: 'client_credentials' } })
    const err = await resolveLinearAuth(config, creds, { fetchImpl: rejected() })
      .then(() => null, (e: unknown) => e as Error)
    expect(err!.message).not.toContain('the-secret')
    expect(err!.message).not.toContain('the-id')
  })
})
