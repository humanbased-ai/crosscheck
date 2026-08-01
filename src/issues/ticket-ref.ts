// Pure ticket-reference extraction. crosscheck otherwise infers a PR's intent
// from the diff; these helpers recover the tracker ID (e.g. IN-2017) from the
// PR title / branch / body so the review can be anchored to the stated goal.

export interface TicketRef {
  // Team key, always upper-cased (e.g. "IN").
  key: string
  // Issue number within the team (e.g. 2017).
  number: number
  // Canonical identifier "IN-2017".
  id: string
}

// A tracker identifier: 1-10 key characters, then digits. Linear permits
// one-character team keys (X-42), so requiring two silently skipped those
// workspaces entirely. Matched case-insensitively; the source is upper-cased
// first so a branch like `claude/in-2017-slug` still yields `IN-2017`.
const TICKET_PATTERN = /\b([A-Z][A-Z0-9]{0,9})-(\d+)\b/g

export function parseTicketId(id: string): TicketRef | null {
  const m = /^([A-Za-z][A-Za-z0-9]{0,9})-(\d+)$/.exec(id.trim())
  if (!m) return null
  const key = m[1].toUpperCase()
  return { key, number: Number(m[2]), id: `${key}-${m[2]}` }
}

// Extracts unique ticket refs in first-seen order across title, then branch,
// then body. When `teamKeys` is non-empty, only those keys are kept (case-
// insensitive) — the precise mode that avoids fetching bogus lookups for tokens
// like UTF-8 or SHA-256 that share the ticket shape.
export function extractTicketRefs(
  sources: { title?: string | null; branch?: string | null; body?: string | null },
  teamKeys: string[] = [],
): TicketRef[] {
  const allowed = new Set(teamKeys.map(k => k.toUpperCase()))
  const seen = new Set<string>()
  const refs: TicketRef[] = []
  for (const raw of [sources.title, sources.branch, sources.body]) {
    if (!raw) continue
    for (const m of raw.toUpperCase().matchAll(TICKET_PATTERN)) {
      const key = m[1]
      if (allowed.size > 0 && !allowed.has(key)) continue
      const id = `${key}-${Number(m[2])}`
      if (seen.has(id)) continue
      seen.add(id)
      refs.push({ key, number: Number(m[2]), id })
    }
  }
  return refs
}
