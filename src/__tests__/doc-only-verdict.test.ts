import { describe, it, expect } from 'vitest'
import { applySeverityGate, DOC_ONLY_GATE_NOTE, SEVERITY_GATE_NOTE } from '../lib/verdict.js'
import { isDocOnlyChange } from '../lib/review-strategy.js'

// A doc-only PR is never blocked. A finding about a sentence cannot break a build
// or a caller, and the `docs` class runs `review` with no fix or recheck step — so
// a BLOCK there had no path to ever clear, it just sat on the PR.

const BLOCKING_REVIEW = '## Critical Issues\n\n- [P1] The install command is wrong.\n'

describe('isDocOnlyChange', () => {
  it.each([
    [['README.md'], true],
    [['docs/trust.md', 'docs/metrics.md'], true],
    [['guide.mdx', 'notes.rst', 'manual.adoc'], true],
    [['README.md', 'src/index.ts'], false],
    [['src/index.ts'], false],
    // An empty list is "unknown", not "doc-only": an unreadable diff must not
    // suppress a verdict.
    [[], false],
  ])('%j → %s', (files, expected) => {
    expect(isDocOnlyChange(files)).toBe(expected)
  })

  it('is not fooled by a doc extension inside a source path', () => {
    expect(isDocOnlyChange(['src/md/parser.ts'])).toBe(false)
  })

  it('requires every file to be prose, not merely most of them', () => {
    // Stricter than the `docs` PR class, which matches on a *fraction* of doc
    // churn. One source file in the diff means a finding could describe shipping
    // code, so the verdict must stay free to block.
    expect(isDocOnlyChange(['a.md', 'b.md', 'c.md', 'd.md', 'src/one.ts'])).toBe(false)
  })
})

describe('a doc-only PR is never blocked', () => {
  it('turns BLOCK into APPROVE', () => {
    const gate = applySeverityGate('BLOCK', BLOCKING_REVIEW, { docOnly: true })
    expect(gate).toEqual({ verdict: 'APPROVE', downgraded: true, reason: 'doc_only' })
  })

  it('turns NEEDS WORK into APPROVE even with a blocking finding', () => {
    const gate = applySeverityGate('NEEDS WORK', BLOCKING_REVIEW, { docOnly: true })
    expect(gate.verdict).toBe('APPROVE')
    expect(gate.reason).toBe('doc_only')
  })

  it('leaves an APPROVE alone', () => {
    expect(applySeverityGate('APPROVE', BLOCKING_REVIEW, { docOnly: true }))
      .toEqual({ verdict: 'APPROVE', downgraded: false })
  })

  it('leaves a null verdict alone — nothing to cap', () => {
    expect(applySeverityGate(null, BLOCKING_REVIEW, { docOnly: true }))
      .toEqual({ verdict: null, downgraded: false })
  })
})

describe('the cap applies only to doc-only PRs', () => {
  it('a BLOCK on code still blocks', () => {
    const gate = applySeverityGate('BLOCK', BLOCKING_REVIEW, { docOnly: false })
    expect(gate).toEqual({ verdict: 'BLOCK', downgraded: false })
  })

  it('a BLOCK on code still blocks when docOnly is unset', () => {
    expect(applySeverityGate('BLOCK', BLOCKING_REVIEW).verdict).toBe('BLOCK')
  })

  it('the existing severity rule is unchanged for code', () => {
    // P3-only NEEDS WORK still downgrades, and reports the older reason so the
    // caller picks the older note.
    const gate = applySeverityGate('NEEDS WORK', '- [P3] Rename `x`.', { docOnly: false })
    expect(gate).toEqual({ verdict: 'APPROVE', downgraded: true, reason: 'no_blocking_findings' })
  })
})

describe('the two downgrades are distinguishable', () => {
  it('reports a reason the caller can branch on for the note', () => {
    // The notes say different things, and picking the wrong one tells the author
    // there were no blocking findings when in fact there were and they were capped.
    const docs = applySeverityGate('BLOCK', BLOCKING_REVIEW, { docOnly: true })
    const nits = applySeverityGate('NEEDS WORK', '- [P3] nit', {})
    expect(docs.reason).not.toBe(nits.reason)
  })

  it('the doc note reclassifies rather than dismisses the findings', () => {
    expect(DOC_ONLY_GATE_NOTE).toMatch(/advisory/)
    expect(DOC_ONLY_GATE_NOTE).toMatch(/worth reading/)
    expect(DOC_ONLY_GATE_NOTE).not.toBe(SEVERITY_GATE_NOTE)
  })
})
