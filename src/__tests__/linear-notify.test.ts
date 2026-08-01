import { describe, it, expect, vi } from 'vitest'
import { notifyLinear, issueBelongsToWorkspace } from '../linear/notify.js'
import { LinearConfigSchema } from '../config/schema.js'
import type { ResolvedLinearAuth, FetchLike } from '../linear/identity.js'

const AUTH: ResolvedLinearAuth = {
  mode: 'client_credentials',
  token: 'minted',
  bearer: true,
  actor: 'crosscheck',
  signature: '🤖 crosscheck · crosscheck',
  signatureTemplate: '🤖 {actor} · {product}',
  product: 'crosscheck',
  createAsUser: 'crosscheck',
}

const PR = {
  branch: 'feat/in-2269-identity',
  title: 'feat: tiered Linear identity',
  body: '',
  url: 'https://github.com/acme/app/pull/12',
  sha: 'abc1234',
}

const BASE = { auth: AUTH, pr: PR, verdict: 'NEEDS_WORK', reviewer: 'codex', origin: 'claude', model: 'gpt-5' }

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

describe('workspace mismatch', () => {
  const scoped = (issueUrl: string): FetchLike => {
    let call = 0
    return vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [{ id: 'u1', identifier: 'IN-2269', url: issueUrl }] } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/c1' } } },
      }), { status: 200 })
    })
  }

  const prWithUrl = (url: string) => ({ ...PR, branch: 'feat/none', title: 'chore', body: url })

  it('posts when the resolved issue is in the URL-named workspace', async () => {
    const fetchImpl = scoped('https://linear.app/acme/issue/IN-2269/slug')
    const result = await notifyLinear(
      { ...BASE, pr: prWithUrl('https://linear.app/acme/issue/IN-2269'), config: cfg({ team_keys: [] }) },
      { fetchImpl },
    )
    expect(result.status).toBe('posted')
  })

  it('skips when the credentials resolve a different workspace', async () => {
    // Same identifier, different workspace — a real issue, but not the one meant.
    const fetchImpl = scoped('https://linear.app/other-corp/issue/IN-2269/slug')
    const result = await notifyLinear(
      { ...BASE, pr: prWithUrl('https://linear.app/acme/issue/IN-2269'), config: cfg({ team_keys: [] }) },
      { fetchImpl },
    )
    expect(result).toEqual({ status: 'skipped', reason: 'workspace-mismatch', identifier: 'IN-2269' })
  })

  it('does not post the comment when the workspace mismatches', async () => {
    const fetchImpl = scoped('https://linear.app/other-corp/issue/IN-2269/slug')
    await notifyLinear(
      { ...BASE, pr: prWithUrl('https://linear.app/acme/issue/IN-2269'), config: cfg({ team_keys: [] }) },
      { fetchImpl },
    )
    expect((fetchImpl as ReturnType<typeof vi.fn>).mock.calls).toHaveLength(1)
  })

  it('does not constrain a bare ref, which names no workspace', async () => {
    const fetchImpl = scoped('https://linear.app/whatever/issue/IN-2269/slug')
    const result = await notifyLinear({ ...BASE, config: cfg() }, { fetchImpl })
    expect(result.status).toBe('posted')
  })
})

describe('issueBelongsToWorkspace', () => {
  it('matches the first path segment', () => {
    expect(issueBelongsToWorkspace('https://linear.app/acme/issue/IN-1', 'acme')).toBe(true)
  })

  it('is case insensitive', () => {
    expect(issueBelongsToWorkspace('https://linear.app/ACME/issue/IN-1', 'acme')).toBe(true)
  })

  it('rejects a different workspace', () => {
    expect(issueBelongsToWorkspace('https://linear.app/other/issue/IN-1', 'acme')).toBe(false)
  })

  it('fails closed on an unparseable URL', () => {
    expect(issueBelongsToWorkspace('not a url', 'acme')).toBe(false)
  })
})
