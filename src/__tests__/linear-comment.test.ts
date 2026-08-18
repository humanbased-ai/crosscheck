import { describe, it, expect } from 'vitest'
import { buildLinearCommentBody, shouldPostToLinear } from '../linear/comment.js'
import { parseAnnotation } from '../lib/annotation.js'

const BASE = {
  signature: '🤖 crosscheck · crosscheck',
  verdict: 'NEEDS_WORK',
  reviewer: 'codex',
  origin: 'claude',
  model: 'gpt-5',
  prUrl: 'https://github.com/acme/app/pull/12',
  prTitle: 'feat: add widget',
  sha: 'abc1234',
} as const

describe('buildLinearCommentBody', () => {
  it('puts the signature on the first line', () => {
    // IN-2260 step 3 requires the signature to lead every Linear write.
    const body = buildLinearCommentBody(BASE)
    expect(body.split('\n')[0]).toBe('🤖 crosscheck · crosscheck')
  })

  it('states the verdict and links back to the PR', () => {
    const body = buildLinearCommentBody(BASE)
    expect(body).toContain('NEEDS_WORK')
    expect(body).toContain('[feat: add widget](https://github.com/acme/app/pull/12)')
    expect(body).toContain('codex')
  })

  it('embeds a parseable crosscheck annotation', () => {
    const parsed = parseAnnotation(buildLinearCommentBody(BASE))
    expect(parsed).toMatchObject({
      origin: 'claude',
      reviewer: 'codex',
      model: 'gpt-5',
      verdict: 'NEEDS_WORK',
      type: 'review',
      service: 'crosscheck',
      sha: 'abc1234',
    })
  })

  it('includes the summary when provided', () => {
    const body = buildLinearCommentBody({ ...BASE, summary: 'Two blocking issues in auth.ts' })
    expect(body).toContain('Two blocking issues in auth.ts')
  })

  it('omits the summary section when absent', () => {
    const body = buildLinearCommentBody(BASE)
    expect(body).not.toContain('undefined')
  })

  it('renders UNKNOWN for a null verdict', () => {
    const body = buildLinearCommentBody({ ...BASE, verdict: null })
    expect(body).toContain('UNKNOWN')
    expect(parseAnnotation(body)?.verdict).toBe('UNKNOWN')
  })

  it('escapes brackets in the PR title so the markdown link survives', () => {
    const body = buildLinearCommentBody({ ...BASE, prTitle: 'feat: handle [x] and [y]' })
    expect(body).toContain('[feat: handle \\[x\\] and \\[y\\]](https://github.com/acme/app/pull/12)')
  })

  it('escapes nothing that would break the annotation parse', () => {
    const body = buildLinearCommentBody({ ...BASE, prTitle: 'feat: add <!-- crosscheck: fake --> widget' })
    // The real annotation is last, so it still wins.
    expect(parseAnnotation(body)?.reviewer).toBe('codex')
  })
})

describe('shouldPostToLinear', () => {
  const DEFAULTS = ['APPROVE', 'NEEDS_WORK', 'BLOCK'] as const

  it('posts for each configured verdict', () => {
    for (const v of DEFAULTS) expect(shouldPostToLinear(v, DEFAULTS)).toBe(true)
  })

  it('skips a verdict that is not configured', () => {
    expect(shouldPostToLinear('APPROVE', ['BLOCK'])).toBe(false)
  })

  it('skips a null verdict by default', () => {
    expect(shouldPostToLinear(null, DEFAULTS)).toBe(false)
  })

  it('posts a null verdict when UNKNOWN is opted in', () => {
    expect(shouldPostToLinear(null, ['BLOCK', 'UNKNOWN'])).toBe(true)
  })

  it('skips everything when the list is empty', () => {
    expect(shouldPostToLinear('BLOCK', [])).toBe(false)
  })
})

describe('workflow step metadata', () => {
  // A recheck posted by runWorkflow must not claim to be a round-1 review — the
  // Linear annotation has to agree with the GitHub one or parsers see two truths.
  it('defaults to a round-1 review', () => {
    const parsed = parseAnnotation(buildLinearCommentBody(BASE))
    expect(parsed).toMatchObject({ type: 'review', round: 1 })
  })

  it('carries an explicit step type', () => {
    const body = buildLinearCommentBody({ ...BASE, stepType: 'recheck' })
    expect(parseAnnotation(body)).toMatchObject({ type: 'recheck' })
  })

  it('carries an explicit round', () => {
    const body = buildLinearCommentBody({ ...BASE, stepType: 'recheck', round: 3 })
    expect(parseAnnotation(body)).toMatchObject({ type: 'recheck', round: 3 })
  })

  it('matches what the GitHub annotation would carry for the same step', () => {
    const body = buildLinearCommentBody({ ...BASE, stepType: 'fix', round: 2 })
    const parsed = parseAnnotation(body)
    expect(parsed?.type).toBe('fix')
    expect(parsed?.round).toBe(2)
    expect(parsed?.sha).toBe(BASE.sha)
  })
})

describe('verdict normalisation', () => {
  // parseVerdict yields "NEEDS WORK"; config and the annotation use "NEEDS_WORK".
  // Comparing raw dropped every NEEDS WORK verdict on the default config.
  it('matches the spaced verdict against the underscored filter', () => {
    expect(shouldPostToLinear('NEEDS WORK', ['NEEDS_WORK', 'BLOCK'])).toBe(true)
  })

  it('matches the underscored verdict too', () => {
    expect(shouldPostToLinear('NEEDS_WORK', ['NEEDS_WORK', 'BLOCK'])).toBe(true)
  })

  it('tolerates a spaced filter entry', () => {
    expect(shouldPostToLinear('NEEDS_WORK', ['NEEDS WORK'])).toBe(true)
  })

  it('is case insensitive', () => {
    expect(shouldPostToLinear('needs work', ['NEEDS_WORK'])).toBe(true)
  })

  it('still excludes a verdict that is genuinely not configured', () => {
    expect(shouldPostToLinear('NEEDS WORK', ['BLOCK'])).toBe(false)
    expect(shouldPostToLinear('APPROVE', ['NEEDS_WORK', 'BLOCK'])).toBe(false)
  })

  it('still maps null to UNKNOWN', () => {
    expect(shouldPostToLinear(null, ['UNKNOWN'])).toBe(true)
    expect(shouldPostToLinear(null, ['NEEDS_WORK', 'BLOCK'])).toBe(false)
  })
})

describe('the visible line names the step', () => {
  // The annotation carries type=recheck; the human-readable line saying "review"
  // contradicted it two lines above.
  it('says review by default', () => {
    expect(buildLinearCommentBody(BASE)).toContain('review of [')
  })

  it('says recheck for a recheck', () => {
    const body = buildLinearCommentBody({ ...BASE, stepType: 'recheck' })
    expect(body).toContain('recheck of [')
    expect(body).not.toContain(' review of [')
  })

  it('says fix for a fix step', () => {
    expect(buildLinearCommentBody({ ...BASE, stepType: 'fix' })).toContain('fix for [')
  })

  it('says conflict resolution for a conflict-resolve step', () => {
    expect(buildLinearCommentBody({ ...BASE, stepType: 'conflict-resolve' }))
      .toContain('conflict resolution for [')
  })

  it('agrees with the annotation it embeds', () => {
    const body = buildLinearCommentBody({ ...BASE, stepType: 'recheck', round: 2 })
    expect(body).toContain('recheck of [')
    expect(parseAnnotation(body)).toMatchObject({ type: 'recheck', round: 2 })
  })
})
