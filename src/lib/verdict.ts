import chalk from 'chalk'

export type Verdict = 'APPROVE' | 'NEEDS WORK' | 'BLOCK'

// Primary: strict line match.
// Handles: heading prefix (## VERDICT:), bold label (**VERDICT:**), bold value (VERDICT: **APPROVE**),
// NEEDS_WORK / NEEDS  WORK spelling variants, trailing period.
const PRIMARY_RE = /^(?:#{1,6}\s*)?(?:\*{1,2})?VERDICT:(?:\*{1,2})?\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?\.?\s*$/im
// Fallback: VERDICT: token anywhere in the text (inline prose, blockquote, bold value)
const FALLBACK_RE = /VERDICT:\s*(?:\*{1,2})?(APPROVE|NEEDS[\s_]+WORK|BLOCK)(?:\*{1,2})?/gi

function normalizeVerdict(raw: string): Verdict {
  return raw.toUpperCase().replace(/[\s_]+/, ' ').trim() as Verdict
}

export function parseVerdict(text: string): { verdict: Verdict | null; clean: string } {
  // Primary: look for a clean VERDICT: line (last match wins in case of duplicates)
  const primaryMatches = [...text.matchAll(new RegExp(PRIMARY_RE.source, 'gim'))]
  if (primaryMatches.length > 0) {
    const last = primaryMatches[primaryMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const clean = text.replace(new RegExp(PRIMARY_RE.source, 'gim'), '').replace(/\n{3,}/g, '\n\n').trim()
    return { verdict, clean }
  }

  // Fallback: VERDICT: anywhere — last occurrence wins
  const fallbackMatches = [...text.matchAll(FALLBACK_RE)]
  if (fallbackMatches.length > 0) {
    const last = fallbackMatches[fallbackMatches.length - 1]
    const verdict = normalizeVerdict(last[1])
    const idx = last.index ?? 0
    const rawClean = text.slice(0, idx) + text.slice(idx + last[0].length)
    return { verdict, clean: rawClean.replace(/\n{3,}/g, '\n\n').trim() }
  }

  return { verdict: null, clean: text }
}

export const NULL_VERDICT_WARNING =
  '> ⚠️ crosscheck could not extract a verdict from this review.'

// Posted when the severity gate downgrades a NEEDS WORK review to APPROVE because
// it carries no blocking finding — keeps the notes visible without driving the loop.
export const SEVERITY_GATE_NOTE =
  '> ℹ️ No blocking (Critical/High/Medium) findings — approving with comments. The notes below are non-blocking; address at your discretion.'

// A list of "no findings" phrasings, reduced to letters-only (punctuation, bullets,
// and whitespace stripped) so "- None.", "N/A", and "None found" all compare equal.
const EMPTY_SECTION_PHRASES = new Set([
  'none', 'nonefound', 'noneidentified', 'nonenoted', 'nonidentified', 'na',
  'nocritical', 'nocriticalissues', 'nocriticalissuesfound', 'noblocking',
  'noblockingissues', 'noissues', 'noissuesfound',
])

// Hedged empties: a reviewer that could not do the work writes "None assessed."
// or "Not evaluated" rather than a bare "None". Enumerating every phrasing in the
// set above never converges — a negation paired with an assessment verb is the
// stable shape, so match that instead. Anchored, so "None assessed as critical,
// but see below" keeps its content and stays blocking.
// Verb stems carry an explicit optional `ed` rather than a trailing `d?`: `assessed?`
// reads as "assesse" plus an optional d, which silently fails to match the bare
// "assess" in "Could not assess".
const HEDGED_EMPTY_RE =
  /^(?:none|not|no|nothing|unableto|couldnot|cannot|didnot|wasnot|werenot)(?:been)?(?:assess(?:ed)?|evaluat(?:e|ed)|determin(?:e|ed)|review(?:ed)?|analy[sz](?:e|ed)|examin(?:e|ed)|check(?:ed)?|inspect(?:ed)?|perform(?:ed)?|applicable|available|possible)$/

// Whether a section body, reduced to letters, states "no findings" — either as one
// of the fixed phrasings or as a hedged empty.
function isEmptySectionPhrase(letters: string): boolean {
  return EMPTY_SECTION_PHRASES.has(letters) || HEDGED_EMPTY_RE.test(letters)
}

// Whether the named section lists a real finding rather than an explicit "None".
// Returns false when the section is absent entirely.
function findSection(text: string, headingPattern: string): RegExpMatchArray | null {
  return text.match(new RegExp(`^#{1,6}\\s*${headingPattern}\\b.*$`, 'im'))
}

function sectionHasContent(text: string, headingPattern: string): boolean {
  const heading = findSection(text, headingPattern)
  if (!heading) return false
  const rest = text.slice((heading.index ?? 0) + heading[0].length)
  const next = rest.match(/^#{1,6}\s+\S/m)
  const body = (next ? rest.slice(0, next.index) : rest)
  const letters = body.replace(/[^a-z]/gi, '').toLowerCase()
  if (letters === '') return false
  return !isEmptySectionPhrase(letters)
}

// The review's "Critical Issues" section (Claude's mandated format). Absent section
// means non-blocking: a NEEDS WORK without an explicit Critical section is, by the
// reviewer's own definition, not a blocker.
function criticalSectionHasContent(text: string): boolean {
  return sectionHasContent(text, 'Critical(?:\\s+Issues?)?')
}

// A review blocks merge when it contains a P0/P1 (critical/high) or P2 (medium/correctness)
// finding. Only P3 nits (style, naming) are non-blocking.
// Recognises both Codex priority markers ([P0]/[P1]/[P2]) and Claude's structured
// "## Critical Issues" section.
export function hasBlockingFindings(reviewText: string): boolean {
  if (/\[P[012]\]/i.test(reviewText)) return true
  return criticalSectionHasContent(reviewText)
}

export interface SeverityGateResult {
  verdict: Verdict | null
  // True when the gate changed the verdict (NEEDS WORK → APPROVE).
  downgraded: boolean
}

// Severity gate: only P3-only (nit/style) reviews are downgraded from NEEDS WORK to
// APPROVE, preventing review-loop churn on trivial suggestions. P2 (medium/correctness)
// findings keep the NEEDS WORK verdict and require human attention before merge.
// BLOCK and APPROVE are never altered.
export function applySeverityGate(verdict: Verdict | null, reviewText: string): SeverityGateResult {
  if (verdict === 'NEEDS WORK' && !hasBlockingFindings(reviewText)) {
    return { verdict: 'APPROVE', downgraded: true }
  }
  return { verdict, downgraded: false }
}

// Phrases a reviewer uses to say it never actually reviewed the diff. The one that
// started this: a deleted base branch left `origin/<base>` absent from the checkout,
// codex answered "Review could not be performed", and crosscheck posted it as a
// NEEDS WORK that then drove a fix step with nothing to fix.
const INCONCLUSIVE_MARKERS: ReadonlyArray<{ re: RegExp; reason: string }> = [
  { re: /\breview\s+(?:could\s+not|cannot|can'?t|was\s+not\s+able\s+to)\s+be\s+(?:performed|completed|carried\s+out|done)/i, reason: 'reviewer reported it could not perform the review' },
  { re: /\b(?:unable|failed)\s+to\s+(?:review|resolve\s+the\s+diff|compute\s+the\s+diff|obtain\s+the\s+diff)/i, reason: 'reviewer could not resolve the diff' },
  { re: /\b(?:diff|changes?)\s+(?:could\s+not|cannot|can'?t)\s+be\s+(?:resolved|determined|computed|produced)/i, reason: 'reviewer could not resolve the diff' },
  { re: /\babsent\s+from\s+(?:this|the)\s+checkout\b/i, reason: 'a required ref was absent from the checkout' },
  { re: /\b(?:base|target)\s+(?:ref|branch|commit)\b[^.\n]{0,60}?\b(?:is|was|are|were)?\s*(?:missing|absent|unavailable|not\s+(?:found|available|present))\b/i, reason: 'the base ref was missing from the checkout' },
  { re: /\bno\s+diff\s+(?:is\s+|was\s+)?available\b/i, reason: 'no diff was available to review' },
  { re: /\bempty\s+diff\b[^.\n]{0,40}\bnothing\s+to\s+review\b/i, reason: 'the diff was empty' },
]

export interface InconclusiveReview {
  inconclusive: boolean
  /** Human-readable cause, for the log line and the operator-facing message. */
  reason?: string
}

// Whether a review body is a self-reported non-review rather than a verdict.
//
// Gated on the review carrying no blocking finding: a reviewer that found a real
// P0 while also grumbling that some ref was missing did do work, and that verdict
// must still be posted. Only a body with nothing actionable in it is discarded.
// This deliberately outranks the severity gate — a P3-only non-review would
// otherwise be *upgraded* to APPROVE, which is the worst available outcome.
export function detectInconclusiveReview(reviewText: string): InconclusiveReview {
  if (hasBlockingFindings(reviewText)) return { inconclusive: false }
  for (const { re, reason } of INCONCLUSIVE_MARKERS) {
    if (re.test(reviewText)) return { inconclusive: true, reason }
  }
  return { inconclusive: false }
}

// The headings reviewers put findings under. Nits and suggestions are included:
// they are not blocking, but they are actionable, and `ck fix` is how a user opts
// into applying them.
const FINDING_SECTIONS = [
  'Critical(?:\\s+Issues?)?', 'Blocking(?:\\s+Issues?)?', 'Warnings?', 'Suggestions?',
  'Nits?', 'Minor(?:\\s+Issues?)?', 'Recommendations?', 'Issues?', 'Findings?',
]

/**
 * Whether a review demonstrably contains nothing a fix step could act on.
 *
 * Deliberately asymmetric: this must never claim emptiness it cannot prove, because
 * the caller skips the fix on a true answer and a false positive silently drops a
 * legitimate fix. So a body in an unrecognised format — no priority markers and no
 * known heading — returns false and the fix runs, at worst costing the vendor call
 * it would have cost anyway. Only a body whose every recognised section is an
 * explicit "None" is reported empty.
 */
export function reviewHasNoFindings(reviewText: string): boolean {
  if (/\[P[0-3]\]/i.test(reviewText)) return false
  const present = FINDING_SECTIONS.filter(name => findSection(reviewText, name) !== null)
  if (present.length === 0) return false
  return present.every(name => !sectionHasContent(reviewText, name))
}

export function formatVerdict(verdict: Verdict | null): string {
  if (!verdict) return chalk.dim('verdict  —')
  if (verdict === 'APPROVE')    return `verdict  ${chalk.green('✅ APPROVE')}`
  if (verdict === 'NEEDS WORK') return `verdict  ${chalk.yellow('⚠  NEEDS WORK')}`
  if (verdict === 'BLOCK')      return `verdict  ${chalk.red('🚫 BLOCK')}`
  return chalk.dim('verdict  —')
}

// Prepend a bold verdict badge to the review comment posted to GitHub
export function prependVerdictToComment(text: string, verdict: Verdict | null): string {
  if (!verdict) return text
  const badge =
    verdict === 'APPROVE'    ? '✅ **APPROVE**' :
    verdict === 'NEEDS WORK' ? '⚠️ **NEEDS WORK**' :
                               '🚫 **BLOCK**'
  return `${badge}\n\n${text}`
}
