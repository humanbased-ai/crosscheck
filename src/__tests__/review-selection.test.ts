import { describe, expect, it } from 'vitest'
import { selectReviewModel, reviewModelExcluded } from '../lib/review-selection.js'
import { ConfigSchema, type ReviewModel } from '../config/schema.js'

const model = (id: string, modelClass: ReviewModel['model_class'], price?: number): ReviewModel => ({
  id, model_class: modelClass, source: 'cli', efforts: ['low', 'medium', 'high', 'max'],
  ...(price === undefined ? {} : { input_usd_mtok: price, output_usd_mtok: price * 5 }),
})
const candidates = [model('gpt-6-luna', 'fast', .1), model('gpt-6.1-sol', 'standard', 2)]

describe('review model and effort policy', () => {
  it.each(['fable', 'best', 'opusplan', 'claude-opus-5-5', 'openai/gpt-6-astra', 'opencode/kimi-k3', 'opencode/glm-5.3', 'opencode/glm-5.3-free', 'openai/gpt-5.5-pro', 'opencode/deepseek-v4-pro', 'opencode/minimax-m3'])(
    'excludes flagship identity %s even through a provider prefix', id => expect(reviewModelExcluded(id)).toBe(true),
  )

  it('couples preference, risk tier and effort without selecting a flagship', () => {
    const cfg = ConfigSchema.parse({ quality: { review_models: { codex: candidates } } })
    const choose = (preference: 'balanced' | 'speed-max' | 'cost-min', tier: 'fast' | 'balanced' | 'thorough') =>
      selectReviewModel('codex', { ...cfg.quality, preference, tier }, cfg.vendors.codex)
    expect(choose('balanced', 'thorough')).toMatchObject({ model: 'gpt-6.1-sol', effort: 'high' })
    expect(choose('speed-max', 'thorough')).toMatchObject({ model: 'gpt-6-luna', effort: 'medium' })
    expect(choose('cost-min', 'thorough')).toMatchObject({ model: 'gpt-6-luna', effort: 'high' })
    expect(choose('cost-min', 'fast').effort).toBe('low')
  })

  it('uses measured provider prices, excludes unknown prices from cost ranking, and preserves explicit custom choices', () => {
    const cfg = ConfigSchema.parse({ quality: { preference: 'cost-min', review_models: { opencode: [
      { ...model('private/fast-review', 'fast'), efforts: ['high'] },
      { ...model('private/standard-review', 'standard', .01), efforts: ['high', 'max'] },
    ] } } })
    expect(selectReviewModel('opencode', cfg.quality, cfg.vendors.opencode)).toEqual({ model: 'private/standard-review', effort: 'high' })
    expect(selectReviewModel('opencode', { ...cfg.quality, review_models: { opencode: cfg.quality.review_models!.opencode!.slice(0, 1) } }, cfg.vendors.opencode).model).toBe('private/fast-review')
  })

  it('rejects an excluded pin and an unresolved OpenCode default before invoking a reviewer', () => {
    const cfg = ConfigSchema.parse({})
    expect(() => selectReviewModel('claude', cfg.quality, { ...cfg.vendors.claude, model: 'opus' })).toThrow(/excluded.*ck init/i)
    expect(() => selectReviewModel('opencode', cfg.quality, cfg.vendors.opencode)).toThrow(/ck init/i)
    expect(selectReviewModel('codex', cfg.quality, cfg.vendors.codex).model).not.toBe('default')
  })

  it('rejects a saved allowlist with no eligible models instead of widening to built-ins', () => {
    const cfg = ConfigSchema.parse({ quality: { review_models: { codex: [] } } })
    expect(() => selectReviewModel('codex', cfg.quality, cfg.vendors.codex)).toThrow(/no eligible/i)
  })
})
