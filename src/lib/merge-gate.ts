import type { Verdict } from './verdict.js'
import { shaCovers } from './pr-workflow-state.js'
import { hasBlockingFindings } from './verdict.js'

// `crosscheck merge` is the one command that acts on a verdict instead of
// producing one, so the decision of whether it may act is kept here: pure, with
// every input passed in, so the rules are readable and testable without a network
// call. The command does the I/O; this decides.
//
// Until this existed crosscheck had no merge path at all, deliberately (see
// docs/trust.md). The gate is what makes adding one defensible: the default
// refuses anything a reviewer has not approved on the exact commit being merged.

export type Strictness = 'loose' | 'default' | 'tight' | 'force'

export interface MergeGateInput {
  /** Verdict standing on the PR — the newest review or recheck carrying one. */
  verdict?: Verdict | string
  /** Commit that verdict was written against, from its `sha=` annotation. */
  verdictSha?: string
  /** The PR head being merged. */
  headSha: string
  /** GitHub's own answer. null means it has not finished computing. */
  mergeable: boolean | null
  /** GitHub's mergeable_state, e.g. 'clean' | 'blocked' | 'dirty' | 'behind'. */
  mergeStateStatus?: string
  /** Required checks that are failing. Only consulted at `tight`. */
  failingChecks?: string[]
  /** Required checks still running. Only consulted at `tight`. */
  pendingChecks?: string[]
  /** Whether the standing review still carries an unresolved blocking finding. */
  hasBlockingFindings?: boolean
  strictness: Strictness
}

export interface MergeGateResult {
  allowed: boolean
  /** Why it was refused, or — when forced — what was overridden. Never empty on refusal. */
  reasons: string[]
  /** Checks that passed, for the confirmation line. */
  satisfied: string[]
}

function verdictCoversHead(input: MergeGateInput): boolean {
  return input.verdictSha !== undefined && shaCovers(input.verdictSha, input.headSha)
}

/**
 * A conflicted PR is refused at every strictness including `force`.
 *
 * `force` overrides crosscheck's *opinion*; it does not override git. GitHub
 * would reject the merge anyway, so attempting it just turns a clear local
 * refusal into an opaque API error — and a flag that appears to promise "merge
 * regardless" should fail honestly rather than look broken.
 */
function gitRefusal(input: MergeGateInput): string | null {
  if (input.mergeable === false) {
    const state = input.mergeStateStatus ? ` (mergeable_state: ${input.mergeStateStatus})` : ''
    return `GitHub reports this PR cannot be merged${state} — resolve conflicts first. Not overridable by --force.`
  }
  if (input.mergeable === null) {
    return 'GitHub has not finished computing mergeability — retry in a moment.'
  }
  if (input.mergeStateStatus === 'dirty') {
    return 'The PR has merge conflicts — resolve them first. Not overridable by --force.'
  }
  return null
}

/**
 * Whether the verdict that stands still carries an unresolved blocking finding.
 *
 * Read from the comment that *carries the standing verdict*, not from the latest
 * review comment. Those differ after a fix: on crosscheck#319 the review BLOCKed
 * with real critical findings, the fix step resolved them, and the recheck
 * approved — so reading the review body reported a blocker that no longer existed,
 * and `--tight` refused a PR whose findings were fixed. Any PR that had ever been
 * blocked would have been permanently un-tight-mergeable.
 *
 * Two verdicts are treated as having no unresolved blockers regardless of their
 * body text, because in both cases something has already adjudicated them:
 *
 *  - an APPROVE from a recheck, which is the judge saying the findings it raised
 *    are addressed;
 *  - an APPROVE produced by the documentation-only cap, which is a deliberate
 *    policy decision that prose findings do not block. Re-blocking here would
 *    undo it at merge time and make "never block a doc-only PR" false.
 */
export function standingHasBlockingFindings(records: readonly { type: string; verdict?: string; commentBody: string }[]): boolean {
  const judged = records.filter(r => (r.type === 'review' || r.type === 'recheck') && r.verdict).at(-1)
  if (!judged) return false
  if (judged.verdict === 'APPROVE') return false
  return hasBlockingFindings(judged.commentBody)
}

export function evaluateMergeGate(input: MergeGateInput): MergeGateResult {
  const reasons: string[] = []
  const satisfied: string[] = []

  const git = gitRefusal(input)
  if (git) return { allowed: false, reasons: [git], satisfied }
  satisfied.push('GitHub reports the PR mergeable')

  if (input.strictness === 'force') {
    // Recorded rather than silent: the confirmation line and the log both say what
    // was skipped, so a forced merge is never indistinguishable from a gated one.
    return {
      allowed: true,
      reasons: [`--force: merged without a verdict gate (standing verdict: ${input.verdict ?? 'none'})`],
      satisfied,
    }
  }

  if (!input.verdict) {
    reasons.push('No review verdict stands on this PR — run `crosscheck run <pr>` first.')
    return { allowed: false, reasons, satisfied }
  }

  if (input.strictness === 'loose') {
    // Loose still requires the verdict to describe the code being merged. A stale
    // APPROVE from three pushes ago is not a weaker signal, it is a different
    // commit's signal, so coverage is not what `--loose` relaxes.
    if (!verdictCoversHead(input)) {
      reasons.push(`The standing ${input.verdict} was written against ${input.verdictSha ?? 'an unknown commit'}, not HEAD (${input.headSha.slice(0, 9)}) — re-review before merging.`)
      return { allowed: false, reasons, satisfied }
    }
    if (input.verdict === 'BLOCK') {
      reasons.push('The standing verdict is BLOCK. --loose accepts NEEDS WORK but not a block; use --force to override deliberately.')
      return { allowed: false, reasons, satisfied }
    }
    satisfied.push(`standing verdict is ${input.verdict}, covering HEAD`)
    return { allowed: true, reasons, satisfied }
  }

  // default and tight both require an APPROVE on the exact commit being merged.
  if (input.verdict !== 'APPROVE') {
    reasons.push(`The standing verdict is ${input.verdict}, not APPROVE. Use --loose to merge a non-blocking verdict, or --force to override.`)
  } else if (!verdictCoversHead(input)) {
    reasons.push(`The APPROVE was written against ${input.verdictSha ?? 'an unknown commit'}, not HEAD (${input.headSha.slice(0, 9)}) — push moved the code the approval covered.`)
  } else {
    satisfied.push(`APPROVE covers HEAD (${input.headSha.slice(0, 9)})`)
  }

  if (input.strictness === 'tight') {
    const failing = input.failingChecks ?? []
    const pending = input.pendingChecks ?? []
    if (failing.length > 0) reasons.push(`--tight: ${failing.length} check${failing.length === 1 ? '' : 's'} failing (${failing.slice(0, 4).join(', ')}${failing.length > 4 ? ', …' : ''}).`)
    if (pending.length > 0) reasons.push(`--tight: ${pending.length} check${pending.length === 1 ? '' : 's'} still running (${pending.slice(0, 4).join(', ')}${pending.length > 4 ? ', …' : ''}).`)
    if (input.hasBlockingFindings) reasons.push('--tight: the standing review still carries an unresolved blocking finding.')
    if (failing.length === 0 && pending.length === 0) satisfied.push('all checks green')
    if (!input.hasBlockingFindings) satisfied.push('no unresolved blocking findings')
  }

  return { allowed: reasons.length === 0, reasons, satisfied }
}

/** How the chosen strictness reads in the confirmation line. */
export function describeStrictness(strictness: Strictness): string {
  switch (strictness) {
    case 'force': return 'force (no verdict gate)'
    case 'loose': return 'loose (verdict must not be BLOCK)'
    case 'tight': return 'tight (APPROVE on HEAD, checks green, no open findings)'
    default: return 'default (APPROVE on HEAD)'
  }
}

/**
 * Resolves the mutually exclusive strictness flags.
 *
 * Rejecting combinations rather than picking a winner: `--loose --tight` has no
 * defensible reading, and silently honouring one of them on a command that
 * merges code is how somebody gets a merge they did not ask for.
 */
export function resolveStrictness(flags: { loose?: boolean; tight?: boolean; force?: boolean }): Strictness | { error: string } {
  const chosen = (['loose', 'tight', 'force'] as const).filter(f => flags[f])
  if (chosen.length > 1) {
    return { error: `--${chosen.join(' and --')} cannot be combined — they ask for different gates.` }
  }
  return chosen[0] ?? 'default'
}
