import { describe, it, expect } from 'vitest'
import { serveDeprecationNotice, SERVE_MIGRATION_COMMAND } from '../lib/serve-deprecation.js'

describe('serveDeprecationNotice', () => {
  it('states that serve is deprecated and will be removed', () => {
    const lines = serveDeprecationNotice()
    expect(lines[0]).toMatch(/deprecated/i)
    expect(lines[0]).toMatch(/removed/i)
  })

  it('points operators at the watch + smee migration', () => {
    const lines = serveDeprecationNotice()
    const joined = lines.join(' ')
    expect(joined).toContain('crosscheck watch')
    expect(joined).toContain('smee')
  })

  it('exposes the migration command as a reusable constant', () => {
    expect(SERVE_MIGRATION_COMMAND).toContain('crosscheck watch')
    expect(SERVE_MIGRATION_COMMAND).toContain('smee')
  })
})
