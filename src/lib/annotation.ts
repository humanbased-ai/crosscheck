// Additive contract: this enum may grow in minor releases, but existing values
// must not be removed or renamed without a breaking change.
export type CrosscheckStepType = 'review' | 'recheck' | 'fix' | 'conflict-resolve'

export interface CrosscheckAnnotationInput {
  origin: string
  reviewer: string
  verdict: string
  type: CrosscheckStepType | string
  model: string
  round: number
  service: string
  sha?: string
  /** Pre-computed next workflow step; lets readers skip full comment scans. */
  next_step?: string
  /** Workflow trigger that produced this annotation (e.g. 'kickass'). */
  trigger?: string
  /** Review-strategy version in force. Lets a past review be explained by the
   *  policy that produced it rather than the policy current at read time. */
  strategy?: string
  /** PR class the strategy matched (e.g. 'risky', 'docs'). */
  class?: string
  /** Tier that class selected. */
  tier?: string
}

export interface CrosscheckCommitTrailerInput {
  reviewer: string
  model: string
  step: CrosscheckStepType
  service: string
}

const DEFAULT_TYPE: CrosscheckStepType = 'review'
const DEFAULT_MODEL = 'default'
const DEFAULT_ROUND = 1
const DEFAULT_SERVICE = 'crosscheck'

const STEP_TYPES = new Set<CrosscheckStepType>(['review', 'recheck', 'fix', 'conflict-resolve'])

export function buildAnnotation(input: CrosscheckAnnotationInput): string {
  const sha = input.sha ? ` sha=${fieldValue(input.sha)}` : ''
  const nextStep = input.next_step ? ` next_step=${fieldValue(input.next_step)}` : ''
  const trigger = input.trigger ? ` trigger=${fieldValue(input.trigger)}` : ''
  // Additive fields — parsers already tolerate unknown names, so appending
  // these is a minor change, not a break in the annotation contract.
  const strategy = input.strategy ? ` strategy=${fieldValue(input.strategy)}` : ''
  const cls = input.class ? ` class=${fieldValue(input.class)}` : ''
  const tier = input.tier ? ` tier=${fieldValue(input.tier)}` : ''
  return `<!-- crosscheck: origin=${fieldValue(input.origin)} reviewer=${fieldValue(input.reviewer)} model=${fieldValue(input.model)} type=${fieldValue(input.type)} round=${input.round} verdict=${fieldValue(input.verdict)} service=${fieldValue(input.service)}${sha}${strategy}${cls}${tier}${nextStep}${trigger} -->`
}

export function parseAnnotation(body: string): CrosscheckAnnotationInput | null {
  const fields = parseAnnotationFields(body)
  if (!fields) return null

  const origin = fields.get('origin')
  const reviewer = fields.get('reviewer')
  if (!origin || !reviewer) return null

  // Defaults keep legacy annotations parseable:
  // type=review, round=1, service=crosscheck, model=default.
  return {
    origin,
    reviewer,
    model: fields.get('model') ?? DEFAULT_MODEL,
    type: parseType(fields.get('type')),
    round: parseRound(fields.get('round')),
    verdict: fields.get('verdict') ?? 'UNKNOWN',
    service: fields.get('service') ?? DEFAULT_SERVICE,
    ...(fields.has('sha') && { sha: fields.get('sha') }),
    ...(fields.has('next_step') && { next_step: fields.get('next_step') }),
    ...(fields.has('trigger') && { trigger: fields.get('trigger') }),
    // Read back out, not just written: otherwise the strategy fields are
    // write-only and no reader can aggregate which policy produced a review.
    ...(fields.has('strategy') && { strategy: fields.get('strategy') }),
    ...(fields.has('class') && { class: fields.get('class') }),
    ...(fields.has('tier') && { tier: fields.get('tier') }),
  }
}

export function parseAnnotationFields(body: string): ReadonlyMap<string, string> | null {
  return parseAnnotationFieldsFenced(body)
}

// Like parseAnnotationFields but skips annotations inside fenced code blocks
// (``` or ~~~). Prevents annotations in examples from being misread as the
// authoritative crosscheck marker for a comment.
//
// Bareword tokens (e.g. `fix_applied`, `conflict_resolved`) that have no `=`
// are stored in the returned map under the key '__marker__' so callers can
// detect them without special-casing the loop.
export function parseAnnotationFieldsFenced(body: string): ReadonlyMap<string, string> | null {
  let inFence = false
  let lastMatch: string | null = null
  for (const line of body.split('\n')) {
    const trimmed = line.trim()
    if (trimmed.startsWith('```') || trimmed.startsWith('~~~')) {
      inFence = !inFence
      continue
    }
    if (inFence) continue
    const match = trimmed.match(/^<!--\s*crosscheck:\s*([^>]*)-->/)
    if (match) lastMatch = match[1]
  }
  if (!lastMatch) return null
  return parseFieldsWithMarker(lastMatch)
}

function parseFieldsWithMarker(attrs: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const token of attrs.trim().split(/\s+/).filter(Boolean)) {
    const eq = token.indexOf('=')
    if (eq === -1) {
      // Bareword token: store as marker (last one wins, matching legacy behaviour)
      fields.set('__marker__', token)
    } else {
      fields.set(token.slice(0, eq), token.slice(eq + 1))
    }
  }
  return fields
}

export function buildCommitTrailers(input: CrosscheckCommitTrailerInput): string {
  return [
    `Crosscheck-Reviewer: ${fieldValue(input.reviewer)}`,
    `Crosscheck-Model: ${fieldValue(input.model)}`,
    `Crosscheck-Step: ${fieldValue(input.step)}`,
    `Crosscheck-Service: ${fieldValue(input.service)}`,
  ].join('\n')
}

function parseFields(attrs: string): Map<string, string> {
  const fields = new Map<string, string>()
  for (const match of attrs.matchAll(/\b([a-z_]+)=([^\s]+)/g)) {
    fields.set(match[1], match[2])
  }
  return fields
}

function parseType(value: string | undefined): CrosscheckStepType | string {
  if (value === undefined) return DEFAULT_TYPE
  return STEP_TYPES.has(value as CrosscheckStepType) ? (value as CrosscheckStepType) : value
}

function parseRound(value: string | undefined): number {
  if (value === undefined) return DEFAULT_ROUND
  const parsed = Number.parseInt(value, 10)
  return Number.isInteger(parsed) && parsed > 0 ? parsed : DEFAULT_ROUND
}

function fieldValue(value: string): string {
  return value.trim().replace(/\s+/g, '_')
}
