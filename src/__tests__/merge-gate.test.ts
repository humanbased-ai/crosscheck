import { describe, it, expect } from 'vitest'
import { evaluateMergeGate, resolveStrictness, describeStrictness, standingHasBlockingFindings, type MergeGateInput } from '../lib/merge-gate.js'

const HEAD = 'abc1234def5678901234567890abcdef12345678'

function input(overrides: Partial<MergeGateInput> = {}): MergeGateInput {
  return {
    headSha: HEAD,
    mergeable: true,
    mergeStateStatus: 'clean',
    strictness: 'default',
    ...overrides,
  }
}

describe('git refuses before crosscheck opines', () => {
  it('refuses a conflicted PR even with --force', () => {
    // --force overrides crosscheck's opinion, not git's. GitHub would reject the
    // merge anyway, so attempting it turns a clear refusal into an opaque API error.
    const gate = evaluateMergeGate(input({ mergeable: false, mergeStateStatus: 'dirty', strictness: 'force' }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons[0]).toMatch(/cannot be merged/)
    expect(gate.reasons[0]).toMatch(/Not overridable by --force/)
  })

  it('refuses a dirty mergeable_state even when mergeable is true', () => {
    const gate = evaluateMergeGate(input({ mergeable: true, mergeStateStatus: 'dirty', strictness: 'force' }))
    expect(gate.allowed).toBe(false)
  })

  it('refuses while GitHub is still computing mergeability', () => {
    // null is "unknown", and treating unknown as mergeable is how a conflicted PR
    // gets attempted.
    const gate = evaluateMergeGate(input({ mergeable: null }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons[0]).toMatch(/not finished computing/)
  })
})

describe('default — APPROVE covering HEAD', () => {
  it('allows an APPROVE on HEAD', () => {
    const gate = evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: HEAD }))
    expect(gate.allowed).toBe(true)
    expect(gate.satisfied).toContain(`APPROVE covers HEAD (${HEAD.slice(0, 9)})`)
  })

  it('accepts a short-form sha as the same commit', () => {
    // Annotations carry either form; shaCovers is the codebase's one definition.
    const gate = evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: HEAD.slice(0, 9) }))
    expect(gate.allowed).toBe(true)
  })

  it('refuses an APPROVE written against an older commit', () => {
    const gate = evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: 'f'.repeat(40) }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/not HEAD/)
  })

  it('refuses an APPROVE with no sha at all', () => {
    // A verdict that proves nothing about which commit it judged cannot clear a merge.
    const gate = evaluateMergeGate(input({ verdict: 'APPROVE' }))
    expect(gate.allowed).toBe(false)
  })

  it('refuses NEEDS WORK and points at --loose', () => {
    const gate = evaluateMergeGate(input({ verdict: 'NEEDS WORK', verdictSha: HEAD }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/--loose/)
  })

  it('refuses when no verdict stands', () => {
    const gate = evaluateMergeGate(input())
    expect(gate.allowed).toBe(false)
    expect(gate.reasons[0]).toMatch(/No review verdict stands/)
  })
})

describe('--loose — anything but BLOCK', () => {
  it('allows NEEDS WORK on HEAD', () => {
    const gate = evaluateMergeGate(input({ verdict: 'NEEDS WORK', verdictSha: HEAD, strictness: 'loose' }))
    expect(gate.allowed).toBe(true)
  })

  it('allows APPROVE on HEAD', () => {
    expect(evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: HEAD, strictness: 'loose' })).allowed).toBe(true)
  })

  it('refuses BLOCK', () => {
    const gate = evaluateMergeGate(input({ verdict: 'BLOCK', verdictSha: HEAD, strictness: 'loose' }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/--force/)
  })

  it('still requires the verdict to cover HEAD', () => {
    // Coverage is not what --loose relaxes: a stale APPROVE is not a weaker
    // signal, it is a different commit's signal.
    const gate = evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: 'f'.repeat(40), strictness: 'loose' }))
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/not HEAD/)
  })
})

describe('--tight — APPROVE plus a green tree', () => {
  const tight = (o: Partial<MergeGateInput> = {}) =>
    evaluateMergeGate(input({ verdict: 'APPROVE', verdictSha: HEAD, strictness: 'tight', ...o }))

  it('allows an APPROVE with everything green', () => {
    const gate = tight({ failingChecks: [], pendingChecks: [], hasBlockingFindings: false })
    expect(gate.allowed).toBe(true)
    expect(gate.satisfied).toContain('all checks green')
  })

  it('refuses a failing check', () => {
    const gate = tight({ failingChecks: ['build (18)'] })
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/1 check failing/)
  })

  it('refuses while a check is still running', () => {
    const gate = tight({ pendingChecks: ['e2e'] })
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/still running/)
  })

  it('refuses an unresolved blocking finding even with green checks', () => {
    const gate = tight({ hasBlockingFindings: true })
    expect(gate.allowed).toBe(false)
    expect(gate.reasons.join(' ')).toMatch(/blocking finding/)
  })

  it('truncates a long check list rather than printing all of it', () => {
    const gate = tight({ failingChecks: ['a', 'b', 'c', 'd', 'e', 'f'] })
    expect(gate.reasons.join(' ')).toMatch(/6 checks failing/)
    expect(gate.reasons.join(' ')).toMatch(/…/)
  })

  it('reports every unmet condition at once, not just the first', () => {
    // A caller fixing one thing at a time should not need three runs to find out
    // there were three problems.
    const gate = tight({ verdict: 'NEEDS WORK', failingChecks: ['build'], hasBlockingFindings: true })
    expect(gate.reasons.length).toBeGreaterThanOrEqual(3)
  })
})

describe('--force', () => {
  it('merges a BLOCK', () => {
    const gate = evaluateMergeGate(input({ verdict: 'BLOCK', verdictSha: HEAD, strictness: 'force' }))
    expect(gate.allowed).toBe(true)
  })

  it('merges with no verdict at all', () => {
    expect(evaluateMergeGate(input({ strictness: 'force' })).allowed).toBe(true)
  })

  it('records what it overrode, so a forced merge is never silent', () => {
    const gate = evaluateMergeGate(input({ verdict: 'BLOCK', verdictSha: HEAD, strictness: 'force' }))
    expect(gate.reasons.join(' ')).toMatch(/--force/)
    expect(gate.reasons.join(' ')).toMatch(/BLOCK/)
  })
})

describe('resolveStrictness', () => {
  it('defaults to default', () => {
    expect(resolveStrictness({})).toBe('default')
  })

  it.each(['loose', 'tight', 'force'] as const)('honours --%s', flag => {
    expect(resolveStrictness({ [flag]: true })).toBe(flag)
  })

  it('rejects combinations rather than picking a winner', () => {
    // Silently honouring one of --loose --tight on a command that merges code is
    // how somebody gets a merge they did not ask for.
    const result = resolveStrictness({ loose: true, tight: true })
    expect(result).toEqual({ error: expect.stringContaining('cannot be combined') })
  })

  it('rejects all three together', () => {
    expect(resolveStrictness({ loose: true, tight: true, force: true })).toHaveProperty('error')
  })
})

describe('describeStrictness', () => {
  it('names the gate for the confirmation line', () => {
    expect(describeStrictness('default')).toMatch(/APPROVE on HEAD/)
    expect(describeStrictness('loose')).toMatch(/not be BLOCK/)
    expect(describeStrictness('tight')).toMatch(/checks green/)
    expect(describeStrictness('force')).toMatch(/no verdict gate/)
  })
})

describe('standingHasBlockingFindings', () => {
  const BLOCKING = '## Critical Issues\n\n- [P1] Authorization bypass in listAccountTransactions.\n'
  const CLEAN = '## Critical Issues\n\nNone.\n'

  it('reads the standing verdict, not the latest review', () => {
    // The bug this exists for, from crosscheck#319: the review BLOCKed with real
    // findings, the fix step resolved them, and the recheck approved. Reading the
    // review body reported a blocker that no longer existed, so --tight refused a
    // PR whose findings were fixed — and any PR ever blocked would have stayed
    // permanently un-tight-mergeable.
    const records = [
      { type: 'review', verdict: 'BLOCK', commentBody: BLOCKING },
      { type: 'fix', commentBody: 'Auto-fix applied' },
      { type: 'recheck', verdict: 'APPROVE', commentBody: 'The original issues are resolved.' },
    ]
    expect(standingHasBlockingFindings(records)).toBe(false)
  })

  it('reports a blocker when the standing verdict is the blocking one', () => {
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'BLOCK', commentBody: BLOCKING },
    ])).toBe(true)
  })

  it('treats an APPROVE as adjudicated whatever its body says', () => {
    // A documentation-only cap turns BLOCK into APPROVE *with* the findings still
    // in the body. Re-blocking here would undo a deliberate policy decision at
    // merge time and make "never block a doc-only PR" false.
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'APPROVE', commentBody: BLOCKING },
    ])).toBe(false)
  })

  it('reports a blocker for a standing NEEDS WORK that carries one', () => {
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'NEEDS WORK', commentBody: BLOCKING },
    ])).toBe(true)
  })

  it('is false for a standing NEEDS WORK with only nits', () => {
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'NEEDS WORK', commentBody: '- [P3] Rename `x`.' },
    ])).toBe(false)
  })

  it('ignores fix records, which carry no verdict', () => {
    // A fix comment quoting the finding it addressed must not be mistaken for the
    // finding still standing.
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'APPROVE', commentBody: CLEAN },
      { type: 'fix', commentBody: BLOCKING },
    ])).toBe(false)
  })

  it('is false when no verdict-bearing record exists', () => {
    expect(standingHasBlockingFindings([])).toBe(false)
    expect(standingHasBlockingFindings([{ type: 'fix', commentBody: BLOCKING }])).toBe(false)
  })

  it('ignores a review that recorded no verdict at all', () => {
    // A review can run, post findings, and parse no VERDICT: line. It judged
    // nothing, so it cannot be the verdict that stands.
    expect(standingHasBlockingFindings([
      { type: 'review', verdict: 'BLOCK', commentBody: BLOCKING },
      { type: 'review', commentBody: 'malformed output' },
    ])).toBe(true)
  })
})
