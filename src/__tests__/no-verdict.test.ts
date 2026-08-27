import { describe, it, expect } from 'vitest'
import {
  describeVerdictSteps,
  buildNoVerdictReport,
  renderNoVerdictReport,
  selectStandingVerdict,
  type NoVerdictInput,
} from '../lib/no-verdict.js'
import type { StepOutcomes } from '../lib/runner.js'

const STANDARD_WORKFLOW = [
  { name: 'conflict-resolve', type: 'conflict-resolve' as const },
  { name: 'review', type: 'review' as const },
  { name: 'fix', type: 'fix' as const },
  { name: 'recheck', type: 'recheck' as const },
]

function input(overrides: Partial<NoVerdictInput> = {}): NoVerdictInput {
  return {
    workflowSteps: STANDARD_WORKFLOW,
    prUrl: 'https://github.com/o/r/pull/7',
    ...overrides,
  }
}

describe('describeVerdictSteps', () => {
  it('reports not_configured when the workflow has no verdict step', () => {
    const steps = [{ name: 'conflict-resolve', type: 'conflict-resolve' as const }]
    expect(describeVerdictSteps(steps, { ran: [], skipped: [] })).toEqual([
      { step: 'review', disposition: 'not_configured' },
    ])
  })

  it('reports not_dispatched for a configured step that never ran', () => {
    const out = describeVerdictSteps(STANDARD_WORKFLOW, { ran: ['fix'], skipped: [] })
    expect(out).toEqual([
      { step: 'review', disposition: 'not_dispatched' },
      { step: 'recheck', disposition: 'not_dispatched' },
    ])
  })

  it('reports skipped with the recorded reason', () => {
    const out = describeVerdictSteps(STANDARD_WORKFLOW, {
      ran: ['fix'],
      skipped: [{ step: 'recheck', reason: 'when_condition' }],
    })
    expect(out).toContainEqual({ step: 'recheck', disposition: 'skipped', reason: 'when_condition' })
  })

  // The case the step names alone cannot express: review ran, cost full tokens,
  // posted a comment, and its output carried no parseable VERDICT: line.
  it('separates a step that ran without a verdict from one that ran with one', () => {
    const out = describeVerdictSteps(STANDARD_WORKFLOW, {
      ran: ['review', 'recheck'],
      skipped: [],
      ranDetail: { review: { verdict: null }, recheck: { verdict: 'APPROVE' } },
    })
    expect(out).toEqual([
      { step: 'review', disposition: 'ran_no_verdict' },
      { step: 'recheck', disposition: 'ran' },
    ])
  })

  it('treats a ran step with no recorded detail as ran', () => {
    const out = describeVerdictSteps(STANDARD_WORKFLOW, { ran: ['review'], skipped: [] })
    expect(out[0]).toEqual({ step: 'review', disposition: 'ran' })
  })

  it('keeps workflow order', () => {
    const steps = [
      { name: 'recheck', type: 'recheck' as const },
      { name: 'review', type: 'review' as const },
    ]
    expect(describeVerdictSteps(steps, { ran: [], skipped: [] }).map(s => s.step))
      .toEqual(['recheck', 'review'])
  })
})

// Every case below ends with verdict === null. The report is the only thing that
// tells them apart, so each asserts its own cause, its own advice, and — for the
// three that are working as intended — that it is NOT flagged as a problem.
describe('buildNoVerdictReport — causes', () => {
  // PR #2548: resumed at fix against an August review, fix applied nothing,
  // recheck skipped on `fix.applied_count > 0`. Ran 104s, judged nothing,
  // printed `verdict —` under a green checkmark.
  const stuckAtFix: StepOutcomes = {
    ran: ['fix'],
    skipped: [{ step: 'recheck', reason: 'when_condition' }],
    ranDetail: { fix: { vendor: 'claude', tokensUsed: 3483, appliedCount: 0 } },
  }

  it('flags a run where the fix no-oped and recheck was gated out', () => {
    const report = buildNoVerdictReport(input({ outcomes: stuckAtFix }))
    expect(report.expected).toBe(false)
    expect(report.cause).toBe('skipped')
    expect(report.next[0]).toEqual({
      text: 'ck run https://github.com/o/r/pull/7 --steps recheck',
      recommended: true,
    })
  })

  it('names the standing verdict and that it does not cover HEAD', () => {
    const report = buildNoVerdictReport(input({
      outcomes: stuckAtFix,
      standingVerdict: { verdict: 'BLOCK', sha: 'df95a6b1111111111111111111111111111111a' },
      headSha: '57ef3ef2d46d35af5b0361b362c8069394d7133c',
    }))
    expect(report.why.join('\n')).toContain('BLOCK')
    expect(report.why.join('\n')).toContain('df95a6b')
    expect(report.why.join('\n')).toContain('57ef3ef')
  })

  // The advice that moves the PR toward APPROVE: nothing was applied because
  // there was probably nothing left to apply.
  it('does not call the standing verdict stale when its SHA is HEAD', () => {
    const report = buildNoVerdictReport(input({
      outcomes: stuckAtFix,
      // The short form annotations carry — shaCovers matches it against the full one.
      standingVerdict: { verdict: 'NEEDS_WORK', sha: '57ef3ef' },
      headSha: '57ef3ef2d46d35af5b0361b362c8069394d7133c',
    }))
    expect(report.why.join('\n')).toContain('still NEEDS_WORK')
    expect(report.why.join('\n')).not.toContain('not HEAD')
  })

  it('makes no staleness claim when the standing verdict records no SHA', () => {
    const report = buildNoVerdictReport(input({
      outcomes: stuckAtFix,
      standingVerdict: { verdict: 'BLOCK' },
      headSha: '57ef3ef2d46d35af5b0361b362c8069394d7133c',
    }))
    expect(report.why.join('\n')).toContain('still BLOCK')
    expect(report.why.join('\n')).not.toContain('not HEAD')
  })

  it('points out that the fix applied nothing', () => {
    const report = buildNoVerdictReport(input({ outcomes: stuckAtFix }))
    expect(report.why.join('\n')).toMatch(/applied no changes/)
  })

  // conflict-resolve records `applied_count: 0` exactly like a fix does, and a
  // branch with no conflicts to resolve says nothing about the review's findings.
  it('does not read a conflict-resolve no-op as a fix that found nothing', () => {
    const report = buildNoVerdictReport(input({
      outcomes: {
        ran: ['conflict-resolve'],
        skipped: [{ step: 'recheck', reason: 'when_condition' }],
        ranDetail: { 'conflict-resolve': { appliedCount: 0 } },
      },
    }))
    expect(report.why.join('\n')).not.toMatch(/applied no changes/)
  })

  it('names the fix step that applied nothing, whatever it is called', () => {
    const report = buildNoVerdictReport(input({
      workflowSteps: [
        { name: 'review', type: 'review' },
        { name: 'address', type: 'fix' },
        { name: 'recheck', type: 'recheck' },
      ],
      outcomes: {
        ran: ['address'],
        skipped: [{ step: 'recheck', reason: 'when_condition' }],
        ranDetail: { address: { appliedCount: 0 } },
      },
    }))
    expect(report.why.join('\n')).toContain('The address step applied no changes')
  })

  it('omits the no-op note when the fix did apply changes', () => {
    const report = buildNoVerdictReport(input({
      outcomes: {
        ran: ['fix'],
        skipped: [{ step: 'recheck', reason: 'when_condition' }],
        ranDetail: { fix: { appliedCount: 2 } },
      },
    }))
    expect(report.why.join('\n')).not.toMatch(/applied no changes/)
  })

  // The #284 case — every dispatched step skipped. Previously the only covered
  // one; it now flows through the same report rather than its own branch.
  it('flags a run where every step skipped for want of a vendor', () => {
    const report = buildNoVerdictReport(input({
      outcomes: {
        ran: [],
        skipped: [
          { step: 'conflict-resolve', reason: 'no_vendor' },
          { step: 'review', reason: 'no_vendor' },
        ],
      },
    }))
    expect(report.expected).toBe(false)
    expect(report.cause).toBe('skipped')
    expect(report.next.some(n => n.text.includes('fallback_reviewer'))).toBe(true)
    expect(report.ran).toEqual([])
  })

  // A full-price review whose result evaporated. Indistinguishable from the
  // no-op run above before this change: both printed `verdict —`.
  it('flags a review that ran but emitted no parseable verdict', () => {
    const report = buildNoVerdictReport(input({
      outcomes: {
        ran: ['review'],
        skipped: [],
        ranDetail: { review: { vendor: 'codex', tokensUsed: 41200, verdict: null } },
      },
    }))
    expect(report.expected).toBe(false)
    expect(report.cause).toBe('ran_no_verdict')
    expect(report.why.join('\n')).toContain('VERDICT:')
    expect(report.next).toEqual([
      { text: 'ck run https://github.com/o/r/pull/7 --steps review', recommended: true },
    ])
  })

  // Re-run the step that misbehaved. A second command here reads as a choice
  // when there isn't one.
  it('offers no alternative step for malformed output', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: ['review'], skipped: [], ranDetail: { review: { verdict: null } } },
    }))
    expect(report.next).toHaveLength(1)
  })

  it('reports a guard that stopped the run on purpose, without a re-run command', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: ['fix'], skipped: [{ step: 'recheck', reason: 'max_rounds' }] },
    }))
    expect(report.expected).toBe(false)
    expect(report.next).toEqual([])
    expect(report.notes.join('\n')).toMatch(/on purpose|human/i)
  })
})

describe('buildNoVerdictReport — runs that are meant to have no verdict', () => {
  it('does not flag a strategy class skip', () => {
    const report = buildNoVerdictReport(input({ strategySkipped: 'lockfile', outcomes: { ran: [], skipped: [] } }))
    expect(report.expected).toBe(true)
    expect(report.cause).toBe('strategy_skip')
    expect(report.why.join('\n')).toContain('lockfile')
    expect(report.next).toEqual([])
  })

  it('does not flag a workflow with no verdict step configured', () => {
    const report = buildNoVerdictReport(input({
      workflowSteps: [{ name: 'conflict-resolve', type: 'conflict-resolve' }],
      outcomes: { ran: ['conflict-resolve'], skipped: [] },
    }))
    expect(report.expected).toBe(true)
    expect(report.cause).toBe('not_configured')
    expect(report.next).toEqual([])
  })

  // `--steps fix` and kickass's one-step dispatch ask for exactly one step.
  // Reporting "no verdict" as a problem there would flag every kickass run.
  it('does not flag a deliberately scoped single-step dispatch', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: ['fix'], skipped: [] },
      stepsExplicitlyScoped: true,
    }))
    expect(report.expected).toBe(true)
    expect(report.cause).toBe('not_dispatched')
    expect(report.next).toEqual([])
  })

  // Scoping is not a blanket excuse: `--steps fix,recheck` dispatched recheck,
  // and recheck skipping is a real outcome the user did not ask for.
  it('still flags a skipped verdict step inside a scoped run', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: ['fix'], skipped: [{ step: 'recheck', reason: 'when_condition' }] },
      stepsExplicitlyScoped: true,
    }))
    expect(report.expected).toBe(false)
    expect(report.cause).toBe('skipped')
  })

  it('flags an unscoped run whose verdict steps were never dispatched', () => {
    const report = buildNoVerdictReport(input({ outcomes: { ran: ['fix'], skipped: [] } }))
    expect(report.expected).toBe(false)
    expect(report.cause).toBe('not_dispatched')
    expect(report.next[0]?.recommended).toBe(true)
  })
})

describe('buildNoVerdictReport — sections', () => {
  it('lists what ran with vendor, tokens and applied count', () => {
    const report = buildNoVerdictReport(input({
      outcomes: {
        ran: ['fix'],
        skipped: [{ step: 'recheck', reason: 'when_condition' }],
        ranDetail: { fix: { vendor: 'claude', tokensUsed: 3483, appliedCount: 0 } },
      },
    }))
    expect(report.ran).toEqual([{ step: 'fix', detail: 'claude · 3.5K tokens · no changes applied' }])
  })

  it('lists a ran step with no detail as a bare name', () => {
    const report = buildNoVerdictReport(input({ outcomes: { ran: ['fix'], skipped: [] } }))
    expect(report.ran).toEqual([{ step: 'fix', detail: '' }])
  })

  it('lists skipped steps and undispatched verdict steps together, in workflow order', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: ['fix'], skipped: [{ step: 'recheck', reason: 'when_condition' }] },
    }))
    expect(report.didNotRun).toEqual([
      { step: 'review', note: 'not dispatched' },
      { step: 'recheck', note: 'skipped — when_condition' },
    ])
  })

  it('does not list a non-verdict step that was never dispatched', () => {
    // conflict-resolve is in the workflow but was not dispatched and is not a
    // verdict step — it explains nothing about the missing verdict.
    const report = buildNoVerdictReport(input({ outcomes: { ran: ['fix'], skipped: [] } }))
    expect(report.didNotRun.map(d => d.step)).not.toContain('conflict-resolve')
  })

  it('lists a skipped non-verdict step, which does bear on the outcome', () => {
    const report = buildNoVerdictReport(input({
      outcomes: { ran: [], skipped: [{ step: 'conflict-resolve', reason: 'no_vendor' }] },
    }))
    expect(report.didNotRun).toContainEqual({ step: 'conflict-resolve', note: 'skipped — no_vendor' })
  })
})

describe('renderNoVerdictReport', () => {
  const report = buildNoVerdictReport(input({
    outcomes: {
      ran: ['fix'],
      skipped: [{ step: 'recheck', reason: 'when_condition' }],
      ranDetail: { fix: { vendor: 'claude', tokensUsed: 3483, appliedCount: 0 } },
    },
    standingVerdict: { verdict: 'BLOCK', sha: 'df95a6b1111111111111111111111111111111a' },
    headSha: '57ef3ef2d46d35af5b0361b362c8069394d7133c',
  }))

  it('opens with the headline and renders every section', () => {
    const lines = renderNoVerdictReport(report)
    expect(lines[0]).toBe('no verdict this run')
    expect(lines).toContain('ran')
    expect(lines).toContain('did not run')
    expect(lines).toContain('why')
    expect(lines).toContain('next')
  })

  it('marks the recommended action and indents the rest', () => {
    const lines = renderNoVerdictReport(report)
    const next = lines.slice(lines.indexOf('next') + 1)
    expect(next[0]).toBe('→ ck run https://github.com/o/r/pull/7 --steps recheck')
    expect(next[1]?.startsWith('  ck run')).toBe(true)
  })

  it('omits sections with nothing in them', () => {
    const empty = buildNoVerdictReport(input({
      strategySkipped: 'lockfile',
      outcomes: { ran: [], skipped: [] },
    }))
    const lines = renderNoVerdictReport(empty)
    expect(lines).not.toContain('ran')
    expect(lines).not.toContain('did not run')
    expect(lines).not.toContain('next')
    expect(lines).toContain('why')
  })

  it('never renders a trailing blank line', () => {
    expect(renderNoVerdictReport(report).at(-1)).not.toBe('')
  })
})

// A review that ran and emitted no parseable VERDICT: line records no verdict.
// It judged nothing, so it clears nothing — the earlier BLOCK is still what
// gates the PR, and the report has to keep saying so.
describe('selectStandingVerdict', () => {
  const BLOCK_SHA = 'df95a6b1111111111111111111111111111111a'

  it('takes the newest review or recheck that carries a verdict', () => {
    expect(selectStandingVerdict([
      { type: 'review', verdict: 'BLOCK', sha: BLOCK_SHA },
      { type: 'recheck', verdict: 'NEEDS_WORK', sha: '57ef3ef' },
    ])).toEqual({ verdict: 'NEEDS_WORK', sha: '57ef3ef' })
  })

  it('keeps the standing verdict when a later review recorded none', () => {
    expect(selectStandingVerdict([
      { type: 'review', verdict: 'BLOCK', sha: BLOCK_SHA },
      { type: 'review' },
    ])).toEqual({ verdict: 'BLOCK', sha: BLOCK_SHA })
  })

  it('ignores records that never produce verdicts', () => {
    expect(selectStandingVerdict([
      { type: 'review', verdict: 'BLOCK', sha: BLOCK_SHA },
      { type: 'fix' },
      { type: 'conflict-resolve' },
    ])).toEqual({ verdict: 'BLOCK', sha: BLOCK_SHA })
  })

  it('omits the sha when the record carries none', () => {
    expect(selectStandingVerdict([{ type: 'review', verdict: 'BLOCK' }])).toEqual({ verdict: 'BLOCK' })
  })

  it('returns nothing when no record carries a verdict', () => {
    expect(selectStandingVerdict([{ type: 'review' }, { type: 'fix' }])).toBeUndefined()
  })
})
