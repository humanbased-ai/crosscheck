import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  codexFallbackModel,
  codexModelRejection,
  resetCodexModelRejections,
  withCodexModelFallback,
} from '../lib/codex-model-fallback.js'

const REJECTION = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`

function codexFailure(stderr: string): Error {
  return Object.assign(new Error('Command failed with exit code 1: codex exec'), { stderr })
}

beforeEach(() => { resetCodexModelRejections() })

describe('codexModelRejection', () => {
  it('returns the ERROR line when codex refuses the model', () => {
    expect(codexModelRejection(codexFailure(`OpenAI Codex v0.155.1\nmodel: gpt-6.1-sol\n${REJECTION}`))).toBe(REJECTION)
  })

  it('ignores the same wording when it only appears in the echoed prompt', () => {
    const stderr = 'user\n+ throw new Error("model is not supported")\nERROR: stream disconnected before completion'
    expect(codexModelRejection(codexFailure(stderr))).toBeNull()
  })
})

describe('codexFallbackModel', () => {
  it('maps a rejected API tier model to the subscription model of the same tier', () => {
    expect(codexFallbackModel('gpt-6.1-sol')).toBe('gpt-6-sol')
  })

  it('falls back to the CLI default for a model with no subscription twin', () => {
    expect(codexFallbackModel('gpt-6-sol')).toBe('default')
  })

  it('has nothing left once the CLI default is rejected', () => {
    expect(codexFallbackModel('default')).toBeNull()
  })
})

describe('withCodexModelFallback', () => {
  it('retries a rejected model on its subscription twin and returns that result', async () => {
    const run = vi.fn(async (model: string) => {
      if (model === 'gpt-6.1-sol') throw codexFailure(REJECTION)
      return `reviewed with ${model}`
    })
    const notices: string[] = []

    await expect(withCodexModelFallback('gpt-6.1-sol', 'review', run, msg => notices.push(msg))).resolves.toBe('reviewed with gpt-6-sol')
    expect(run.mock.calls.map(call => call[0])).toEqual(['gpt-6.1-sol', 'gpt-6-sol'])
    expect(notices).toEqual(['  codex rejected model gpt-6.1-sol — retrying review with gpt-6-sol'])
  })

  it('skips a model already rejected in this process', async () => {
    const run = vi.fn(async (model: string) => {
      if (model === 'gpt-6.1-sol') throw codexFailure(REJECTION)
      return model
    })
    await withCodexModelFallback('gpt-6.1-sol', 'review', run)
    run.mockClear()

    await withCodexModelFallback('gpt-6.1-sol', 'fix', run)
    expect(run.mock.calls.map(call => call[0])).toEqual(['gpt-6-sol'])
  })

  it('walks down to the CLI default when the twin is rejected too', async () => {
    const run = vi.fn(async (model: string) => {
      if (model !== 'default') throw codexFailure(REJECTION)
      return model
    })
    await expect(withCodexModelFallback('gpt-6.1-sol', 'review', run)).resolves.toBe('default')
    expect(run.mock.calls.map(call => call[0])).toEqual(['gpt-6.1-sol', 'gpt-6-sol', 'default'])
  })

  it('rethrows an error that is not a model rejection without retrying', async () => {
    const run = vi.fn(async () => { throw codexFailure('ERROR: stream disconnected before completion') })
    await expect(withCodexModelFallback('gpt-6.1-sol', 'review', run)).rejects.toThrow('Command failed')
    expect(run).toHaveBeenCalledTimes(1)
  })

  it('rethrows the rejection when the CLI default is refused', async () => {
    const run = vi.fn(async () => { throw codexFailure(REJECTION) })
    await expect(withCodexModelFallback('default', 'review', run)).rejects.toThrow('Command failed')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
