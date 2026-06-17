import { describe, expect, it } from 'vitest'
import { parsePRSpec } from '../lib/pr-spec.js'

const sig = (refs: ReturnType<typeof parsePRSpec>) => refs.map(r => `${r.owner}/${r.repo}#${r.number}`)

describe('parsePRSpec', () => {
  it('parses a single full URL', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/245')
    expect(sig(refs)).toEqual(['acme/web#245'])
    expect(refs[0].url).toBe('https://github.com/acme/web/pull/245')
  })

  it('expands a URL followed by bare numbers under the same repo', () => {
    const refs = parsePRSpec('https://github.com/Motivation-Labs/monorepo/pull/245,255')
    expect(sig(refs)).toEqual(['Motivation-Labs/monorepo#245', 'Motivation-Labs/monorepo#255'])
  })

  it('expands an inclusive range in the URL tail', () => {
    const refs = parsePRSpec('https://github.com/Motivation-Labs/monorepo/pull/245-248')
    expect(sig(refs)).toEqual([
      'Motivation-Labs/monorepo#245',
      'Motivation-Labs/monorepo#246',
      'Motivation-Labs/monorepo#247',
      'Motivation-Labs/monorepo#248',
    ])
  })

  it('parses multiple full URLs across different repos', () => {
    const refs = parsePRSpec('https://github.com/Motivation-Labs/monorepo/pull/245,https://github.com/Humanbased-ai/monorepo/pull/210')
    expect(sig(refs)).toEqual(['Motivation-Labs/monorepo#245', 'Humanbased-ai/monorepo#210'])
  })

  it('mixes URL, ranges, bare numbers, and a second repo', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/245-247,250,https://github.com/other/api/pull/3-4')
    expect(sig(refs)).toEqual([
      'acme/web#245', 'acme/web#246', 'acme/web#247', 'acme/web#250',
      'other/api#3', 'other/api#4',
    ])
  })

  it('inherits the repo from the most recent URL token', () => {
    const refs = parsePRSpec('https://github.com/a/x/pull/1,https://github.com/b/y/pull/2,3')
    expect(sig(refs)).toEqual(['a/x#1', 'b/y#2', 'b/y#3'])
  })

  it('tolerates whitespace around tokens', () => {
    const refs = parsePRSpec(' https://github.com/acme/web/pull/245 , 255 ')
    expect(sig(refs)).toEqual(['acme/web#245', 'acme/web#255'])
  })

  it('accepts a scheme-less URL', () => {
    const refs = parsePRSpec('github.com/acme/web/pull/9')
    expect(sig(refs)).toEqual(['acme/web#9'])
    expect(refs[0].url).toBe('https://github.com/acme/web/pull/9')
  })

  it('ignores trailing URL path segments like /files', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/12/files')
    expect(sig(refs)).toEqual(['acme/web#12'])
  })

  it('deduplicates the same PR appearing twice', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/5,5,5')
    expect(sig(refs)).toEqual(['acme/web#5'])
  })

  it('deduplicates overlapping ranges and bare numbers', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/5-7,6')
    expect(sig(refs)).toEqual(['acme/web#5', 'acme/web#6', 'acme/web#7'])
  })

  it('throws when a bare number appears before any URL', () => {
    expect(() => parsePRSpec('245,255')).toThrow(/no repository is known/i)
  })

  it('throws on a descending range', () => {
    expect(() => parsePRSpec('https://github.com/acme/web/pull/10-5')).toThrow(/before start/i)
  })

  it('throws on a non-PR token', () => {
    expect(() => parsePRSpec('https://github.com/acme/web/issues/5')).toThrow(/Invalid PR reference/i)
  })

  it('throws on an empty spec', () => {
    expect(() => parsePRSpec('   ')).toThrow(/No PR reference/i)
  })

  it('throws when a single range exceeds the cap', () => {
    expect(() => parsePRSpec('https://github.com/acme/web/pull/1-500', { maxPRs: 100 })).toThrow(/>100/)
  })

  it('throws when the cumulative count exceeds the cap', () => {
    expect(() => parsePRSpec('https://github.com/acme/web/pull/1-60,200-260', { maxPRs: 100 })).toThrow(/Too many PRs/i)
  })

  it('respects a custom maxPRs that allows the spec', () => {
    const refs = parsePRSpec('https://github.com/acme/web/pull/1-5', { maxPRs: 5 })
    expect(refs).toHaveLength(5)
  })
})
