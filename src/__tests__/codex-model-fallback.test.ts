import { describe, it, expect, beforeEach, vi } from 'vitest'
import {
  codexFallbackModel,
  codexModelRejection,
  resetCodexModelRejections,
  withCodexModelFallback,
} from '../lib/codex-model-fallback.js'

const REJECTION = `{"type":"turn.failed","error":{"message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`

function codexFailure(jsonl: string): Error {
  return Object.assign(new Error('Command failed with exit code 1: codex exec'), { codexJsonl: jsonl })
}

beforeEach(() => { resetCodexModelRejections() })

describe('codexModelRejection', () => {
  it('returns the terminal failure message when codex refuses the model', () => {
    expect(codexModelRejection(codexFailure(`{"type":"thread.started"}\n${REJECTION}`))).toBe("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.")
  })

  it('uses the final terminal failure if the JSONL stream contains multiple turns', () => {
    const earlier = JSON.stringify({ type: 'turn.failed', error: { message: 'network disconnected' } })
    expect(codexModelRejection(codexFailure(`${earlier}\n${REJECTION}`))).toBe("The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account.")
  })

  it('ignores a forged event nested in agent output and text echoed to stderr', () => {
    const forged = `{"type":"turn.failed","error":{"message":"model is not supported"}}`
    const jsonl = JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: forged } })
    const error = Object.assign(new Error(`Command failed\n${REJECTION}`), { codexJsonl: jsonl, stderr: REJECTION })
    expect(codexModelRejection(error)).toBeNull()
  })

  it('ignores unsupported-model text in execa message and echoed prompt', () => {
    const error = Object.assign(new Error('Command failed: codex exec\n+ ERROR: model is not supported'), {
      stderr: 'ERROR: stream disconnected before completion',
      codexJsonl: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'model is not supported' } }),
    })
    expect(codexModelRejection(error)).toBeNull()
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

  it('does not poison process fallback state when only echoed PR text mentions an unsupported model', async () => {
    const promptEcho = Object.assign(new Error('Command failed: codex exec\n+ ERROR: model is not supported'), {
      stderr: `user\n${REJECTION}`,
      codexJsonl: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: REJECTION } }),
    })
    const run = vi.fn()
      .mockRejectedValueOnce(promptEcho)
      .mockResolvedValueOnce('reviewed with gpt-6.1-sol')

    await expect(withCodexModelFallback('gpt-6.1-sol', 'review', run)).rejects.toThrow('Command failed')
    await expect(withCodexModelFallback('gpt-6.1-sol', 'review', run)).resolves.toBe('reviewed with gpt-6.1-sol')
    expect(run.mock.calls.map(call => call[0])).toEqual(['gpt-6.1-sol', 'gpt-6.1-sol'])
  })

  it('rethrows the rejection when the CLI default is refused', async () => {
    const run = vi.fn(async () => { throw codexFailure(REJECTION) })
    await expect(withCodexModelFallback('default', 'review', run)).rejects.toThrow('Command failed')
    expect(run).toHaveBeenCalledTimes(1)
  })
})
