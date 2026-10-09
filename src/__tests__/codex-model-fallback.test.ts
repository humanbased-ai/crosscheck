import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import {
  codexFallbackModel,
  codexModelRejection,
  reconcileCodexModels,
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

describe('reconcileCodexModels', () => {
  let dir: string
  let configPath: string

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'crosscheck-reconcile-'))
    configPath = join(dir, 'config.yml')
    vi.spyOn(console, 'log').mockImplementation(() => undefined)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    rmSync(dir, { recursive: true, force: true })
  })

  function codexSection(): Record<string, unknown> {
    return (yaml.load(readFileSync(configPath, 'utf8')) as { vendors: { codex: Record<string, unknown> } }).vendors.codex
  }

  it('rewrites the API tier map an earlier onboard wrote under subscription auth', () => {
    writeFileSync(configPath, yaml.dump({
      mode: 'cross-vendor',
      vendors: { codex: { auth: 'subscription', model_tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-sol', thorough: 'gpt-6-astra' } } },
    }))

    expect(reconcileCodexModels(configPath)).toEqual([
      { key: 'vendors.codex.model_tiers.balanced', from: 'gpt-6.1-sol', to: 'gpt-6-sol' },
    ])
    expect(codexSection().model_tiers).toEqual({ fast: 'gpt-6-luna', balanced: 'gpt-6-sol', thorough: 'gpt-6-astra' })
    expect((yaml.load(readFileSync(configPath, 'utf8')) as { mode: string }).mode).toBe('cross-vendor')
  })

  it('rewrites a pinned API-only model when auth is left at its subscription default', () => {
    writeFileSync(configPath, yaml.dump({ vendors: { codex: { model: 'gpt-6.1-sol' } } }))

    expect(reconcileCodexModels(configPath)).toEqual([{ key: 'vendors.codex.model', from: 'gpt-6.1-sol', to: 'gpt-6-sol' }])
    expect(codexSection().model).toBe('gpt-6-sol')
  })

  it('leaves an api-key config untouched', () => {
    const original = yaml.dump({ vendors: { codex: { auth: 'api-key', model_tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-sol', thorough: 'gpt-6-astra' } } } })
    writeFileSync(configPath, original)

    expect(reconcileCodexModels(configPath)).toEqual([])
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('leaves a hand-chosen model untouched', () => {
    const original = yaml.dump({ vendors: { codex: { auth: 'subscription', model_tiers: { fast: 'gpt-5.6-luna', balanced: 'gpt-5.6-sol', thorough: 'gpt-5.6-terra' } } } })
    writeFileSync(configPath, original)

    expect(reconcileCodexModels(configPath)).toEqual([])
    expect(readFileSync(configPath, 'utf8')).toBe(original)
  })

  it('does nothing when no config file exists', () => {
    expect(reconcileCodexModels(join(dir, 'missing.yml'))).toEqual([])
    expect(reconcileCodexModels(null)).toEqual([])
  })
})
