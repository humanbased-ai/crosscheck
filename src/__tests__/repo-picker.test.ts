import { describe, it, expect } from 'vitest'
import {
  adjustWindowStart,
  advancePageStart,
  filterIndices,
  formatPickerHint,
  resolveViewport,
  truncate,
} from '../lib/repo-picker.js'

describe('filterIndices', () => {
  it('returns every index when query is empty', () => {
    expect(filterIndices(['a', 'b', 'c'], '')).toEqual([0, 1, 2])
  })

  it('is case-insensitive', () => {
    expect(filterIndices(['Alpha', 'Beto', 'GAMMA'], 'A')).toEqual([0, 2])
    expect(filterIndices(['Alpha', 'Beto', 'GAMMA'], 'a')).toEqual([0, 2])
  })

  it('matches substrings anywhere in the label', () => {
    expect(filterIndices(['codatta/symphony', 'codatta/xny', 'org/other'], 'xny')).toEqual([1])
  })

  it('returns [] when nothing matches', () => {
    expect(filterIndices(['one', 'two'], 'zzz')).toEqual([])
  })

  it('preserves original order', () => {
    expect(filterIndices(['ab', 'ba', 'ab2', 'cb'], 'b')).toEqual([0, 1, 2, 3])
  })
})

describe('adjustWindowStart', () => {
  // viewport = 5, total = 20 — common case
  it('keeps window unchanged when cursor is already visible', () => {
    expect(adjustWindowStart(3, 5, 5, 20)).toBe(3)
  })

  it('shifts up when cursor is above the window', () => {
    expect(adjustWindowStart(10, 5, 5, 20)).toBe(5)
  })

  it('shifts down when cursor is past the window bottom', () => {
    expect(adjustWindowStart(0, 7, 5, 20)).toBe(3)  // cursor 7 → window [3, 8)
  })

  it('clamps so window never extends past the list', () => {
    expect(adjustWindowStart(18, 19, 5, 20)).toBe(15)  // total - viewport = 15
  })

  it('returns 0 when total < viewport', () => {
    expect(adjustWindowStart(2, 1, 10, 3)).toBe(0)
  })

  it('returns 0 when total is 0', () => {
    expect(adjustWindowStart(5, 0, 5, 0)).toBe(0)
  })

  it('never returns negative', () => {
    expect(adjustWindowStart(-3, 0, 5, 10)).toBe(0)
  })
})

describe('resolveViewport', () => {
  it('uses the hint when terminal is tall enough', () => {
    expect(resolveViewport(12, 40)).toBe(12)
  })

  it('caps the hint by terminal height minus chrome', () => {
    // termRows=20 → ceiling = 20 - 6 = 14
    expect(resolveViewport(50, 20)).toBe(14)
  })

  it('falls back to default page size when hint is missing', () => {
    expect(resolveViewport(undefined, 40)).toBe(12)  // DEFAULT_PAGE_SIZE
  })

  it('falls back to 24 rows when termRows is missing', () => {
    // 24 - 6 = 18 ceiling, default hint 12 wins
    expect(resolveViewport(undefined, undefined)).toBe(12)
  })

  it('floors at 3 even on tiny terminals', () => {
    expect(resolveViewport(20, 5)).toBe(3)
  })

  it('treats zero or negative termRows as missing', () => {
    expect(resolveViewport(12, 0)).toBe(12)
  })

  it('treats zero or negative hint as missing', () => {
    expect(resolveViewport(0, 40)).toBe(12)
  })
})

describe('truncate', () => {
  it('returns the input unchanged when it fits', () => {
    expect(truncate('hello', 10)).toBe('hello')
    expect(truncate('hello', 5)).toBe('hello')
  })

  it('appends an ellipsis when truncation is needed', () => {
    expect(truncate('hello world', 5)).toBe('hell…')
    expect(truncate('hello', 4)).toBe('hel…')
  })

  it('returns just the ellipsis when only 1 column is available', () => {
    expect(truncate('hello', 1)).toBe('…')
  })

  it('returns the empty string for zero or negative width', () => {
    expect(truncate('hello', 0)).toBe('')
    expect(truncate('hello', -3)).toBe('')
  })

  it('handles empty input safely', () => {
    expect(truncate('', 10)).toBe('')
    expect(truncate('', 0)).toBe('')
  })
})

describe('formatPickerHint', () => {
  it('fits the prefix and message within the terminal width', () => {
    expect(formatPickerHint('tip', 'A long recommendation', 20)).toBe('  Tip: A long recom…')
    expect(formatPickerHint('warning', 'Competing skill', 20)).toBe('  Warning: Competin…')
  })
})

describe('advancePageStart', () => {
  // viewport = 5, total = 20 — typical PgDn / PgUp scenarios
  it('advances by one full viewport on PageDown', () => {
    expect(advancePageStart(0, 5, 20, 1)).toBe(5)
    expect(advancePageStart(5, 5, 20, 1)).toBe(10)
  })

  it('retreats by one full viewport on PageUp', () => {
    expect(advancePageStart(10, 5, 20, -1)).toBe(5)
    expect(advancePageStart(5, 5, 20, -1)).toBe(0)
  })

  it('clamps at zero on PageUp', () => {
    expect(advancePageStart(2, 5, 20, -1)).toBe(0)
    expect(advancePageStart(0, 5, 20, -1)).toBe(0)
  })

  it('clamps at total - viewport on PageDown', () => {
    // From windowStart=15, PgDn would land at 20 — clamped to 15 (the last valid start).
    expect(advancePageStart(15, 5, 20, 1)).toBe(15)
    expect(advancePageStart(18, 5, 20, 1)).toBe(15)
  })

  it('returns 0 when total is smaller than the viewport', () => {
    expect(advancePageStart(0, 10, 4, 1)).toBe(0)
    expect(advancePageStart(0, 10, 4, -1)).toBe(0)
  })
})
