import { describe, it, expect } from 'vitest'
import { canWriteVerdict } from '../lib/workflow.js'

describe('canWriteVerdict', () => {
  // Only review and recheck post a verdict, and only a verdict reaches Linear.
  // `crosscheck fix` and `crosscheck resolve` must not abort on a Linear outage.
  it('is true for a workflow containing a review', () => {
    expect(canWriteVerdict([{ type: 'review' }])).toBe(true)
  })

  it('is true for a workflow containing a recheck', () => {
    expect(canWriteVerdict([{ type: 'recheck' }])).toBe(true)
  })

  it('is true for the full loop', () => {
    expect(canWriteVerdict([{ type: 'review' }, { type: 'fix' }, { type: 'recheck' }])).toBe(true)
  })

  it('is false for a fix-only workflow — the `crosscheck fix` alias', () => {
    expect(canWriteVerdict([{ type: 'fix' }])).toBe(false)
  })

  it('is false for conflict-resolve only — the `crosscheck resolve` alias', () => {
    expect(canWriteVerdict([{ type: 'conflict-resolve' }])).toBe(false)
  })

  it('is false for fix plus conflict-resolve', () => {
    expect(canWriteVerdict([{ type: 'conflict-resolve' }, { type: 'fix' }])).toBe(false)
  })

  it('is false for an empty workflow', () => {
    expect(canWriteVerdict([])).toBe(false)
  })

  it('fails open when the steps are unknown, so a real workflow is never starved', () => {
    expect(canWriteVerdict(undefined)).toBe(true)
  })
})
