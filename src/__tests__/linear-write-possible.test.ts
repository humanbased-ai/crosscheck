import { describe, it, expect } from 'vitest'
import { linearWritePossible } from '../lib/workflow.js'

const REVIEW = [{ type: 'review' }]
const FIX_ONLY = [{ type: 'fix' }]

describe('linearWritePossible', () => {
  // One predicate for every auth gate. Three separate checks had drifted apart
  // across run/watch/review/runner, each fixed a round apart.
  it('is false when Linear is disabled', () => {
    expect(linearWritePossible({ enabled: false, comment_on: ['BLOCK'] }, REVIEW)).toBe(false)
  })

  it('is false when no verdict is configured to post', () => {
    // comment_on: [] is valid and means nothing ever posts — minting a token or
    // aborting on a missing credential for that run is pure waste.
    expect(linearWritePossible({ enabled: true, comment_on: [] }, REVIEW)).toBe(false)
  })

  it('is false when the workflow cannot produce a verdict', () => {
    expect(linearWritePossible({ enabled: true, comment_on: ['BLOCK'] }, FIX_ONLY)).toBe(false)
  })

  it('is true only when all three hold', () => {
    expect(linearWritePossible({ enabled: true, comment_on: ['BLOCK'] }, REVIEW)).toBe(true)
  })

  it('fails open on unknown steps, so a real workflow is never starved', () => {
    expect(linearWritePossible({ enabled: true, comment_on: ['BLOCK'] }, undefined)).toBe(true)
  })

  it('still respects disablement even with unknown steps', () => {
    expect(linearWritePossible({ enabled: false, comment_on: ['BLOCK'] }, undefined)).toBe(false)
    expect(linearWritePossible({ enabled: true, comment_on: [] }, undefined)).toBe(false)
  })
})
