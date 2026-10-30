import { PassThrough } from 'node:stream'
import { describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { openCodeModelArgs, openCodeStreamError, openCodeProviderLimit, runOpenCode } from '../reviewers/opencode-process.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const quota = JSON.stringify({ type: 'error', error: { name: 'APIError', data: { message: 'Free usage limit reached' } } })

describe('OpenCode process failures', () => {
  it('reads provider failures, ignoring nested events in agent text', () => {
    expect(openCodeStreamError(JSON.stringify({ type: 'text', part: { text: quota } }))).toBeUndefined()
    expect(openCodeStreamError(`noise\n${quota}\n`)).toBe('Free usage limit reached')
    expect(openCodeStreamError('{"type":"error","error":{"message":"Unauthorized"}}')).toBe('Unauthorized')
  })

  it('stops internal quota retries from structured provider logs only', async () => {
    const log = 'timestamp=2026-10-29T04:22:47.080Z level=ERROR run=823442ff message="stream error" providerID=opencode error.error="AI_APICallError: Free usage limit reached"\n'
    expect(openCodeProviderLimit('tool output: Free usage limit reached')).toBeUndefined()
    expect(openCodeProviderLimit(log)).toBe('Free usage limit reached')
    const stderr = new PassThrough()
    let rejectChild!: (error: Error) => void
    const child = Object.assign(new Promise((_resolve, reject) => { rejectChild = reject }), {
      stderr,
      kill: vi.fn(() => rejectChild(new Error('terminated'))),
    })
    vi.mocked(execa).mockReturnValue(child as never)
    const outcome = expect(runOpenCode([], {})).rejects.toMatchObject({ message: 'Free usage limit reached', exitCode: 1 })
    stderr.write(log)
    await outcome
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(stderr.listenerCount('data')).toBe(0)
  })

  it('rejects an error event even when the CLI exits zero', async () => {
    vi.mocked(execa).mockReturnValue(Promise.resolve({ stdout: quota, stderr: '' }) as never)
    await expect(runOpenCode([], {})).rejects.toThrow('Free usage limit reached')
  })

  it('stops a hanging child on a chunked terminal error and preserves the reason', async () => {
    const stdout = new PassThrough()
    let rejectChild!: (error: Error) => void
    const child = Object.assign(new Promise((_resolve, reject) => { rejectChild = reject }), {
      stdout,
      kill: vi.fn(() => rejectChild(new Error('terminated'))),
    })
    vi.mocked(execa).mockReturnValue(child as never)
    const outcome = expect(runOpenCode([], {})).rejects.toMatchObject({ message: 'Free usage limit reached', exitCode: 1 })
    stdout.write(quota.slice(0, 15))
    expect(child.kill).not.toHaveBeenCalled()
    stdout.write(quota.slice(15) + '\n')
    await outcome
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(stdout.listenerCount('data')).toBe(0)
  })

  it('keeps real timeouts and successful output intact', async () => {
    const timeout = Object.assign(new Error('timed out'), { timedOut: true, stdout: '' })
    vi.mocked(execa).mockReturnValue(Promise.reject(timeout) as never)
    await expect(runOpenCode([], {})).rejects.toBe(timeout)
    vi.mocked(execa).mockReturnValue(Promise.resolve({ stdout: '{"type":"text"}', stderr: '' }) as never)
    await expect(runOpenCode([], {})).resolves.toEqual({ stdout: '{"type":"text"}', stderr: '' })
  })
})

describe('OpenCode model arguments', () => {
  it('uses V1 --variant and V2 #variant syntax', () => {
    expect(openCodeModelArgs('provider/model', 'high', false)).toEqual(['--model', 'provider/model', '--variant', 'high'])
    expect(openCodeModelArgs('provider/model', 'max', true)).toEqual(['--model', 'provider/model#max'])
    expect(openCodeModelArgs(undefined, 'high', false)).toEqual([])
  })
})
