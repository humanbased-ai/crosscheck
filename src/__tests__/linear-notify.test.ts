import { describe, it, expect, vi } from 'vitest'
import { notifyLinear } from '../linear/notify.js'
import { LinearConfigSchema } from '../config/schema.js'
import type { ResolvedLinearAuth, FetchLike } from '../linear/identity.js'

const AUTH: ResolvedLinearAuth = {
  mode: 'client_credentials',
  token: 'minted',
  bearer: true,
  actor: 'crosscheck',
  signature: '🤖 crosscheck · crosscheck',
  createAsUser: 'crosscheck',
}

const PR = {
  branch: 'feat/in-2269-identity',
  title: 'feat: tiered Linear identity',
  body: '',
  url: 'https://github.com/acme/app/pull/12',
  sha: 'abc1234',
}

const BASE = { auth: AUTH, pr: PR, verdict: 'APPROVE', reviewer: 'codex', origin: 'claude', model: 'gpt-5' }

function cfg(overrides: Record<string, unknown> = {}) {
  return LinearConfigSchema.parse({ enabled: true, team_keys: ['IN'], ...overrides })
}

/** Replies to the issue lookup, then the comment mutation. */
function scriptedFetch(issueNodes: unknown[], mutation?: unknown): FetchLike {
  let call = 0
  return vi.fn(async () => {
    call++
    if (call === 1) return new Response(JSON.stringify({ data: { issues: { nodes: issueNodes } } }), { status: 200 })
    return new Response(JSON.stringify({
      data: mutation ?? { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/c1' } } },
    }), { status: 200 })
  })
}

const FOUND = [{ id: 'uuid-1', identifier: 'IN-2269', url: 'https://linear.app/x/issue/IN-2269' }]

describe('notifyLinear', () => {
  it('posts to the issue referenced by the branch', async () => {
    const fetchImpl = scriptedFetch(FOUND)
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })

    expect(result).toEqual({ status: 'posted', identifier: 'IN-2269', url: 'https://linear.app/x/c1' })
  })

  it('sends a body that leads with the signature and carries createAsUser', async () => {
    const fetchImpl = scriptedFetch(FOUND)
    await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })

    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
    const mutation = JSON.parse(calls[1][1].body as string)
    expect(mutation.variables.createAsUser).toBe('crosscheck')
    expect((mutation.variables.body as string).split('\n')[0]).toBe('🤖 crosscheck · crosscheck')
  })

  it('skips when the verdict is not in comment_on', async () => {
    const fetchImpl = scriptedFetch(FOUND)
    const result = await notifyLinear({ ...BASE, config: cfg({ comment_on: ['BLOCK'] }) }, { fetchImpl })

    expect(result).toEqual({ status: 'skipped', reason: 'verdict-not-configured' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('skips when the PR references no Linear issue', async () => {
    const fetchImpl = scriptedFetch(FOUND)
    const pr = { ...PR, branch: 'feat/no-ref', title: 'chore: bump', body: '' }
    const result = await notifyLinear({ ...BASE, pr, config: cfg() }, { fetchImpl })

    expect(result).toEqual({ status: 'skipped', reason: 'no-issue-ref' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('skips when the referenced issue does not exist', async () => {
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl: scriptedFetch([]) })
    expect(result).toEqual({ status: 'skipped', reason: 'issue-not-found', identifier: 'IN-2269' })
  })

  it('reports failure instead of throwing when the API errors', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('{}', { status: 500 }))
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })

    expect(result.status).toBe('failed')
    expect(result.reason).toContain('500')
  })

  it('reports failure when the mutation is rejected', async () => {
    const fetchImpl = scriptedFetch(FOUND, { commentCreate: { success: false, comment: null } })
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })

    expect(result.status).toBe('failed')
    expect(result.reason).toMatch(/rejected/i)
  })

  it('never leaks the token in a failure reason', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => new Response('{}', { status: 401 }))
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })
    expect(result.reason).not.toContain('minted')
  })

  it('follows a linear.app URL in the body when no team_keys are configured', async () => {
    const pr = { ...PR, branch: 'feat/nope', title: 'chore', body: 'https://linear.app/x/issue/IN-2269/z' }
    const result = await notifyLinear(
      { ...BASE, pr, config: cfg({ team_keys: [] }) },
      { fetchImpl: scriptedFetch(FOUND) },
    )
    expect(result.status).toBe('posted')
  })
})
