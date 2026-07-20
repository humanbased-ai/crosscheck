import type { TrackerIssue } from './context.js'
import type { TicketRef } from './ticket-ref.js'

const LINEAR_GRAPHQL_URL = 'https://api.linear.app/graphql'

// Fetch by (team key, number) rather than the internal UUID — the ref we recover
// from a PR is the human identifier (IN-2017), not Linear's node id.
const ISSUE_QUERY = `query IssueByRef($teamKey: String!, $number: Float!) {
  issues(filter: { team: { key: { eq: $teamKey } }, number: { eq: $number } }, first: 1) {
    nodes {
      identifier
      title
      description
      estimate
      priorityLabel
      url
      labels { nodes { name } }
      project { name }
    }
  }
}`

interface LinearIssueNode {
  identifier: string
  title: string
  description: string | null
  estimate: number | null
  priorityLabel: string | null
  url: string | null
  labels: { nodes: Array<{ name: string }> }
  project: { name: string } | null
}

interface LinearResponse {
  data?: { issues?: { nodes?: LinearIssueNode[] } }
  errors?: Array<{ message: string }>
}

// Returns the tracker issue for a ref, or null when it does not resolve (unknown
// ref, no access). Throws only on transport/auth failures so the caller can log
// them; enrichment is advisory and its orchestrator swallows those into a no-op.
export async function fetchLinearIssue(ref: TicketRef, apiKey: string): Promise<TrackerIssue | null> {
  const res = await fetch(LINEAR_GRAPHQL_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query: ISSUE_QUERY, variables: { teamKey: ref.key, number: ref.number } }),
  })
  if (!res.ok) {
    throw new Error(`Linear API returned ${res.status} ${res.statusText}`)
  }
  const body = (await res.json()) as LinearResponse
  if (body.errors && body.errors.length > 0) {
    throw new Error(`Linear API error: ${body.errors.map(e => e.message).join('; ')}`)
  }
  const node = body.data?.issues?.nodes?.[0]
  if (!node) return null
  return {
    id: node.identifier,
    title: node.title,
    description: node.description,
    labels: node.labels.nodes.map(l => l.name),
    estimate: node.estimate,
    priorityLabel: node.priorityLabel,
    projectName: node.project?.name ?? null,
    url: node.url,
  }
}
