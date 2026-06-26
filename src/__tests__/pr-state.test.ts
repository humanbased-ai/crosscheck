import { describe, expect, it } from 'vitest'
import { closedPRSkip } from '../lib/pr-state.js'

describe('closedPRSkip', () => {
  it('returns null for an open PR', () => {
    expect(closedPRSkip({ merged: false, state: 'open' })).toBeNull()
  })

  it('flags a merged PR as merged (merged takes precedence over closed)', () => {
    // GitHub reports merged PRs as state: 'closed' too — merged is the clearer label.
    expect(closedPRSkip({ merged: true, state: 'closed' })).toEqual({ status: 'merged', reason: 'pr_merged' })
  })

  it('flags a closed-but-not-merged PR as closed', () => {
    expect(closedPRSkip({ merged: false, state: 'closed' })).toEqual({ status: 'closed', reason: 'pr_closed' })
  })

  it('tolerates null/undefined fields', () => {
    expect(closedPRSkip({})).toBeNull()
    expect(closedPRSkip({ merged: null, state: null })).toBeNull()
  })
})
