import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema.js'
import { resolveRoundExecution } from '../lib/runner.js'
import { resolveReviewStrategy } from '../lib/review-strategy.js'
import { selectReviewModel } from '../lib/review-selection.js'

const risky = resolveReviewStrategy({ files: ['src/auth/session.ts'], additions: 10, deletions: 2 })
const normal = resolveReviewStrategy({ files: ['src/widget.ts'], additions: 200, deletions: 100 })
const vendors = { claude: { enabled: false }, codex: { enabled: false }, opencode: { enabled: true } }

describe('escalation uses the permitted review model at the wire', () => {
  it('explicitly reaches the ceiling on a thorough OpenCode tier with no verified variants', () => {
    const cfg = ConfigSchema.parse({ vendors: { ...vendors, opencode: {
      enabled: true, model_tiers: { thorough: 'opencode/deepseek-v4.1-flash' },
    } } })
    const first = resolveRoundExecution(cfg, risky, 1)
    expect(first.atCeiling).toBe(false)
    for (const round of [2, 3, 4]) {
      const next = resolveRoundExecution(cfg, risky, round)
      expect(next).toMatchObject({ atCeiling: true, escalated: false })
      expect(selectReviewModel('opencode', next.quality, next.opencodeVendor))
        .toEqual(selectReviewModel('opencode', first.quality, first.opencodeVendor))
    }
  })

  it('uses discovered variants over the empty bundled ladder and ignores legacy flagship pins', () => {
    const cfg = ConfigSchema.parse({ vendors: { ...vendors, opencode: { enabled: true, model: 'opencode/kimi-k3' } }, quality: {
      preference: 'balanced', review_models: { opencode: [{ id: 'opencode/glm-5.3-flash',
        model_class: 'fast', source: 'cli', efforts: ['low', 'medium', 'high', 'max'],
      }] },
    } })
    const first = resolveRoundExecution(cfg, normal, 1)
    const next = resolveRoundExecution(cfg, normal, 2)
    expect(next).toMatchObject({ atCeiling: false, escalated: true, quality: { tier: 'balanced' } })
    expect(selectReviewModel('opencode', first.quality, first.opencodeVendor).effort).toBe('medium')
    expect(selectReviewModel('opencode', next.quality, next.opencodeVendor).effort).toBe('high')
    const capped = resolveRoundExecution(cfg, normal, 3)
    expect(capped).toMatchObject({ atCeiling: true, escalated: false })
    expect(selectReviewModel('opencode', capped.quality, capped.opencodeVendor).effort).toBe('high')
  })

  it('does not claim escalation when the speed-max effort ceiling binds', () => {
    const cfg = ConfigSchema.parse({ vendors, quality: { preference: 'speed-max', review_models: {
      opencode: [{ id: 'private/fast-review', model_class: 'fast', source: 'configured', efforts: ['low', 'medium', 'high'] }],
    } } })
    expect(resolveRoundExecution(cfg, risky, 2)).toMatchObject({ atCeiling: true, escalated: false })
  })

  it('ignores explicitly disabled review pools when testing escalation headroom', () => {
    const cfg = ConfigSchema.parse({ vendors: { ...vendors, claude: { enabled: true } }, quality: {
      review_models: { claude: [], opencode: [{ id: 'private/review', model_class: 'standard', source: 'configured', efforts: ['medium', 'high'] }] },
    } })
    expect(resolveRoundExecution(cfg, normal, 2)).toMatchObject({ atCeiling: false, escalated: true, quality: { tier: 'balanced' } })
  })

  it('does not call a nominal tier promotion an escalation when a pin keeps the same request', () => {
    const cfg = ConfigSchema.parse({ vendors: { ...vendors, opencode: { enabled: true, model: 'opencode/glm-5.3-flash' } } })
    const trivial = resolveReviewStrategy({ files: ['src/widget.ts'], additions: 1, deletions: 1 })
    expect(resolveRoundExecution(cfg, trivial, 2)).toMatchObject({ atCeiling: true, escalated: false })
  })
})
