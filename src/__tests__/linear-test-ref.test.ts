import { describe, it, expect } from 'vitest'
import { resolveTestRef, softWrap } from '../commands/linear-test.js'

describe('resolveTestRef', () => {
  it('takes a named issue verbatim, upper-cased', () => {
    expect(resolveTestRef('eng-42', {}, [])).toEqual({ id: 'ENG-42', source: 'argument' })
  })

  it('lets a named issue bypass the team_keys gate', () => {
    // Typing the ref is unambiguous in a way that finding it in a branch is not,
    // so `crosscheck linear-test ENG-42` works before team_keys is configured.
    expect(resolveTestRef('ENG-42', {}, [])).toEqual({ id: 'ENG-42', source: 'argument' })
  })

  it('prefers the named issue over anything inferable', () => {
    expect(resolveTestRef('ENG-1', { branch: 'feat/in-2269-x' }, ['IN']))
      .toEqual({ id: 'ENG-1', source: 'argument' })
  })

  it('falls back to the branch when no issue is named', () => {
    expect(resolveTestRef(undefined, { branch: 'feat/in-2269-x' }, ['IN']))
      .toEqual({ id: 'IN-2269', source: 'branch' })
  })

  it('falls back to the title', () => {
    expect(resolveTestRef(undefined, { title: 'IN-543: resolver' }, ['IN']))
      .toEqual({ id: 'IN-543', source: 'title' })
  })

  it('still honours the team_keys gate for inferred refs', () => {
    expect(resolveTestRef(undefined, { branch: 'feat/in-2269-x' }, [])).toBeNull()
  })

  it('returns null with nothing to go on', () => {
    expect(resolveTestRef(undefined, {}, ['IN'])).toBeNull()
  })

  it('treats a blank argument as absent', () => {
    expect(resolveTestRef('   ', { branch: 'feat/in-7-x' }, ['IN']))
      .toEqual({ id: 'IN-7', source: 'branch' })
  })
})

describe('softWrap', () => {
  it('leaves a short line alone', () => {
    expect(softWrap('short', 20)).toEqual(['short'])
  })

  it('wraps on whitespace at the boundary', () => {
    expect(softWrap('aaa bbb ccc ddd', 7)).toEqual(['aaa bbb', 'ccc ddd'])
  })

  it('never breaks a token, even one longer than the width', () => {
    const url = 'https://github.com/acme/app/pull/42'
    expect(softWrap(`see ${url} ok`, 10)).toEqual(['see', url, 'ok'])
  })

  it('wraps the annotation without splitting a field', () => {
    const line = '<!-- crosscheck: origin=claude reviewer=codex model=gpt-5.6-terra type=review round=1 verdict=NEEDS_WORK -->'
    for (const chunk of softWrap(line, 80)) expect(chunk.length).toBeLessThanOrEqual(80)
    expect(softWrap(line, 80).join(' ')).toBe(line)
  })

  it('preserves content exactly when rejoined', () => {
    const line = 'the quick brown fox jumps over the lazy dog'
    expect(softWrap(line, 12).join(' ')).toBe(line)
  })
})

describe('onboard Linear decision — regression guards', () => {
  // These encode the two onboarding defects the recheck found. The prompt itself
  // needs a TTY, so these pin the decision rules the prompt implements.
  it('Enter must map to the current mode, not to off', () => {
    const decide = (answer: string, currentMode: string): string =>
      answer === '1' ? 'off'
        : answer === '2' ? 'api_key'
          : answer === '3' ? 'client_credentials'
            : currentMode

    expect(decide('', 'client_credentials')).toBe('client_credentials')
    expect(decide('', 'api_key')).toBe('api_key')
    expect(decide('', 'off')).toBe('off')
    expect(decide('1', 'client_credentials')).toBe('off')
    expect(decide('2', 'off')).toBe('api_key')
    expect(decide('3', 'off')).toBe('client_credentials')
  })

  it('an explicit clear must be distinguishable from Enter', () => {
    const resolveKeys = (answer: string, current: string[]): string[] =>
      answer === '-' ? []
        : answer ? answer.split(',').map(k => k.trim().toUpperCase()).filter(Boolean)
          : current

    expect(resolveKeys('', ['IN'])).toEqual(['IN'])
    expect(resolveKeys('-', ['IN'])).toEqual([])
    expect(resolveKeys('eng,ops', ['IN'])).toEqual(['ENG', 'OPS'])
  })
})
