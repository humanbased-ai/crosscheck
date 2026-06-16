import { describe, it, expect } from 'vitest'
import { selectTip, TIPS, TIP_INTERVAL_MS } from '../lib/tips.js'

describe('selectTip', () => {
  it('returns a tip with a non-empty text field', () => {
    const tip = selectTip(0, 0)
    expect(typeof tip.text).toBe('string')
    expect(tip.text.length).toBeGreaterThan(0)
  })

  it('returns TIPS[0] at session start (elapsed = 0)', () => {
    const base = 1_000_000
    expect(selectTip(base, base)).toBe(TIPS[0])
  })

  it('returns TIPS[0] just before the first interval elapses', () => {
    const base = 1_000_000
    expect(selectTip(base, base + TIP_INTERVAL_MS - 1)).toBe(TIPS[0])
  })

  it('advances to TIPS[1] at exactly one interval', () => {
    const base = 1_000_000
    expect(selectTip(base, base + TIP_INTERVAL_MS)).toBe(TIPS[1])
  })

  it('advances to TIPS[2] at two intervals', () => {
    const base = 1_000_000
    expect(selectTip(base, base + 2 * TIP_INTERVAL_MS)).toBe(TIPS[2])
  })

  it('wraps around to TIPS[0] after all tips have been shown', () => {
    const base = 1_000_000
    expect(selectTip(base, base + TIPS.length * TIP_INTERVAL_MS)).toBe(TIPS[0])
  })

  it('handles negative elapsed (future sessionStart) without throwing', () => {
    const tip = selectTip(Date.now() + 100_000)
    expect(tip).toBeDefined()
    expect(TIPS).toContain(tip)
  })

  it('every tip index in the cycle is reachable', () => {
    const base = 0
    const seen = new Set<number>()
    for (let i = 0; i < TIPS.length; i++) {
      const tip = selectTip(base, i * TIP_INTERVAL_MS)
      seen.add(TIPS.indexOf(tip))
    }
    expect(seen.size).toBe(TIPS.length)
  })

  it('leads the rotation with high-priority fire tips', () => {
    // Fire-badged (new-feature) tips sit at the front so a fresh session shows them first.
    expect(TIPS[0].badge).toBe('fire')
    expect(selectTip(0, 0).badge).toBe('fire')
    const fireCount = TIPS.filter(t => t.badge === 'fire').length
    expect(fireCount).toBeGreaterThanOrEqual(1)
    // The leading run of tips are all fire tips (contiguous priority block).
    expect(TIPS.slice(0, fireCount).every(t => t.badge === 'fire')).toBe(true)
  })
})
