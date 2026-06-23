import { describe, it, expect } from 'vitest'
import { isVendorUnavailableError, isSubscriptionLimitError } from '../lib/smart-switch.js'

describe('isVendorUnavailableError', () => {
  it('matches a Codex CLI too old for its default model', () => {
    const err = new Error(
      "codex: The 'gpt-5.5' model requires a newer version of Codex. Please upgrade to the latest app or CLI and try again.",
    )
    expect(isVendorUnavailableError(err)).toBe(true)
  })

  it('matches a not-logged-in / auth failure', () => {
    expect(isVendorUnavailableError(new Error('codex: not logged in'))).toBe(true)
    expect(isVendorUnavailableError(new Error('claude: authentication required'))).toBe(true)
    expect(isVendorUnavailableError(new Error('codex: unauthorized (bad credentials)'))).toBe(true)
  })

  it('does not match ordinary subprocess crashes or timeouts', () => {
    expect(isVendorUnavailableError(new Error('codex: reviewer subprocess failed'))).toBe(false)
    expect(isVendorUnavailableError(new Error('claude: timed out after 600s'))).toBe(false)
    expect(isVendorUnavailableError(new Error('network error: ECONNRESET'))).toBe(false)
  })

  it('does not overlap with usage-limit detection (distinct triggers)', () => {
    const limit = new Error('codex: usage limit reached (429)')
    expect(isSubscriptionLimitError(limit)).toBe(true)
    expect(isVendorUnavailableError(limit)).toBe(false)
  })
})
