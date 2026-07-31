import { describe, it, expect, vi } from 'vitest'
import { verifyLinearIdentity } from '../linear/verify.js'
import { LinearConfigSchema } from '../config/schema.js'
import type { FetchLike } from '../linear/identity.js'

function cfg(overrides: Record<string, unknown> = {}) {
  return LinearConfigSchema.parse({ enabled: true, ...overrides })
}

const T1 = () => cfg({ auth: { mode: 'client_credentials' } })
const T1_CREDS = { clientId: 'id', clientSecret: 'super-secret' }

function json(payload: unknown, status = 200): Response {
  return new Response(JSON.stringify(payload), { status })
}

/** Mint replies first (T1 only), then the GraphQL probe. */
function sequence(...responses: Response[]): FetchLike {
  let i = 0
  return vi.fn(async () => responses[Math.min(i++, responses.length - 1)])
}

describe('verifyLinearIdentity — T1 (client_credentials)', () => {
  it('reports app attribution when the minted token is accepted', async () => {
    const fetchImpl = sequence(
      json({ access_token: 'minted' }),
      json({ data: { organization: { name: 'Inductive Network' } } }),
    )
    const report = await verifyLinearIdentity(T1(), T1_CREDS, { fetchImpl })

    expect(report).toEqual({
      ok: true,
      mode: 'client_credentials',
      actor: 'crosscheck',
      attribution: 'app',
      organization: 'Inductive Network',
    })
  })

  it('does not ask for a viewer — an app token has none', async () => {
    const fetchImpl = sequence(
      json({ access_token: 'minted' }),
      json({ data: { organization: { name: 'Acme' } } }),
    )
    await verifyLinearIdentity(T1(), T1_CREDS, { fetchImpl })

    const probe = JSON.parse((fetchImpl as ReturnType<typeof vi.fn>).mock.calls[1][1].body as string)
    expect(probe.query).not.toContain('viewer')
  })

  it('reports failure when the mint is rejected', async () => {
    const fetchImpl = sequence(json({ error: 'invalid_client' }, 401))
    const report = await verifyLinearIdentity(T1(), T1_CREDS, { fetchImpl })

    expect(report.ok).toBe(false)
    expect(report.error).toContain('401')
    expect(report.attribution).toBe('app')
  })

  it('reports failure when credentials are missing, naming the env var', async () => {
    const report = await verifyLinearIdentity(T1(), {})

    expect(report.ok).toBe(false)
    expect(report.error).toContain('LINEAR_CLIENT_ID')
  })

  it('reports failure when the token is minted but rejected by the API', async () => {
    const fetchImpl = sequence(
      json({ access_token: 'minted' }),
      json({ errors: [{ message: 'Access denied' }] }),
    )
    const report = await verifyLinearIdentity(T1(), T1_CREDS, { fetchImpl })

    expect(report.ok).toBe(false)
    expect(report.error).toContain('Access denied')
  })

  it('never leaks the secret or the token in an error', async () => {
    const fetchImpl = sequence(json({ error: 'bad' }, 500))
    const report = await verifyLinearIdentity(T1(), T1_CREDS, { fetchImpl })

    expect(report.error).not.toContain('super-secret')
    expect(report.error).not.toContain('id')
  })
})

describe('verifyLinearIdentity — T0 (api_key)', () => {
  it('names the human account writes will attribute to', async () => {
    const fetchImpl = sequence(
      json({ data: { viewer: { name: 'Yi', email: 'yi@example.com' }, organization: { name: 'Acme' } } }),
    )
    const report = await verifyLinearIdentity(cfg(), { apiKey: 'lin_api_x' }, { fetchImpl })

    expect(report).toEqual({
      ok: true,
      mode: 'api_key',
      actor: 'crosscheck',
      attribution: 'user',
      organization: 'Acme',
      attributesTo: 'yi@example.com',
    })
  })

  it('falls back to the display name when there is no email', async () => {
    const fetchImpl = sequence(
      json({ data: { viewer: { name: 'Yi', email: null }, organization: { name: 'Acme' } } }),
    )
    const report = await verifyLinearIdentity(cfg(), { apiKey: 'k' }, { fetchImpl })
    expect(report.attributesTo).toBe('Yi')
  })

  it('still succeeds when the viewer is absent', async () => {
    const fetchImpl = sequence(json({ data: { viewer: null, organization: { name: 'Acme' } } }))
    const report = await verifyLinearIdentity(cfg(), { apiKey: 'k' }, { fetchImpl })

    expect(report.ok).toBe(true)
    expect(report.attributesTo).toBeUndefined()
  })

  it('performs no mint', async () => {
    const fetchImpl = sequence(json({ data: { viewer: null, organization: { name: 'Acme' } } }))
    await verifyLinearIdentity(cfg(), { apiKey: 'k' }, { fetchImpl })

    const [url] = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls[0]
    expect(url).toBe('https://api.linear.app/graphql')
  })

  it('reports failure when the key is missing', async () => {
    const report = await verifyLinearIdentity(cfg(), {})

    expect(report.ok).toBe(false)
    expect(report.error).toContain('LINEAR_API_KEY')
  })

  it('never leaks the key in an error', async () => {
    const fetchImpl = sequence(json({ error: 'nope' }, 401))
    const report = await verifyLinearIdentity(cfg(), { apiKey: 'lin_api_secret_value' }, { fetchImpl })
    expect(report.error).not.toContain('lin_api_secret_value')
  })
})

describe('verifyLinearIdentity — contract', () => {
  it('never throws, whatever the transport does', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => { throw new Error('ECONNREFUSED') })
    const report = await verifyLinearIdentity(cfg(), { apiKey: 'k' }, { fetchImpl })

    expect(report.ok).toBe(false)
    expect(report.error).toContain('ECONNREFUSED')
  })

  it('reports the configured actor even when resolution fails', async () => {
    const report = await verifyLinearIdentity(cfg({ identity: { actor: 'acme-bot' } }), {})
    expect(report.actor).toBe('acme-bot')
  })
})
