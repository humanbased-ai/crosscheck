import { describe, it, expect } from 'vitest'
import { parsePort } from '../lib/port.js'

describe('parsePort', () => {
  it('accepts the low and high bounds of the valid TCP range', () => {
    expect(parsePort('1')).toBe(1)
    expect(parsePort('65535')).toBe(65535)
  })

  it('accepts a typical port', () => {
    expect(parsePort('8080')).toBe(8080)
  })

  it('rejects zero', () => {
    expect(() => parsePort('0')).toThrow(/between 1 and 65535/)
  })

  it('rejects above the max', () => {
    expect(() => parsePort('65536')).toThrow(/between 1 and 65535/)
  })

  it('rejects negatives', () => {
    expect(() => parsePort('-1')).toThrow(/between 1 and 65535/)
  })

  it('rejects non-numeric strings', () => {
    expect(() => parsePort('abc')).toThrow(/Invalid --port value/)
  })

  it('rejects an empty string', () => {
    expect(() => parsePort('')).toThrow(/Invalid --port value/)
  })

  it('rejects non-integer values', () => {
    expect(() => parsePort('80.5')).toThrow(/between 1 and 65535/)
  })
})
