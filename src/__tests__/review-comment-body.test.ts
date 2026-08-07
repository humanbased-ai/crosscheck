import { describe, it, expect } from 'vitest'
import { buildReviewCommentBody } from '../github/client.js'

describe('buildReviewCommentBody', () => {
  it('renders Claude thorough with model and custom service in the header and annotation', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'claude',
      brand: { service_name: 'Acme' },
      origin: 'codex',
      verdict: 'APPROVE',
      model: 'claude-opus-4-8',
      stepType: 'review',
      round: 2,
      sha: 'abc1234',
    })

    expect(body).toContain('### Code Review by 🤖 Claude Code · Opus 4.8 · Acme')
    expect(body).toContain('model=claude-opus-4-8 type=review round=2 verdict=APPROVE service=Acme sha=abc1234')
  })

  it('reports the model and effort the review actually ran with in the attribution', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'claude',
      verdict: 'APPROVE',
      model: 'claude-opus-4-8',
      effort: 'high',
      stepType: 'review',
    })

    expect(body).toContain('via [Crosscheck](https://github.com/humanbased-ai/crosscheck)_ _(Opus 4.8 · high effort)_')
  })

  it('reports effort alone when the model is the vendor default', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'codex',
      verdict: 'APPROVE',
      model: 'default',
      effort: 'xhigh',
      stepType: 'review',
    })

    expect(body).toContain('_(xhigh effort)_')
  })

  it('appends run details to a branded attribution rather than replacing it', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'claude',
      verdict: 'APPROVE',
      brand: { reviewer_attribution: '**Acme Review Bot**' },
      model: 'claude-opus-4-8',
      effort: 'max',
      stepType: 'review',
    })

    expect(body).toContain('**Acme Review Bot** _(Opus 4.8 · max effort)_')
    expect(body).not.toContain('Reviewed with [Claude Code]')
  })

  it('omits model and service segments for default Codex subscription auth', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: NEEDS_WORK',
      reviewer: 'codex',
      brand: { service_name: 'crosscheck' },
      origin: 'claude',
      verdict: 'NEEDS_WORK',
      model: 'default',
      stepType: 'review',
    })

    expect(body).toContain('### Code Review by ⚡ Codex\n\n')
    expect(body).not.toContain(' · ')
    expect(body).toContain('model=default')
  })

  it('renders recheck and fix step verbs', () => {
    const recheck = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'codex',
      verdict: 'APPROVE',
      model: 'gpt-5.6-terra',
      stepType: 'recheck',
      replyToCommentId: 123,
    })
    const fix = buildReviewCommentBody({
      body: 'fixed',
      reviewer: 'claude',
      verdict: 'APPROVE',
      model: 'claude-sonnet-5',
      stepType: 'fix',
    })

    expect(recheck).toContain('> Recheck of [original review](#issuecomment-123)')
    expect(recheck).toContain('### Recheck by ⚡ Codex · gpt-5.6-terra')
    expect(fix).toContain('### Fixes by 🤖 Claude Code · Sonnet 5')
  })
})
