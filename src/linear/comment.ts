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
}

const DEFAULT_SERVICE = 'crosscheck'

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
    // `default` means the vendor CLI chose the model and did not report which — naming
    // it would be a guess, so the reviewer stands alone in that case.
    `**${verdict}** — ${input.reviewer}${input.model && input.model !== 'default' ? ` (${input.model})` : ''}` +
      ` review of [${escapeLinkLabel(input.prTitle)}](${input.prUrl})`,
  ]

  if (input.summary) sections.push('', input.summary)

  // Same annotation schema as the GitHub comment, so one parser reads both.
  sections.push('', buildAnnotation({
    origin: input.origin,
    reviewer: input.reviewer,
    model: input.model,
    type: 'review',
    round: 1,
    verdict,
    service,
    ...(input.sha && { sha: input.sha }),
  }))

  return sections.join('\n')
}

export function shouldPostToLinear(verdict: string | null, commentOn: readonly string[]): boolean {
  return commentOn.includes(verdict ?? 'UNKNOWN')
}
