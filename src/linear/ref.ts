// Write-side ref resolution: which Linear issue should crosscheck comment on?
//
// Extraction primitives live in src/issues/ticket-ref.ts and are reused here —
// this module only adds the two things the write path needs on top:
//
//   1. linear.app issue URLs, which are unambiguous and so need no configuration.
//   2. A stricter policy for bare identifiers: they are only honoured for team keys
//      the operator has configured. Enrichment can afford to match `UTF-8` and let
//      the lookup return nothing, because a failed read is a no-op. A failed *write*
//      would post a review comment onto an unrelated issue, so the write path
//      requires the operator to name their team keys first.

import { extractTicketRefs, parseTicketId, type TicketRef } from '../issues/ticket-ref.js'

export interface LinearIssueRef extends TicketRef {
  source: 'branch' | 'title' | 'body'
  /** Workspace slug, when the ref came from an explicit URL. Bare refs have none. */
  workspace?: string
}

export interface PRMetadata {
  branch?: string | null
  title?: string | null
  body?: string | null
}

// Issue path inside a linear.app URL. Key shape matches parseTicketId. The
// lookahead is load-bearing: without it `/issue/IN-123abc` matches the `IN-123`
// prefix and would post to an unrelated issue while bypassing team_keys.
const ISSUE_PATH = /^\/([^/]+)\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![A-Za-z0-9])/i

// Absolute URLs are parsed and their hostname compared exactly. A boundary check
// on the text is not enough: `https://evil.example/linear.app/acme/issue/IN-1`
// satisfies any "character before linear.app" rule while pointing somewhere else
// entirely, and would bypass the team_keys gate.
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s<>()"'`]+/gi

// Scheme-less form, e.g. "see linear.app/acme/issue/IN-7". Anchored to the start of
// the field or whitespace so `notlinear.app/...` cannot match.
const BARE_URL = /(?:^|\s)linear\.app\/([^/\s]+)\/issue\/([A-Za-z][A-Za-z0-9]{1,9}-\d+)(?![A-Za-z0-9])/i

function fromUrl(text: string): LinearIssueRef | null {
  for (const match of text.matchAll(ABSOLUTE_URL)) {
    let parsed: URL
    try {
      parsed = new URL(match[0])
    } catch {
      continue
    }
    if (parsed.hostname.toLowerCase() !== 'linear.app') continue
    const issue = parsed.pathname.match(ISSUE_PATH)
    if (issue) return withWorkspace(parseTicketId(issue[2]), issue[1])
  }

  const bare = text.match(BARE_URL)
  return bare ? withWorkspace(parseTicketId(bare[2]), bare[1]) : null
}

// An explicit URL names a workspace. Identifiers are only unique within one, so
// dropping the slug lets a URL for workspace A resolve against credentials for
// workspace B and comment on B's same-numbered issue.
function withWorkspace(ref: TicketRef | null, workspace: string): LinearIssueRef | null {
  return ref ? { ...ref, workspace: workspace.toLowerCase(), source: 'body' } : null
}

function matchField(text: string, teamKeys: readonly string[]): LinearIssueRef | null {
  const url = fromUrl(text)
  if (url) return url

  // Bare identifiers only for configured keys — see the module header.
  if (teamKeys.length === 0) return null
  const bare = extractTicketRefs({ title: text }, [...teamKeys])[0]
  return bare ? { ...bare, source: 'body' } : null
}

export function extractLinearRef(pr: PRMetadata, teamKeys: readonly string[]): LinearIssueRef | null {
  const fields: Array<[string | null | undefined, LinearIssueRef['source']]> = [
    [pr.branch, 'branch'],
    [pr.title, 'title'],
    [pr.body, 'body'],
  ]

  for (const [text, source] of fields) {
    if (!text) continue
    const ref = matchField(text, teamKeys)
    if (ref) return { ...ref, source }
  }
  return null
}
