import type { IssueEnrichmentConfig } from '../config/schema.js'
import { extractTicketRefs } from './ticket-ref.js'
import { fetchLinearIssue } from './linear.js'
import { formatIssueContext } from './context.js'

export interface EnrichLogEvent {
  level: 'info' | 'warn'
  event: string
  ref?: string
  reason?: string
}

// Resolves the enrichment block for a PR: recover the ticket ref, fetch the
// linked issue, format it for the prompt. Returns null (never throws) whenever
// enrichment cannot contribute — disabled, no ref, no key, fetch failure — so a
// missing or unreachable tracker degrades the review to diff-only, never blocks
// it. Every miss is reported through `onLog` for observability.
export async function enrichIssueContext(
  sources: { title?: string | null; branch?: string | null; body?: string | null },
  config: IssueEnrichmentConfig,
  apiKey: string | undefined,
  onLog: (event: EnrichLogEvent) => void = () => {},
): Promise<string | null> {
  if (!config.enabled) return null

  const refs = extractTicketRefs(sources, config.team_keys)
  if (refs.length === 0) {
    onLog({ level: 'info', event: 'issue_enrichment_skipped', reason: 'no_ticket_ref' })
    return null
  }
  const ref = refs[0]

  if (!apiKey) {
    onLog({ level: 'warn', event: 'issue_enrichment_skipped', ref: ref.id, reason: 'no_linear_api_key' })
    return null
  }

  try {
    const issue = await fetchLinearIssue(ref, apiKey)
    if (!issue) {
      onLog({ level: 'info', event: 'issue_enrichment_skipped', ref: ref.id, reason: 'issue_not_found' })
      return null
    }
    onLog({ level: 'info', event: 'issue_enrichment_applied', ref: ref.id })
    return formatIssueContext(issue, config.max_description_chars)
  } catch (err) {
    onLog({ level: 'warn', event: 'issue_enrichment_error', ref: ref.id, reason: err instanceof Error ? err.message : String(err) })
    return null
  }
}
