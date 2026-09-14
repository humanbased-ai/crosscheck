import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema.js'

describe('review efficiency defaults', () => {
  it.each([{}, { quality: { tier: 'thorough' } }])('enables caching and review memory for existing configs: %j', input => {
    const config = ConfigSchema.parse(input)
    expect(config.repository_cache).toBe(true)
    expect(config.quality.review_memory).toBe(true)
  })
  it('preserves explicit opt-outs independently', () => {
    expect(ConfigSchema.parse({ repository_cache: false }).repository_cache).toBe(false)
    expect(ConfigSchema.parse({ repository_cache: false }).quality.review_memory).toBe(true)
    expect(ConfigSchema.parse({ quality: { review_memory: false } }).quality.review_memory).toBe(false)
    expect(ConfigSchema.parse({ quality: { review_memory: false } }).repository_cache).toBe(true)
  })
})
