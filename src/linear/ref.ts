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

// The identifier occupies one whole path segment. Lookaheads kept getting this
// wrong in both directions: requiring `/` or end-of-path missed `IN-42.` at the
// end of a sentence, and allowing any non-alphanumeric accepted `IN-123-typo` as
// `IN-123`. Take the segment, strip trailing sentence punctuation, and require
// parseTicketId to match it whole.
const ISSUE_SEGMENTS = /^\/([^/]+)\/issue\/([^/]+)/i
const BARE_URL = /(?:^|\s)linear\.app\/([^/\s]+)\/issue\/([^/\s]+)/i

// Absolute URLs are parsed and their hostname compared exactly. A boundary check
// on the text is not enough: `https://evil.example/linear.app/acme/issue/IN-1`
// satisfies any "character before linear.app" rule while pointing somewhere else.
const ABSOLUTE_URL = /\bhttps?:\/\/[^\s<>()"'`]+/gi

/** Trailing sentence punctuation is never part of an identifier. */
function stripTrailingPunctuation(segment: string): string {
  return segment.replace(/[.,;:!?)\]}>'"]+$/, '')
}

function fromUrl(text: string): LinearIssueRef | null {
  for (const match of text.matchAll(ABSOLUTE_URL)) {
    let parsed: URL
    try {
      parsed = new URL(match[0])
    } catch {
      continue
    }
    if (parsed.hostname.toLowerCase() !== 'linear.app') continue
    const segments = parsed.pathname.match(ISSUE_SEGMENTS)
    if (!segments) continue
    const ref = parseTicketId(stripTrailingPunctuation(segments[2]))
    if (ref) return withWorkspace(ref, segments[1])
  }

  const bare = text.match(BARE_URL)
  if (!bare) return null
  const ref = parseTicketId(stripTrailingPunctuation(bare[2]))
  return ref ? withWorkspace(ref, bare[1]) : null
}

// An explicit URL names a workspace. Identifiers are only unique within one, so
// dropping the slug lets a URL for workspace A resolve against credentials for
// workspace B and comment on B's same-numbered issue.
function withWorkspace(ref: TicketRef, workspace: string): LinearIssueRef {
  return { ...ref, workspace: workspace.toLowerCase(), source: 'body' }
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
