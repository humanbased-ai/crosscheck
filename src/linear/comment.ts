// Body construction for the comment crosscheck posts back to a PR's Linear issue.

import { buildAnnotation } from '../lib/annotation.js'
import type { LinearVerdictFilter } from '../config/schema.js'

export interface LinearCommentInput {
  /** `🤖 {actor} · {product}` — must lead the comment (IN-2260 step 3). */
  signature: string
  verdict: string | null
  reviewer: string
  origin: string
  model: string
  prUrl: string
  prTitle: string
  sha?: string
  summary?: string
  service?: string
  /** Workflow step this verdict came from — a recheck must not read as a review. */
  stepType?: string
  round?: number
}

const DEFAULT_SERVICE = 'crosscheck'

// The visible line must agree with the annotation. Saying "review" on a recheck
// made the human-readable text contradict the type=recheck sitting right below it.
// Returns the whole connective phrase, including the preposition — "fix of" is
// not English, so the label owns it rather than the template appending one.
function stepLabel(stepType: string | undefined): string {
  switch (stepType) {
    case 'recheck': return 'recheck of'
    case 'fix': return 'fix for'
    case 'conflict-resolve': return 'conflict resolution for'
    default: return 'review of'
  }
}

// A `]` in the PR title would terminate the markdown link label early.
function escapeLinkLabel(text: string): string {
  return text.replace(/([[\]])/g, '\\$1')
}

export function buildLinearCommentBody(input: LinearCommentInput): string {
  const verdict = input.verdict ?? 'UNKNOWN'
  const service = input.service ?? DEFAULT_SERVICE

  const sections = [
    input.signature,
    '',
    // Both halves: the model when the vendor reported one — `default` means it
    // chose without saying which, and naming it would be a guess — and the step
    // label, so a recheck does not read as a review.
    `**${verdict}** — ${input.reviewer}${input.model && input.model !== 'default' ? ` (${input.model})` : ''}` +
      ` ${stepLabel(input.stepType)} [${escapeLinkLabel(input.prTitle)}](${input.prUrl})`,
  ]

  if (input.summary) sections.push('', input.summary)

  // Same annotation schema as the GitHub comment, so one parser reads both.
  sections.push('', buildAnnotation({
    origin: input.origin,
    reviewer: input.reviewer,
    model: input.model,
    type: input.stepType ?? 'review',
    round: input.round ?? 1,
    verdict,
    service,
    ...(input.sha && { sha: input.sha }),
  }))

  return sections.join('\n')
}

// parseVerdict yields the human spelling `NEEDS WORK`, while config and the
// annotation schema both use `NEEDS_WORK`. Comparing them raw silently dropped
// every NEEDS WORK verdict — the most common actionable one.
export function normalizeVerdict(verdict: string | null): string {
  return (verdict ?? 'UNKNOWN').trim().toUpperCase().replace(/\s+/g, '_')
}

export function shouldPostToLinear(verdict: string | null, commentOn: readonly string[]): boolean {
  const wanted = normalizeVerdict(verdict)
  return commentOn.some(v => normalizeVerdict(v) === wanted)
}
