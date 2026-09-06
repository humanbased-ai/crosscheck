import { describe, expect, it } from 'vitest'
import {
  applySeverityGate,
  detectInconclusiveReview,
  reviewHasNoFindings,
  hasBlockingFindings,
} from '../lib/verdict.js'

// The body codex actually posted on humanbased-ai/monorepo#3649 after the PR's base
// branch was deleted, leaving origin/<base> absent from the checkout. Verbatim, so a
// regression here is a regression against the real failure and not a paraphrase.
const INCIDENT_BODY = `### Code Review by ⚡ Codex · gpt-5.6-terra

⚠️ **NEEDS WORK**

## Summary

Review could not be performed: \`origin/chore/in-4439-registry-machine-ownership\` is absent from this checkout. Only \`origin/main\` is available, so the required diff cannot be resolved.

## Critical Issues

None assessed.

## Warnings

- Required base ref is missing; please provide/fetch it so the PR-only changes can be reviewed.

## Suggestions

None.
`

describe('hedged empty sections', () => {
  it('reads "None assessed." as an empty Critical Issues section', () => {
    // The original defect: only a bare "None" was recognised, so a reviewer that
    // hedged had its non-finding counted as a blocking finding.
    expect(hasBlockingFindings('## Critical Issues\n\nNone assessed.\n')).toBe(false)
  })

  it.each([
    'None assessed.',
    'Not assessed',
    'None evaluated.',
    'Not evaluated',
    'Could not assess.',
    'Unable to assess',
    'Not applicable.',
    'Nothing checked',
  ])('reads %j as empty', phrase => {
    expect(hasBlockingFindings(`## Critical Issues\n\n${phrase}\n`)).toBe(false)
  })

  it('keeps a hedge that carries a real finding blocking', () => {
    // Anchored matching: the negation must be the whole section, not its opening.
    expect(hasBlockingFindings('## Critical Issues\n\nNone assessed as critical, but the token is logged in plaintext.\n')).toBe(true)
  })
})

describe('detectInconclusiveReview', () => {
  it('flags the incident body', () => {
    const result = detectInconclusiveReview(INCIDENT_BODY)
    expect(result.inconclusive).toBe(true)
    expect(result.reason).toBeTruthy()
  })

  it.each([
    'Review could not be performed: the base ref is missing.',
    'Unable to resolve the diff, so nothing was reviewed.',
    'The diff cannot be computed for this PR.',
    '`origin/feature` is absent from this checkout.',
    'No diff is available to review.',
  ])('flags %j', body => {
    expect(detectInconclusiveReview(body).inconclusive).toBe(true)
  })

  it('does not flag a real review that merely mentions a missing ref', () => {
    // A reviewer that found a P1 did the work; the grumble is not the outcome.
    const body = '## Critical Issues\n\n- [P1] Null deref at foo.ts:12. Note the base ref is missing from my notes.\n'
    expect(detectInconclusiveReview(body).inconclusive).toBe(false)
  })

  it('does not flag an ordinary clean review', () => {
    expect(detectInconclusiveReview('## Critical Issues\n\nNone.\n\n## Suggestions\n\n- [P3] Rename `x`.\n').inconclusive).toBe(false)
  })
})

describe('inconclusive outranks the severity gate', () => {
  it('the incident body would otherwise be upgraded to APPROVE', () => {
    // This is why the gate ordering matters and is asserted rather than assumed:
    // with hedged empties recognised, the body carries no blocking finding, so the
    // severity gate reads it as nits-only and clears the PR to merge — on a review
    // that never ran. The inconclusive check must come first.
    expect(applySeverityGate('NEEDS WORK', INCIDENT_BODY)).toEqual({ verdict: 'APPROVE', downgraded: true })
    expect(detectInconclusiveReview(INCIDENT_BODY).inconclusive).toBe(true)
  })
})

describe('reviewHasNoFindings', () => {
  it('is false when a Critical Issues section has content', () => {
    expect(reviewHasNoFindings('## Critical Issues\n\n- Fix the null deref.\n')).toBe(false)
  })

  it('is false for a P3-only review — `ck fix` is how a user opts into nits', () => {
    expect(reviewHasNoFindings('- [P3] Rename `x` to `count`.')).toBe(false)
  })

  it('is false when only Suggestions carry content', () => {
    expect(reviewHasNoFindings('## Critical Issues\n\nNone.\n\n## Suggestions\n\n- Extract the helper.\n')).toBe(false)
  })

  it('is true when every recognised section is an explicit None', () => {
    expect(reviewHasNoFindings('## Critical Issues\n\nNone.\n\n## Warnings\n\nNone.\n\n## Suggestions\n\nNone.\n')).toBe(true)
  })

  it('is true for a wholly hedged-empty review', () => {
    expect(reviewHasNoFindings('## Critical Issues\n\nNone assessed.\n\n## Suggestions\n\nNot evaluated.\n')).toBe(true)
  })

  it('is false for a body in an unrecognised format — never claims emptiness it cannot prove', () => {
    // Skipping the fix on a false positive silently drops a legitimate fix, so an
    // unfamiliar shape must fall through to running the step.
    expect(reviewHasNoFindings('The auth check is inverted; swap the branches in login().')).toBe(false)
  })

  it('is false for the incident body — one section did carry a warning', () => {
    // The inconclusive gate is what catches this one; the preflight must not also
    // claim it, or the two guards would disagree about the same body.
    expect(reviewHasNoFindings(INCIDENT_BODY)).toBe(false)
  })
})
