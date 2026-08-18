import { describe, it, expect, vi } from 'vitest'
import { linearGraphQL, findIssueByIdentifier, postLinearComment } from '../linear/client.js'
import type { ResolvedLinearAuth } from '../linear/identity.js'
import type { FetchLike } from '../linear/identity.js'

const API_KEY_AUTH: ResolvedLinearAuth = {
  mode: 'api_key',
  token: 'lin_api_secret',
  bearer: false,
  actor: 'crosscheck',
  signature: '🤖 crosscheck · crosscheck',
  signatureTemplate: '🤖 {actor} · {product}',
  product: 'crosscheck',
}

const APP_AUTH: ResolvedLinearAuth = {
  mode: 'client_credentials',
  token: 'minted-token',
  bearer: true,
  actor: 'crosscheck',
  signature: '🤖 crosscheck · crosscheck',
  signatureTemplate: '🤖 {actor} · {product}',
  product: 'crosscheck',
  createAsUser: 'crosscheck',
}

function jsonFetch(payload: unknown, status = 200): FetchLike {
  return vi.fn(async () => new Response(JSON.stringify(payload), { status }))
}

function lastCall(fetchImpl: FetchLike): [string, { headers: Record<string, string>; body: string }] {
  const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
  return calls[calls.length - 1] as [string, { headers: Record<string, string>; body: string }]
}

describe('linearGraphQL', () => {
  it('sends an api_key as a bare Authorization header', async () => {
    const fetchImpl = jsonFetch({ data: { ok: true } })
    await linearGraphQL(API_KEY_AUTH, 'query { ok }', {}, { fetchImpl })

    const [url, init] = lastCall(fetchImpl)
    expect(url).toBe('https://api.linear.app/graphql')
    expect(init.headers.Authorization).toBe('lin_api_secret')
  })

  it('sends a minted app token as a Bearer header', async () => {
    const fetchImpl = jsonFetch({ data: { ok: true } })
    await linearGraphQL(APP_AUTH, 'query { ok }', {}, { fetchImpl })
    expect(lastCall(fetchImpl)[1].headers.Authorization).toBe('Bearer minted-token')
  })

  it('never puts the token in the URL', async () => {
    const fetchImpl = jsonFetch({ data: { ok: true } })
    await linearGraphQL(API_KEY_AUTH, 'query { ok }', {}, { fetchImpl })
    expect(lastCall(fetchImpl)[0]).not.toContain('lin_api_secret')
  })

  it('sends the query and variables as a JSON body', async () => {
    const fetchImpl = jsonFetch({ data: { ok: true } })
    await linearGraphQL(API_KEY_AUTH, 'query($a: String) { ok }', { a: 'b' }, { fetchImpl })

    const body = JSON.parse(lastCall(fetchImpl)[1].body)
    expect(body.query).toBe('query($a: String) { ok }')
    expect(body.variables).toEqual({ a: 'b' })
  })

  it('throws on a GraphQL error without leaking the token', async () => {
    const fetchImpl = jsonFetch({ errors: [{ message: 'Access denied' }] })
    const err = await linearGraphQL(API_KEY_AUTH, 'query { ok }', {}, { fetchImpl })
      .then(() => null, (e: unknown) => e as Error)

    expect(err!.message).toContain('Access denied')
    expect(err!.message).not.toContain('lin_api_secret')
  })

  it('throws on a non-2xx response without leaking the token', async () => {
    const fetchImpl = jsonFetch({ error: 'unauthorized' }, 401)
    const err = await linearGraphQL(API_KEY_AUTH, 'query { ok }', {}, { fetchImpl })
      .then(() => null, (e: unknown) => e as Error)

    expect(err!.message).toContain('401')
    expect(err!.message).not.toContain('lin_api_secret')
  })
})

describe('findIssueByIdentifier', () => {
  it('returns the issue id and url when found', async () => {
    const fetchImpl = jsonFetch({
      data: { issues: { nodes: [{ id: 'uuid-1', identifier: 'IN-2269', url: 'https://linear.app/x/issue/IN-2269' }] } },
    })
    const issue = await findIssueByIdentifier(API_KEY_AUTH, 'IN-2269', { fetchImpl })
    expect(issue).toEqual({ id: 'uuid-1', identifier: 'IN-2269', url: 'https://linear.app/x/issue/IN-2269' })
  })

  it('returns null when the issue does not exist', async () => {
    const fetchImpl = jsonFetch({ data: { issues: { nodes: [] } } })
    expect(await findIssueByIdentifier(API_KEY_AUTH, 'IN-9999', { fetchImpl })).toBeNull()
  })

  it('queries by team key and number parsed from the identifier', async () => {
    const fetchImpl = jsonFetch({ data: { issues: { nodes: [] } } })
    await findIssueByIdentifier(API_KEY_AUTH, 'IN-2269', { fetchImpl })

    const body = JSON.parse(lastCall(fetchImpl)[1].body)
    expect(body.variables).toEqual({ teamKey: 'IN', number: 2269 })
  })

  it('rejects a malformed identifier', async () => {
    const fetchImpl = jsonFetch({ data: { issues: { nodes: [] } } })
    await expect(findIssueByIdentifier(API_KEY_AUTH, 'not-an-id', { fetchImpl })).rejects.toThrow(/identifier/i)
    expect(fetchImpl).not.toHaveBeenCalled()
  })
})

describe('postLinearComment', () => {
  const ok = () => jsonFetch({
    data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/issue/IN-1#comment-c1' } } },
  })

  it('passes createAsUser in client_credentials mode', async () => {
    const fetchImpl = ok()
    await postLinearComment(APP_AUTH, 'uuid-1', 'hello', { fetchImpl })

    const body = JSON.parse(lastCall(fetchImpl)[1].body)
    expect(body.variables.createAsUser).toBe('crosscheck')
    expect(body.variables.issueId).toBe('uuid-1')
    expect(body.variables.body).toBe('hello')
  })

  it('omits createAsUser in api_key mode', async () => {
    const fetchImpl = ok()
    await postLinearComment(API_KEY_AUTH, 'uuid-1', 'hello', { fetchImpl })

    const body = JSON.parse(lastCall(fetchImpl)[1].body)
    expect(body.variables.createAsUser).toBeUndefined()
  })

  it('returns the created comment', async () => {
    const comment = await postLinearComment(APP_AUTH, 'uuid-1', 'hello', { fetchImpl: ok() })
    expect(comment).toEqual({ id: 'c1', url: 'https://linear.app/x/issue/IN-1#comment-c1' })
  })

  it('throws when the mutation reports success: false', async () => {
    const fetchImpl = jsonFetch({ data: { commentCreate: { success: false, comment: null } } })
    await expect(postLinearComment(APP_AUTH, 'uuid-1', 'hello', { fetchImpl })).rejects.toThrow(/rejected/i)
  })
})
