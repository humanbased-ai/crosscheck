// Comment bodies posted after silent-commit step pushes (fix in commit mode,
// conflict-resolve) so the timeline shows a card instead of just a "X pushed
// N commits" line. Pure functions — kept here so they can be unit-tested
// without exercising the runner.
import { CROSSCHECK_REPO_URL } from './product.js'
import { modelDisplayName } from './review-models.js'
import { renderSkillAttributionLine } from '../skills/attribution.js'
import type { SkillMetadata } from '../skills/broker.js'

// Every card crosscheck posts closes the same way: a rule, one italic line
// naming the CLI that did the work and how it was configured, then the skill
// receipt beneath it. Shared here so review, fix and conflict-resolve can't
// drift apart.
export interface AttributionFooterInput {
  /** Past-tense verb for what the step did: Reviewed / Fixed / Resolved. */
  action: string
  /** 'claude' | 'codex'. Anything else (or unset) attributes to Claude Code. */
  vendor?: string
  /** Resolved model id; 'default' and unset render no model segment. */
  model?: string
  /** Reasoning effort the CLI actually ran with. */
  effort?: string
  skills?: SkillMetadata[]
  /** brand.reviewer_attribution — replaces the sentence, keeps the run details. */
  override?: string
  /** One line naming the tier, why the PR earned it, and the strategy version. */
  strategyNote?: string
}

export function buildAttributionFooter(input: AttributionFooterInput): string {
  const vendorLink = input.vendor === 'codex'
    ? '[OpenAI Codex](https://openai.com/codex)'
    : '[Claude Code](https://claude.ai/code)'
  const sentence = input.override
    || `_${input.action} with ${vendorLink} via [Crosscheck](${CROSSCHECK_REPO_URL})_`
  // Its own italic run so a branded override keeps whatever markdown it uses.
  const runDetail = [
    modelDisplayName(input.model ?? 'default'),
    input.effort ? `${input.effort} effort` : null,
  ].filter(Boolean).join(' · ')
  const skillsLine = renderSkillAttributionLine(input.skills ?? [])
  // Why this model ran, in the reviewer's own words — the matched class's
  // reason, not prose written per review, so the explanation and the routing
  // decision cannot drift apart.
  const strategyLine = input.strategyNote ? `\n_${input.strategyNote}_` : ''
  return `---\n${sentence}${runDetail ? ` _(${runDetail})_` : ''}${strategyLine}${skillsLine ? `\n\n${skillsLine}` : ''}`
}

// Cap the file list at this length to keep comment bodies readable when a
// resolve touches many files.
const MAX_FILES_LISTED = 20
const MAX_FILES_IN_FIX = 10
const MAX_ISSUES_LISTED = 8

// Extract the first N list items from a review comment body to surface what
// issues the fix addressed. Strips annotation tags before scanning.
function extractIssuePoints(reviewBody: string, max: number): string[] {
  const cleaned = reviewBody.replace(/<!--[\s\S]*?-->/g, '').trim()
  const items: string[] = []
  let inCodeBlock = false
  for (const line of cleaned.split('\n')) {
    if (/^```/.test(line.trim())) { inCodeBlock = !inCodeBlock; continue }
    if (inCodeBlock) continue
    const t = line.trim()
    if (!/^[-*•]\s+\S/.test(t) && !/^\d+\.\s+\S/.test(t)) continue
    const text = t.replace(/^[-*•]\s+/, '').replace(/^\d+\.\s+/, '').trim()
    if (text.length > 0 && text.length < 200) items.push(text)
    if (items.length >= max) break
  }
  return items
}

export interface FixAppliedCommentInput {
  owner: string
  repo: string
  sha: string
  appliedCount: number
  reviewCommentId?: number
  /** Files written by the fix step. Rendered as a bullet list. */
  changedFiles?: string[]
  /** Which vendor ran the fix ('claude' | 'codex'). Controls attribution link. */
  vendor?: string
  /** Body of the review comment the fix addressed. Issue points are extracted and listed. */
  reviewCommentBody?: string
  /** Model the fix ran with. Rendered in the attribution. */
  model?: string
  /** Reasoning effort the fix ran with. Rendered in the attribution. */
  effort?: string
  /** Skills the fix step activated. Rendered beneath the attribution. */
  skills?: SkillMetadata[]
}

export function buildFixAppliedCommentBody(input: FixAppliedCommentInput): string {
  const { owner, repo, sha, appliedCount, reviewCommentId, changedFiles, vendor, reviewCommentBody, model, effort, skills } = input
  const shortSha = sha.slice(0, 7)
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${sha}`
  const backlink = reviewCommentId
    ? ` addressing the [code review](#issuecomment-${reviewCommentId})`
    : ''
  const plural = appliedCount !== 1 ? 's' : ''

  const lines: string[] = [
    '### ✅ Auto-fix applied',
    '',
    `Pushed [\`${shortSha}\`](${commitUrl})${backlink}: **${appliedCount} change${plural} applied**.`,
  ]

  if (reviewCommentBody) {
    const issues = extractIssuePoints(reviewCommentBody, MAX_ISSUES_LISTED)
    if (issues.length > 0) {
      lines.push('', '**Issues addressed:**')
      for (const issue of issues) lines.push(`- ${issue}`)
    }
  }

  if (changedFiles && changedFiles.length > 0) {
    lines.push('', '**Files changed:**')
    const shown = changedFiles.slice(0, MAX_FILES_IN_FIX)
    const remainder = changedFiles.length - shown.length
    for (const f of shown) lines.push(`- \`${f}\``)
    if (remainder > 0) lines.push(`- _...and ${remainder} more_`)
  }

  lines.push(
    '',
    buildAttributionFooter({ action: 'Fixed', vendor, model, effort, skills }),
    '',
    '<!-- crosscheck: fix_applied -->',
  )

  return lines.join('\n')
}

export interface FixFailedCommentInput {
  prUrl: string
  vendor?: string
  model?: string
  effort?: string
  skills?: SkillMetadata[]
}

// Posted when the fix step times out after its retry. Nothing was produced, so
// the footer reports rather than claims credit — but it still names the model
// and effort that timed out, which is the first thing worth knowing.
export function buildFixFailedCommentBody(input: FixFailedCommentInput): string {
  return [
    '⚠️ **Auto-fix failed**',
    '',
    `The fix step timed out after retrying. Push a new commit or run \`crosscheck run ${input.prUrl}\` to retry manually.`,
    '',
    buildAttributionFooter({
      action: 'Attempted',
      vendor: input.vendor,
      model: input.model,
      effort: input.effort,
      skills: input.skills,
      override: `_Reported by [Crosscheck](${CROSSCHECK_REPO_URL})_`,
    }),
    '',
    '<!-- crosscheck: fix_failed -->',
  ].join('\n')
}

// Prominent banner prepended to a review comment when the first review attempt
// timed out but the delayed retry (same timeout) succeeded. Signals a transient
// blip that resolved on its own — the user's timeout budget was respected.
export function buildRetriedReviewBanner(timeoutMs: number, delayMs: number): string {
  const timeoutSec = Math.round(timeoutMs / 1000)
  const delaySec = Math.round(delayMs / 1000)
  return `> ⏱ **Retried** — the first review attempt timed out at ${timeoutSec}s. ` +
    `This review succeeded on the second attempt after a ${delaySec}s wait. ` +
    `If this happens repeatedly the PR may genuinely need a longer \`timeout_sec\`.`
}

export type ReviewFailedReason = 'timeout' | 'usage_limit' | 'subprocess_error'

export interface ReviewFailedCommentInput {
  prUrl: string
  reason: ReviewFailedReason
  // One-line user-facing description rendered after `**Reason**:`.
  summary: string
  // Optional context block (timeout cap, retry info, stderr tail). When set,
  // rendered inside a collapsible <details> block so the timeline stays compact.
  details?: string
}

// Posted on the PR by watch.ts when a reviewer subprocess fails after retry
// exhaustion (timeout) or on a non-recoverable error (auth, usage limit,
// subprocess crash). Uses a bareword marker (not a review annotation) so
// Phase 1 detection ignores it — the next push still triggers a fresh review.
export function buildReviewFailedCommentBody(input: ReviewFailedCommentInput): string {
  const { prUrl, reason, summary, details } = input
  const title = TITLE_BY_REASON[reason]
  const lines: string[] = [
    title,
    '',
    `crosscheck couldn't finish reviewing this PR.`,
    '',
    `**Reason**: ${summary}`,
  ]
  if (details && details.trim().length > 0) {
    lines.push(
      '',
      '<details>',
      '<summary>Details</summary>',
      '',
      details.trim(),
      '',
      '</details>',
    )
  }
  lines.push(
    '',
    `Push a new commit, or run \`crosscheck run ${prUrl}\` to retry.`,
    '',
    '---',
    `_Reported by [Crosscheck](${CROSSCHECK_REPO_URL})._`,
    '',
    '<!-- crosscheck: review_failed -->',
  )
  return lines.join('\n')
}

const TITLE_BY_REASON: Record<ReviewFailedReason, string> = {
  timeout: '### ⏱️ Review failed — timed out',
  usage_limit: '### 🚫 Review failed — reviewer hit usage limit',
  subprocess_error: '### ❌ Review failed',
}

export interface ConflictResolvedCommentInput {
  owner: string
  repo: string
  sha: string
  conflictCount: number
  files: string[]
  /** Model the resolver ran with. Rendered in the attribution. */
  model?: string
  /** Reasoning effort the resolver ran with. Rendered in the attribution. */
  effort?: string
  /** Skills the conflict-resolve step activated. Rendered beneath the attribution. */
  skills?: SkillMetadata[]
}

export function buildConflictResolvedCommentBody(input: ConflictResolvedCommentInput): string {
  const { owner, repo, sha, conflictCount, files, model, effort, skills } = input
  const shortSha = sha.slice(0, 7)
  const commitUrl = `https://github.com/${owner}/${repo}/commit/${sha}`
  const plural = conflictCount !== 1 ? 's' : ''

  const shown = files.slice(0, MAX_FILES_LISTED)
  const remainder = files.length - shown.length
  const fileLines = shown.map(p => `- \`${p}\``)
  if (remainder > 0) fileLines.push(`- _...and ${remainder} more_`)

  return [
    '### 🔀 Conflicts resolved',
    '',
    `Resolved ${conflictCount} conflict${plural} in:`,
    ...fileLines,
    '',
    `Pushed [\`${shortSha}\`](${commitUrl}).`,
    '',
    // Conflict resolution is Claude-only today; the footer still routes through
    // the shared builder so the wording matches review and fix.
    buildAttributionFooter({ action: 'Resolved', vendor: 'claude', model, effort, skills }),
    '',
    '<!-- crosscheck: conflict_resolved -->',
  ].join('\n')
}
