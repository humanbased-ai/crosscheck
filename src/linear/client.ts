// All Linear API traffic goes through this module — mirrors the rule that GitHub
// calls go through src/github/client.ts. No raw fetch to api.linear.app elsewhere.

import type { FetchLike, ResolvedLinearAuth } from './identity.js'

const GRAPHQL_ENDPOINT = 'https://api.linear.app/graphql'

export interface LinearRequestOptions {
  fetchImpl?: FetchLike
  endpoint?: string
}

export interface LinearIssue {
  id: string
  identifier: string
  url: string
}

export interface LinearComment {
  id: string
  url: string
}

const IDENTIFIER_PATTERN = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/

function authHeader(auth: ResolvedLinearAuth): string {
  return auth.bearer ? `Bearer ${auth.token}` : auth.token
}

export async function linearGraphQL<T>(
  auth: ResolvedLinearAuth,
  query: string,
  variables: Record<string, unknown>,
  opts: LinearRequestOptions = {},
): Promise<T> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike)
  const endpoint = opts.endpoint ?? GRAPHQL_ENDPOINT

  // The token rides in a header, never in the URL or on argv.
  const response = await doFetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: authHeader(auth) },
    body: JSON.stringify({ query, variables }),
  })

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Linear API request failed (HTTP ${response.status})`)
  }

  let parsed: { data?: T; errors?: Array<{ message?: string }> }
  try {
    parsed = JSON.parse(text) as typeof parsed
  } catch {
    throw new Error(`Linear API returned a non-JSON response (HTTP ${response.status})`)
  }

  if (parsed.errors && parsed.errors.length > 0) {
    const detail = parsed.errors.map(e => e.message ?? 'unknown error').join('; ')
    throw new Error(`Linear API error: ${detail}`)
  }
  if (parsed.data === undefined) {
    throw new Error('Linear API returned no data')
  }
  return parsed.data
}

const FIND_ISSUE = `query($teamKey: String!, $number: Float!) {
  issues(first: 1, filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }) {
    nodes { id identifier url }
  }
}`

export async function findIssueByIdentifier(
  auth: ResolvedLinearAuth,
  identifier: string,
  opts: LinearRequestOptions = {},
): Promise<LinearIssue | null> {
  const match = identifier.match(IDENTIFIER_PATTERN)
  if (!match) {
    throw new Error(`Malformed Linear issue identifier: "${identifier}" (expected e.g. IN-2269)`)
  }

  const data = await linearGraphQL<{ issues: { nodes: LinearIssue[] } }>(
    auth,
    FIND_ISSUE,
    { teamKey: match[1].toUpperCase(), number: Number.parseInt(match[2], 10) },
    opts,
  )
  return data.issues.nodes[0] ?? null
}

const CREATE_COMMENT = `mutation($issueId: String!, $body: String!, $createAsUser: String) {
  commentCreate(input: { issueId: $issueId, body: $body, createAsUser: $createAsUser }) {
    success
    comment { id url }
  }
}`

export async function postLinearComment(
  auth: ResolvedLinearAuth,
  issueId: string,
  body: string,
  opts: LinearRequestOptions = {},
): Promise<LinearComment> {
  const variables: Record<string, unknown> = { issueId, body }
  // Only T1 can attribute the write to the app actor.
  if (auth.createAsUser) variables.createAsUser = auth.createAsUser

  const data = await linearGraphQL<{ commentCreate: { success: boolean; comment: LinearComment | null } }>(
    auth,
    CREATE_COMMENT,
    variables,
    opts,
  )

  if (!data.commentCreate.success || !data.commentCreate.comment) {
    throw new Error('Linear rejected the comment mutation')
  }
  return data.commentCreate.comment
}
