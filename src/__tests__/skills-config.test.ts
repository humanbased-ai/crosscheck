import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema.js'

describe('skills config', () => {
  it('keeps existing configs unchanged by default', () => {
    expect(ConfigSchema.parse({}).skills.enabled).toEqual([])
  })

  it('accepts enabled skill names', () => {
    expect(ConfigSchema.parse({ skills: { enabled: ['code-review-skill'] } }).skills.enabled)
      .toEqual(['code-review-skill'])
  })
})
