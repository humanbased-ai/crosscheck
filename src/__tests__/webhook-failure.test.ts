import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { webhookFailureHint, webhookFailureReason } from '../lib/webhook-failure.js'

const ORG_404 = 'Failed to register org webhook [404]: Not Found'
const FULL_SCOPES = 'admin:org_hook, gist, read:org, repo, workflow'
const USER_URL = 'https://api.github.com/user'
const MEMBERSHIP_URL = 'https://api.github.com/user/memberships/orgs/codatta'

const json = (status: number, body: unknown, headers: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers })

let requested: string[]

// Answers exactly the two requests a diagnosis may make, and records them.
function githubAnswers(answers: { scopes?: string | null; membership?: Response; user?: Response }): void {
  vi.stubGlobal('fetch', vi.fn(async (url: string) => {
    requested.push(url)
    if (url === USER_URL) {
      return answers.user ?? json(200, { login: 'alice' }, answers.scopes === null || answers.scopes === undefined ? {} : { 'x-oauth-scopes': answers.scopes })
    }
    if (url === MEMBERSHIP_URL && answers.membership) return answers.membership
    throw new Error(`unexpected request: ${url}`)
  }))
}

beforeEach(() => { requested = [] })
afterEach(() => { vi.unstubAllGlobals() })

describe('webhookFailureReason for an org 404', () => {
  it('reports a missing scope only when the token really lacks admin:org_hook', async () => {
    githubAnswers({ scopes: 'gist, read:org, repo' })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('scope')
    // No membership lookup: the scope is what to fix first.
    expect(requested).toEqual([USER_URL])
  })

  it('reports a missing scope for a token that holds admin:org but not admin:org_hook', async () => {
    // The two are separate scopes: GitHub accepts only admin:org_hook on an org's hooks.
    githubAnswers({ scopes: 'admin:org, repo' })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('scope')
    expect(requested).toEqual([USER_URL])
  })

  it('reports non-membership when the token has the scope and the account is not in the org', async () => {
    githubAnswers({ scopes: FULL_SCOPES, membership: json(404, { message: 'Not Found' }) })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('not-org-member')
  })

  it('treats an invitation that was never accepted as not being a member', async () => {
    githubAnswers({ scopes: FULL_SCOPES, membership: json(200, { state: 'pending', role: 'member' }) })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('not-org-member')
  })

  it('reports a member who is not an owner separately', async () => {
    githubAnswers({ scopes: FULL_SCOPES, membership: json(200, { state: 'active', role: 'member' }) })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('not-org-owner')
  })

  it('passes the raw error through when an owner with the scope still gets a 404', async () => {
    githubAnswers({ scopes: FULL_SCOPES, membership: json(200, { state: 'active', role: 'admin' }) })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe(`other:${ORG_404}`)
  })

  it('does not claim non-membership from a token that cannot read memberships', async () => {
    // Without read:org the membership endpoint answers 404 for orgs the account is in.
    githubAnswers({ scopes: 'admin:org_hook, repo' })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe('org-access-unverified')
    expect(requested).toEqual([USER_URL])
  })

  it('does not ask a fine-grained token for a classic scope it cannot have', async () => {
    githubAnswers({ scopes: null })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'github_pat_token')).toBe('org-access-unverified')
  })

  it('keeps the original error when the diagnosis itself fails', async () => {
    githubAnswers({ user: json(502, { message: 'Bad Gateway' }) })

    expect(await webhookFailureReason(ORG_404, 'codatta', 'gho_token')).toBe(`other:${ORG_404}`)
  })
})

describe('webhookFailureReason without a diagnosis', () => {
  it.each([
    ['Failed to register org webhook [401]: Bad credentials', 'creds'],
    ['Failed to register org webhook [403]: Forbidden', 'scope'],
    ['Resource not accessible by integration', 'scope'],
    ['Failed to register org webhook [500]: Server Error', 'other:Failed to register org webhook [500]: Server Error'],
  ])('classifies %s from the message alone', async (msg, reason) => {
    githubAnswers({})

    expect(await webhookFailureReason(msg, 'codatta', 'gho_token')).toBe(reason)
    expect(requested).toEqual([])
  })

  it('leaves a repo 404 as the raw error', async () => {
    githubAnswers({})
    const msg = 'Failed to register repo webhook [404]: Not Found'

    expect(await webhookFailureReason(msg, null, 'gho_token')).toBe(`other:${msg}`)
    expect(requested).toEqual([])
  })
})

describe('webhookFailureHint', () => {
  it('only tells the user to refresh the token when the scope is what is missing', () => {
    expect(webhookFailureHint('scope', ORG_404, 'alice')).toContain('gh auth refresh -s admin:org_hook')
    for (const reason of ['not-org-member', 'not-org-owner', 'org-access-unverified'] as const) {
      expect(webhookFailureHint(reason, ORG_404, 'alice')).not.toContain('gh auth refresh')
    }
  })

  it('names the account the token belongs to', () => {
    expect(webhookFailureHint('not-org-member', ORG_404, 'alice')).toContain('alice is not a member')
    expect(webhookFailureHint('not-org-member', ORG_404, null)).toContain('this account is not a member')
  })

  it('shows the raw error for anything it has no advice on', () => {
    expect(webhookFailureHint(`other:${ORG_404}`, ORG_404, 'alice')).toBe(ORG_404)
  })
})
