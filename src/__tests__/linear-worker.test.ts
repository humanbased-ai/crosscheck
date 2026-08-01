import { describe, it, expect, vi } from 'vitest'
import { resolveLinearAuth, withWorker, type FetchLike, type ResolvedLinearAuth } from '../linear/identity.js'
import { LinearConfigSchema } from '../config/schema.js'

function cfg(overrides: Record<string, unknown> = {}) {
  return LinearConfigSchema.parse({ enabled: true, ...overrides })
}

const mint: FetchLike = () =>
  Promise.resolve(new Response(JSON.stringify({ access_token: 'minted' }), { status: 200 }))

async function t1(): Promise<ResolvedLinearAuth> {
  return resolveLinearAuth(
    cfg({ auth: { mode: 'client_credentials' } }),
    { clientId: 'id', clientSecret: 'secret' },
    { fetchImpl: mint },
  )
}

async function t0(): Promise<ResolvedLinearAuth> {
  return resolveLinearAuth(cfg(), { apiKey: 'lin_api_key' })
}

describe('withWorker — T1', () => {
  it('re-points createAsUser at the step-scoped actor', async () => {
    const scoped = withWorker(await t1(), 'review')

    expect(scoped.actor).toBe('crosscheck/review')
    expect(scoped.createAsUser).toBe('crosscheck/review')
  })

  it('re-renders the signature for the derived actor', async () => {
    expect(withWorker(await t1(), 'fix').signature).toBe('🤖 crosscheck/fix · crosscheck')
  })

  it('keeps the token and mode untouched', async () => {
    const base = await t1()
    const scoped = withWorker(base, 'recheck')

    expect(scoped.token).toBe(base.token)
    expect(scoped.mode).toBe('client_credentials')
    expect(scoped.bearer).toBe(true)
  })

  it('does not mutate the base identity, so one run can derive several', async () => {
    const base = await t1()
    const review = withWorker(base, 'review')
    const fix = withWorker(base, 'fix')

    expect(base.actor).toBe('crosscheck')
    expect(base.createAsUser).toBe('crosscheck')
    expect(review.createAsUser).toBe('crosscheck/review')
    expect(fix.createAsUser).toBe('crosscheck/fix')
  })

  it('honours a custom base actor', async () => {
    const base = await resolveLinearAuth(
      cfg({ auth: { mode: 'client_credentials' }, identity: { actor: 'acme-bot' } }),
      { clientId: 'id', clientSecret: 'secret' },
      { fetchImpl: mint },
    )
    expect(withWorker(base, 'review').createAsUser).toBe('acme-bot/review')
  })
})

describe('withWorker — T0', () => {
  it('scopes the signature even though there is no createAsUser', async () => {
    const scoped = withWorker(await t0(), 'review')

    expect(scoped.actor).toBe('crosscheck/review')
    expect(scoped.signature).toBe('🤖 crosscheck/review · crosscheck')
    // T0 has no createAsUser to re-point — the signature is its whole mechanism.
    expect(scoped.createAsUser).toBeUndefined()
  })

  it('does not invent a createAsUser field', async () => {
    expect('createAsUser' in withWorker(await t0(), 'review')).toBe(false)
  })
})

describe('withWorker — edge cases', () => {
  it('returns the identity unchanged for an empty worker', async () => {
    const base = await t1()
    expect(withWorker(base, '')).toBe(base)
    expect(withWorker(base, '   ')).toBe(base)
  })

  it('trims surrounding whitespace', async () => {
    expect(withWorker(await t1(), '  review  ').actor).toBe('crosscheck/review')
  })

  it('composes, so a nested worker keeps both segments', async () => {
    const scoped = withWorker(withWorker(await t1(), 'review'), 'shard-2')
    expect(scoped.actor).toBe('crosscheck/review/shard-2')
  })

  it('never leaks the token into the actor or signature', async () => {
    const scoped = withWorker(await t1(), 'review')
    expect(scoped.actor).not.toContain('minted')
    expect(scoped.signature).not.toContain('minted')
  })
})

describe('per_step_actor config', () => {
  it('defaults to true', () => {
    expect(cfg().identity.per_step_actor).toBe(true)
  })

  it('can be turned off for a single flat actor', () => {
    expect(cfg({ identity: { per_step_actor: false } }).identity.per_step_actor).toBe(false)
  })
})
