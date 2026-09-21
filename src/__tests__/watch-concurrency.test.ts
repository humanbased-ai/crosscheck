import { describe, expect, it } from 'vitest'
import { runWithConcurrency } from '../commands/watch.js'
import { ConfigSchema, BacktraceConfigSchema } from '../config/schema.js'

describe('runWithConcurrency', () => {
  it('never runs more than `limit` tasks at once', async () => {
    let active = 0
    let peak = 0
    const tasks = Array.from({ length: 12 }, () => async () => {
      peak = Math.max(peak, ++active)
      await new Promise(resolve => setTimeout(resolve, 5))
      active--
    })

    await runWithConcurrency(tasks, 3)

    expect(peak).toBe(3)
    expect(active).toBe(0)
  })

  it('runs every task even when one rejects', async () => {
    const ran: number[] = []
    const tasks = [0, 1, 2, 3].map(i => async () => {
      ran.push(i)
      if (i === 1) throw new Error('boom')
    })

    await runWithConcurrency(tasks, 2)

    expect(ran.sort()).toEqual([0, 1, 2, 3])
  })

  it('treats a limit below 1 as serial rather than spawning no workers', async () => {
    const ran: number[] = []
    await runWithConcurrency([0, 1].map(i => async () => { ran.push(i) }), 0)
    expect(ran).toEqual([0, 1])
  })

  it('resolves on an empty task list', async () => {
    await expect(runWithConcurrency([], 4)).resolves.toBeUndefined()
  })
})

describe('backtrace config', () => {
  it('defaults to startup-only scanning with a bounded fan-out', () => {
    const parsed = BacktraceConfigSchema.parse({})
    expect(parsed).toEqual({ enabled: false, interval_min: 0, concurrency: 2 })
  })

  it('keeps a config written before interval_min existed valid', () => {
    const parsed = ConfigSchema.parse({ backtrace: { enabled: true } })
    expect(parsed.backtrace.interval_min).toBe(0)
    expect(parsed.backtrace.concurrency).toBe(2)
  })

  it('rejects a negative interval', () => {
    expect(() => BacktraceConfigSchema.parse({ interval_min: -1 })).toThrow()
  })

  it('rejects a concurrency of zero', () => {
    expect(() => BacktraceConfigSchema.parse({ concurrency: 0 })).toThrow()
  })
})
