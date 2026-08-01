import { describe, it, expect, vi } from 'vitest'
import { renderSignature, mintAppToken, normalizeScopes, resolveLinearAuth, type FetchLike } from '../linear/identity.js'
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
    expect(renderSignature('🤖 {actor} · {product}', 'crosscheck', 'crosscheck')).toBe('🤖 crosscheck · crosscheck')
  })

  it('expands repeated placeholders', () => {
    expect(renderSignature('{actor}/{actor} on {product}', 'cc', 'p')).toBe('cc/cc on p')
  })

  it('leaves unknown placeholders untouched', () => {
    expect(renderSignature('{actor} {nope}', 'cc', 'p')).toBe('cc {nope}')
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
    expect(auth.signature).toBe('🤖 crosscheck · crosscheck')
  })

  it('honours a configured actor in the signature', async () => {
    const auth = await resolveLinearAuth(cfg({ identity: { actor: 'crosscheck/reviewer' } }), { apiKey: 'k' })
    expect(auth.signature).toBe('🤖 crosscheck/reviewer · crosscheck')
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
    expect(auth.signature).toBe('🤖 crosscheck · crosscheck')
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
