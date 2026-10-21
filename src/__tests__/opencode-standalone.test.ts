import { describe, expect, it } from 'vitest'
import { parseOpenCodeStandaloneSupport } from '../reviewers/opencode.js'

describe('parseOpenCodeStandaloneSupport', () => {
  it('detects the flag when the CLI lists it', () => {
    const help = [
      'opencode run [message..]',
      '',
      'Options:',
      '      --standalone  run a private server instead of the shared one  [boolean]',
    ].join('\n')
    expect(parseOpenCodeStandaloneSupport(help)).toBe(true)
  })

  it('returns false for a v1 help listing without the flag', () => {
    const help = [
      'opencode run [message..]',
      '',
      'Options:',
      '      --format  format: default (formatted) or json (raw JSON events)  [string]',
    ].join('\n')
    expect(parseOpenCodeStandaloneSupport(help)).toBe(false)
  })

  it('ignores ANSI styling around the flag', () => {
    expect(parseOpenCodeStandaloneSupport('\x1b[32m--standalone\x1b[39m  private server')).toBe(true)
  })
})
