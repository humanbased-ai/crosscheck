import type { StepOutcomes, RanStepDetail } from './runner.js'
import { fmtTokensRaw } from './board.js'
import { shaCovers } from './pr-workflow-state.js'

// A run can end with no verdict for four structurally different reasons, and
// until this module they all printed the same thing: `verdict —` under a green
// checkmark. A no-op fix that judged nothing, a review that ran at full price
// and emitted no parseable VERDICT: line, a workflow with no review step at
// all, and a deliberate one-step dispatch were indistinguishable in the output.
//
// The trigger is `verdict === null` — nothing narrower. Scoping the report to
// "ran something but wasn't judged" (or, as before, to "nothing ran at all")
// just moves the blind spot: what makes a verdict missing is not which steps
// executed, but what happened to the steps that produce verdicts.

/** What became of a step that can produce a verdict. Exactly one holds. */
export type VerdictStepDisposition =
  /** No review/recheck step exists in the resolved workflow. */
  | 'not_configured'
  /** Configured, but excluded before dispatch — --steps, repo override,
   *  strategy narrowing, or a resume that started past it. */
  | 'not_dispatched'
  /** Dispatched and skipped; carries the reason from its step_skipped entry. */
  | 'skipped'
  /** Ran, posted, and its output carried no parseable verdict. */
  | 'ran_no_verdict'
  /** Ran and produced a verdict. Present for completeness — a run in this state
   *  has a verdict and never reaches this report. */
  | 'ran'

export interface VerdictStepStatus {
  step: string
  disposition: VerdictStepDisposition
  reason?: string
}

export type NoVerdictCause =
  | 'strategy_skip'
  | 'not_configured'
  | 'ran_no_verdict'
  | 'skipped'
  | 'not_dispatched'
  | 'fix_noop'

/** Minimal shape of a workflow step — name and type are all this needs, so
 *  callers can pass WorkflowStep directly without a conversion. */
export interface VerdictStepShape {
  name: string
  type: string
}

/** Minimal shape of a step history record — type and verdict are all this needs. */
export interface JudgedRecordShape {
  type: string
  verdict?: string
  sha?: string
}

/**
 * The verdict that still governs the PR: the newest review or recheck that
 * actually carries one.
 *
 * A review can run, post its findings, and record no verdict at all — that is
 * the `ran_no_verdict` disposition, and it says nothing about the `BLOCK` that
 * was standing before it. Taking the newest review-or-recheck record
 * unconditionally would let one malformed review erase a verdict that still
 * gates the PR, and the report would go quiet about it in exactly the state
 * that most needs saying out loud.
 */
export function selectStandingVerdict(
  history: readonly JudgedRecordShape[],
): { verdict: string; sha?: string } | undefined {
  const judged = history.filter(r => isVerdictStep(r.type) && r.verdict).at(-1)
  if (!judged?.verdict) return undefined
  return { verdict: judged.verdict, ...(judged.sha !== undefined && { sha: judged.sha }) }
}

export interface NoVerdictInput {
  /** The resolved workflow BEFORE step filtering. Filtering is what separates
   *  `not_configured` from `not_dispatched`, so the pre-filter list is required. */
  workflowSteps: readonly VerdictStepShape[]
  /** Accumulated across every round of the invocation. */
  outcomes?: StepOutcomes
  /** PR class when the review strategy skipped the PR outright. */
  strategySkipped?: string | null
  /** True when this invocation asked for a subset of steps on purpose — an
   *  explicit --steps flag or a kickass one-step dispatch. Not set by resume,
   *  which starts mid-workflow but still runs to the end. */
  stepsExplicitlyScoped?: boolean
  prUrl: string
  /** Verdict already standing on the PR from an earlier run, if known. */
  standingVerdict?: { verdict?: string; sha?: string }
  headSha?: string
}

export interface NoVerdictReport {
  /** False when this invocation could have produced a verdict and didn't.
   *  Drives the ⚠/✓ marker — coverage is universal, alarm is not. */
  expected: boolean
  cause: NoVerdictCause
  verdictSteps: VerdictStepStatus[]
  ran: { step: string; detail: string }[]
  didNotRun: { step: string; note: string }[]
  why: string[]
  next: { text: string; recommended: boolean }[]
  notes: string[]
}

function isVerdictStep(type: string): boolean {
  return type === 'review' || type === 'recheck'
}

/**
 * Classifies every verdict-capable step in the workflow. When none is
 * configured, returns a single synthetic `review` entry — the absence is itself
 * the answer, and callers should not have to special-case an empty array.
 */
export function describeVerdictSteps(
  workflowSteps: readonly VerdictStepShape[],
  outcomes: StepOutcomes | undefined,
): VerdictStepStatus[] {
  const steps = workflowSteps.filter(s => isVerdictStep(s.type))
  if (steps.length === 0) return [{ step: 'review', disposition: 'not_configured' }]

  const ran = new Set(outcomes?.ran ?? [])
  const skipped = new Map((outcomes?.skipped ?? []).map(s => [s.step, s.reason]))

  return steps.map(({ name }): VerdictStepStatus => {
    if (ran.has(name)) {
      // `verdict: null` means the step ran and its output had no parseable
      // verdict. A missing key means the step recorded no verdict field at all,
      // which for a dispatched verdict step means it ran normally.
      const detail = outcomes?.ranDetail?.[name]
      return detail && 'verdict' in detail && detail.verdict === null
        ? { step: name, disposition: 'ran_no_verdict' }
        : { step: name, disposition: 'ran' }
    }
    const reason = skipped.get(name)
    if (reason !== undefined) return { step: name, disposition: 'skipped', reason }
    return { step: name, disposition: 'not_dispatched' }
  })
}

// Guards that stop the run deliberately. Re-running the same step walks into the
// same cap, so these get an explanation instead of a command.
const DELIBERATE_STOPS = new Set(['max_rounds', 'commit_limit_reached', 'vendor_limit'])
// Reasons that mean no vendor was available to do the work — a config gap, not
// a per-run accident.
const ROUTING_GAPS = new Set(['no_vendor', 'no_reviewer', 'unsupported_vendor', 'human_origin'])

function describeSkipReason(reason: string, step: string, prUrl: string): {
  next: { text: string; recommended: boolean }[]
  notes: string[]
} {
  if (ROUTING_GAPS.has(reason)) {
    return {
      next: [
        { text: 'set routing.fallback_reviewer in ~/.crosscheck/config.yml', recommended: true },
        { text: `ck run ${prUrl} --reviewer <claude|codex>`, recommended: false },
      ],
      notes: ['No vendor was available to judge this PR — nothing about the code caused this.'],
    }
  }
  if (DELIBERATE_STOPS.has(reason)) {
    return {
      next: [],
      notes: [`${step} stopped on \`${reason}\` — crosscheck gave up on purpose, so this needs a human.`],
    }
  }
  if (reason === 'no_change_since_review') {
    return {
      next: [{ text: `ck run ${prUrl} --steps review`, recommended: false }],
      notes: ['Nothing has changed since the last review, so there was nothing new to judge.'],
    }
  }
  return { next: [{ text: `ck run ${prUrl} --steps ${step}`, recommended: true }], notes: [] }
}

function shortSha(sha?: string): string | undefined {
  return sha === undefined ? undefined : sha.slice(0, 7)
}

function formatRanDetail(detail: RanStepDetail): string {
  const parts: string[] = []
  if (detail.vendor) parts.push(detail.vendor)
  if (detail.tokensUsed !== undefined) parts.push(`${fmtTokensRaw(detail.tokensUsed)} tokens`)
  if (detail.appliedCount === 0) parts.push('no changes applied')
  else if (detail.appliedCount !== undefined) parts.push(`${detail.appliedCount} change${detail.appliedCount === 1 ? '' : 's'} applied`)
  if (detail.verdict === null) parts.push('no verdict parsed')
  return parts.join(' · ')
}

/**
 * Explains an empty verdict and says what to do about it. Pure — every input it
 * needs is already in memory at the reporting site.
 */
export function buildNoVerdictReport(input: NoVerdictInput): NoVerdictReport {
  const { workflowSteps, outcomes, prUrl } = input
  const verdictSteps = describeVerdictSteps(workflowSteps, outcomes)

  const ran = (outcomes?.ran ?? []).map(step => ({
    step,
    detail: outcomes?.ranDetail?.[step] ? formatRanDetail(outcomes.ranDetail[step]) : '',
  }))

  const why: string[] = []
  let next: { text: string; recommended: boolean }[] = []
  const notes: string[] = []

  // Precedence: a step that ran and produced nothing outranks one that skipped,
  // which outranks one that never ran. The most specific thing that happened is
  // the thing worth reporting.
  // Fix steps by type: conflict-resolve records `applied_count: 0` too, and a
  // branch with no conflicts to resolve says nothing about a review's findings.
  const fixStepNames = new Set(workflowSteps.filter(s => s.type === 'fix').map(s => s.name))
  const noopFixStep = (outcomes?.ran ?? []).find(step =>
    fixStepNames.has(step) && outcomes?.ranDetail?.[step]?.appliedCount === 0)
  // True when every step this run actually ran was a fix that changed nothing —
  // i.e. the run's whole output was nothing at all.
  const scopedFixDidNothing = noopFixStep !== undefined
    && (outcomes?.ran ?? []).every(step => outcomes?.ranDetail?.[step]?.appliedCount === 0)
    ? noopFixStep
    : undefined

  const ranNoVerdict = verdictSteps.find(v => v.disposition === 'ran_no_verdict')
  const skippedStep = verdictSteps.find(v => v.disposition === 'skipped')
  const allNotConfigured = verdictSteps.every(v => v.disposition === 'not_configured')
  const allNotDispatched = verdictSteps.every(v => v.disposition === 'not_dispatched')

  let cause: NoVerdictCause
  let expected: boolean

  if (input.strategySkipped) {
    cause = 'strategy_skip'
    expected = true
    why.push(`PR classified ${input.strategySkipped} — the strategy skipped it, so no step produced a verdict.`)
  } else if (allNotConfigured) {
    cause = 'not_configured'
    expected = true
    why.push('This workflow has no review or recheck step, so it produces no verdict by design.')
  } else if (ranNoVerdict) {
    cause = 'ran_no_verdict'
    expected = false
    why.push(`${ranNoVerdict.step} ran and posted, but its output carried no parseable VERDICT: line.`)
    why.push('The findings are in the comment; the workflow has no verdict to gate on.')
    next = [{ text: `ck run ${prUrl} --steps ${ranNoVerdict.step}`, recommended: true }]
    notes.push('Malformed vendor output is usually transient — a re-run normally settles it.')
  } else if (skippedStep) {
    cause = 'skipped'
    expected = false
    why.push('Only review and recheck produce verdicts, and neither judged this commit.')
    const advice = describeSkipReason(skippedStep.reason ?? 'unknown', skippedStep.step, prUrl)
    next = advice.next
    notes.push(...advice.notes)
  } else if (scopedFixDidNothing) {
    // `ck fix` asks for exactly one step, so a missing verdict is expected and the
    // run would otherwise close green — the same green a fix that rewrote ten files
    // prints. The absent verdict is indeed expected; the absent *change* is not,
    // and it is the only thing the invocation was for.
    cause = 'fix_noop'
    expected = false
    why.push(`This run was scoped to ${scopedFixDidNothing}, which ran and applied no changes.`)
    why.push('Nothing was written to the PR — the review it read may carry no actionable findings, or they may already be resolved in HEAD.')
    next = [{ text: `ck run ${prUrl} --steps review`, recommended: true }]
    notes.push('A review that could not resolve the diff produces a findings-free body that no fix can act on — check the review comment the fix step read.')
  } else {
    cause = 'not_dispatched'
    // A run that asked for one step got what it asked for. An unscoped run that
    // dispatched no verdict step did not.
    expected = allNotDispatched && input.stepsExplicitlyScoped === true
    why.push(expected
      ? 'This run was scoped to steps that do not produce verdicts.'
      : 'Only review and recheck produce verdicts, and neither was dispatched.')
    if (!expected) {
      next = [{ text: `ck run ${prUrl} --steps review`, recommended: true }]
    }
  }

  // Context that holds regardless of cause: what the PR still says, and whether
  // it still describes the code under review.
  if (!expected && input.standingVerdict?.verdict) {
    const sha = shortSha(input.standingVerdict.sha)
    const head = shortSha(input.headSha)
    // shaCovers is the codebase's one definition of "the same commit" — it
    // handles the short/full forms annotations carry either of. A verdict whose
    // SHA is unknown proves nothing about HEAD, so it is reported without the
    // staleness claim rather than guessed at.
    const covers = input.headSha !== undefined && shaCovers(input.standingVerdict.sha, input.headSha)
    why.push(sha !== undefined && head !== undefined && !covers
      ? `The PR's standing verdict is ${input.standingVerdict.verdict} on ${sha}, which is not HEAD (${head}).`
      : `The PR's standing verdict is still ${input.standingVerdict.verdict}${sha ? ` on ${sha}` : ''}.`)
  }

  // A fix that applied nothing is the strongest hint available that the findings
  // are already resolved — which is precisely what a recheck confirms. Not repeated
  // under `fix_noop`, where it is already the headline.
  if (!expected && noopFixStep && cause !== 'ran_no_verdict' && cause !== 'fix_noop') {
    why.push(`The ${noopFixStep} step applied no changes — the findings may already be resolved in HEAD.`)
  }

  // Offer the other verdict step as an alternative: recheck judges against the
  // original findings, review sets them aside. Not for malformed output, where
  // the action is to re-run the step that misbehaved and a second command only
  // blurs that.
  const recommendedStep = next.find(n => n.recommended)?.text.match(/--steps (\S+)/)?.[1]
  const alternative = verdictSteps.find(v => v.step !== recommendedStep && v.disposition !== 'not_configured')
  if (cause !== 'ran_no_verdict' && recommendedStep && alternative
    && !next.some(n => n.text.includes(`--steps ${alternative.step}`))) {
    next.push({ text: `ck run ${prUrl} --steps ${alternative.step}`, recommended: false })
  }

  // Skipped steps of any type bear on the outcome, so all of them are listed. A
  // step that was never dispatched earns a line only when it produces verdicts
  // AND its absence is the problem: a conflict-resolve that sat out explains
  // nothing about a missing verdict, and on a run that was never going to be
  // judged, `why` has already said so in a sentence.
  const order = new Map(workflowSteps.map((s, i) => [s.name, i]))
  const didNotRun = [
    ...(outcomes?.skipped ?? []).map(s => ({ step: s.step, note: `skipped — ${s.reason}` })),
    ...(expected ? [] : verdictSteps
      .filter(v => v.disposition === 'not_dispatched')
      .map(v => ({ step: v.step, note: 'not dispatched' }))),
  ].sort((a, b) => (order.get(a.step) ?? Infinity) - (order.get(b.step) ?? Infinity))

  return { expected, cause, verdictSteps, ran, didNotRun, why, next, notes }
}

function pad(entries: { step: string }[]): number {
  return entries.reduce((w, e) => Math.max(w, e.step.length), 0)
}

/** Renders the report as plain lines, unindented and uncoloured. The caller
 *  owns presentation; this owns what is said and in what order. */
export function renderNoVerdictReport(report: NoVerdictReport): string[] {
  const lines: string[] = ['no verdict this run']
  const width = Math.max(pad(report.ran), pad(report.didNotRun))

  if (report.ran.length > 0) {
    lines.push('', 'ran')
    for (const { step, detail } of report.ran) {
      lines.push(detail ? `  ${step.padEnd(width)}  ${detail}` : `  ${step}`)
    }
  }
  if (report.didNotRun.length > 0) {
    lines.push('', 'did not run')
    for (const { step, note } of report.didNotRun) {
      lines.push(`  ${step.padEnd(width)}  ${note}`)
    }
  }
  if (report.why.length > 0) {
    lines.push('', 'why')
    for (const line of report.why) lines.push(`  ${line}`)
  }
  if (report.next.length > 0) {
    lines.push('', 'next')
    for (const { text, recommended } of report.next) {
      lines.push(recommended ? `→ ${text}` : `  ${text}`)
    }
  }
  if (report.notes.length > 0) {
    lines.push('')
    for (const note of report.notes) lines.push(`  ${note}`)
  }
  return lines
}
