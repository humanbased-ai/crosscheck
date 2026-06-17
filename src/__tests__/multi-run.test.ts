import { describe, expect, it } from 'vitest'
import { concurrencyError, executeMultiPR, resolveRunConcurrency, summarizeMultiPR, type MultiRunDeps } from '../lib/multi-run.js'
import { parsePRSpec, type PRRef } from '../lib/pr-spec.js'

const refs = (spec: string): PRRef[] => parsePRSpec(spec)
const silent = (deps: Partial<MultiRunDeps>): MultiRunDeps => ({ log: () => {}, dispatch: async () => {}, ...deps })

describe('resolveRunConcurrency', () => {
  it('defaults to one agent per PR', () => {
    expect(resolveRunConcurrency(5, {})).toEqual({ concurrency: 5, staggerMs: 2000 })
  })

  it('forces sequential with --sequential', () => {
    expect(resolveRunConcurrency(5, { sequential: true })).toEqual({ concurrency: 1, staggerMs: 0 })
  })

  it('forces sequential with --concurrent 1', () => {
    expect(resolveRunConcurrency(5, { concurrent: 1 })).toEqual({ concurrency: 1, staggerMs: 0 })
  })

  it('caps at an explicit concurrency', () => {
    expect(resolveRunConcurrency(10, { concurrent: 3 })).toEqual({ concurrency: 3, staggerMs: 2000 })
  })

  it('treats concurrent 0 as one agent per PR', () => {
    expect(resolveRunConcurrency(4, { concurrent: 0 })).toEqual({ concurrency: 4, staggerMs: 2000 })
  })

  it('honors a custom stagger', () => {
    expect(resolveRunConcurrency(4, { staggerMs: 500 })).toEqual({ concurrency: 4, staggerMs: 500 })
  })
})

describe('concurrencyError', () => {
  it('accepts valid and absent values', () => {
    expect(concurrencyError({})).toBeNull()
    expect(concurrencyError({ concurrent: 0 })).toBeNull()
    expect(concurrencyError({ concurrent: 3, staggerMs: 500 })).toBeNull()
  })

  it('rejects NaN concurrency (e.g. --concurrent abc)', () => {
    expect(concurrencyError({ concurrent: Number('abc') })).toMatch(/--concurrent/)
  })

  it('rejects a negative concurrency', () => {
    expect(concurrencyError({ concurrent: -1 })).toMatch(/--concurrent/)
  })

  it('rejects a non-integer concurrency', () => {
    expect(concurrencyError({ concurrent: 2.5 })).toMatch(/--concurrent/)
  })

  it('rejects an invalid stagger', () => {
    expect(concurrencyError({ staggerMs: Number('xyz') })).toMatch(/--stagger/)
  })
})

describe('executeMultiPR', () => {
  it('runs every PR and preserves result order by index', async () => {
    const dispatched: string[] = []
    const results = await executeMultiPR(
      refs('https://github.com/a/x/pull/1,2,3'),
      silent({ dispatch: async (ref) => { dispatched.push(`${ref.repo}#${ref.number}`) } }),
      1,
      0,
    )
    expect(dispatched).toEqual(['x#1', 'x#2', 'x#3'])
    expect(results.map(r => `${r.ref.number}:${r.status}`)).toEqual(['1:executed', '2:executed', '3:executed'])
  })

  it('keeps results aligned with input order even when PRs finish out of order', async () => {
    const results = await executeMultiPR(
      refs('https://github.com/a/x/pull/1,2,3'),
      // PR #1 resolves slowest; #3 fastest. Results must still be [1,2,3].
      silent({ dispatch: (ref) => new Promise(resolve => setTimeout(resolve, (4 - ref.number) * 10)) }),
      3,
      0,
    )
    expect(results.map(r => r.ref.number)).toEqual([1, 2, 3])
    expect(results.every(r => r.status === 'executed')).toBe(true)
  })

  it('never exceeds the concurrency cap', async () => {
    let active = 0
    let peak = 0
    await executeMultiPR(
      refs('https://github.com/a/x/pull/1-6'),
      silent({
        dispatch: async () => {
          active++
          peak = Math.max(peak, active)
          await new Promise(resolve => setTimeout(resolve, 10))
          active--
        },
      }),
      2,
      0,
    )
    expect(peak).toBeLessThanOrEqual(2)
    expect(peak).toBeGreaterThan(1)
  })

  it('continues running the rest when one PR fails, and classifies the failure', async () => {
    const results = await executeMultiPR(
      refs('https://github.com/a/x/pull/1,2,3'),
      silent({
        dispatch: async (ref) => {
          if (ref.number === 2) {
            const err = Object.assign(new Error('Command failed'), { exitCode: 1, stderr: 'network error: ENOTFOUND' })
            throw err
          }
        },
      }),
      1,
      0,
    )
    expect(results.map(r => r.status)).toEqual(['executed', 'failed', 'executed'])
    expect(results[1].reason).toBe('network')
  })

  it('classifies an execa timedOut error as timeout', async () => {
    const results = await executeMultiPR(
      refs('https://github.com/a/x/pull/1'),
      silent({
        dispatch: async () => {
          throw Object.assign(new Error('Command timed out'), { timedOut: true, exitCode: undefined })
        },
      }),
      1,
      0,
    )
    expect(results[0].reason).toBe('timeout')
  })
})

describe('summarizeMultiPR', () => {
  it('counts executed and failed', () => {
    const list = refs('https://github.com/a/x/pull/1,2,3')
    const summary = summarizeMultiPR([
      { ref: list[0], status: 'executed' },
      { ref: list[1], status: 'failed', reason: 'timeout' },
      { ref: list[2], status: 'executed' },
    ])
    expect(summary).toBe('Multi-PR summary: 2 executed, 1 failed')
  })
})
