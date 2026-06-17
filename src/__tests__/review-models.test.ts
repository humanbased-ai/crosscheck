import { describe, it, expect } from 'vitest'
import { modelDisplayName, primaryModelFromUsage, resolveClaudeModel, resolveCodexModel } from '../lib/review-models.js'
import type { CodexVendorConfig, QualityConfig, VendorConfig } from '../config/schema.js'

const quality = (tier: QualityConfig['tier']): QualityConfig => ({
  tier,
  focus: [],
})

const codexVendor = (auth: CodexVendorConfig['auth'], model: string | null = null): CodexVendorConfig => ({
  enabled: true,
  auth,
  model,
  effort: 'medium',
  quality: 'medium',
  timeout_sec: null,
})

const claudeVendor = (model: string | null = null, auth: VendorConfig['auth'] = 'subscription'): VendorConfig => ({
  enabled: true,
  auth,
  model,
  effort: 'medium',
  timeout_sec: null,
})

describe('review model resolution', () => {
  it('resolves Claude models by tier', () => {
    expect(resolveClaudeModel(quality('fast'))).toBe('claude-haiku-4-5-20251001')
    expect(resolveClaudeModel(quality('balanced'))).toBe('claude-sonnet-4-6')
    expect(resolveClaudeModel(quality('thorough'))).toBe('claude-opus-4-7')
  })

  it('honors an explicit vendors.claude.model over the tier mapping', () => {
    // Regression for #176: vendors.claude.model was silently ignored.
    expect(resolveClaudeModel(quality('balanced'), claudeVendor('opus'))).toBe('opus')
    expect(resolveClaudeModel(quality('fast'), claudeVendor('claude-opus-4-7'))).toBe('claude-opus-4-7')
    // Honored under both auth modes (claude CLI accepts --model for subscription too).
    expect(resolveClaudeModel(quality('thorough'), claudeVendor('sonnet', 'api-key'))).toBe('sonnet')
  })

  it('falls back to the tier mapping when vendors.claude.model is unset', () => {
    expect(resolveClaudeModel(quality('thorough'), claudeVendor(null))).toBe('claude-opus-4-7')
  })

  it('resolves Codex API-key models by tier and configured override', () => {
    expect(resolveCodexModel(quality('fast'), codexVendor('api-key'))).toBe('gpt-4o-mini')
    expect(resolveCodexModel(quality('balanced'), codexVendor('api-key'))).toBe('o4-mini')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key'))).toBe('o3')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key', 'custom-model'))).toBe('custom-model')
  })

  it('uses default for Codex subscription auth', () => {
    expect(resolveCodexModel(quality('thorough'), codexVendor('subscription'))).toBe('default')
    expect(modelDisplayName('default')).toBeNull()
  })

  it('derives display names for current claude and codex models', () => {
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelDisplayName('claude-opus-4-7')).toBe('Opus 4.7')
    expect(modelDisplayName('claude-sonnet-4-6')).toBe('Sonnet 4.6')
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelDisplayName('o4-mini')).toBe('o4-mini')
    expect(modelDisplayName('o3')).toBe('o3')
    expect(modelDisplayName('gpt-4o-mini')).toBe('gpt-4o-mini')
  })

  it('derives display names for future claude models without code changes', () => {
    expect(modelDisplayName('claude-opus-4-9')).toBe('Opus 4.9')
    expect(modelDisplayName('claude-fable-5')).toBe('Fable 5')
    expect(modelDisplayName('claude-fable-5-1')).toBe('Fable 5.1')
    expect(modelDisplayName('claude-nova-6-2-20270101')).toBe('Nova 6.2')
  })

  it('falls back to the raw ID for IDs outside the regular claude shape', () => {
    expect(modelDisplayName('claude-3-5-sonnet-20241022')).toBe('claude-3-5-sonnet-20241022')
    expect(modelDisplayName('some-custom-model')).toBe('some-custom-model')
  })
})

describe('primaryModelFromUsage', () => {
  it('extracts the model ID from a single-model usage block', () => {
    expect(primaryModelFromUsage({
      'claude-opus-4-8': { inputTokens: 10, outputTokens: 500, costUSD: 0.07 },
    })).toBe('claude-opus-4-8')
  })

  it('picks the model with the most output tokens when several appear', () => {
    expect(primaryModelFromUsage({
      'claude-haiku-4-5-20251001': { outputTokens: 80 },
      'claude-sonnet-4-6': { outputTokens: 4200 },
    })).toBe('claude-sonnet-4-6')
  })

  it('tolerates entries without numeric outputTokens', () => {
    expect(primaryModelFromUsage({
      'claude-sonnet-4-6': { outputTokens: 'n/a' },
    })).toBe('claude-sonnet-4-6')
  })

  it('returns null for missing or malformed input', () => {
    expect(primaryModelFromUsage(undefined)).toBeNull()
    expect(primaryModelFromUsage(null)).toBeNull()
    expect(primaryModelFromUsage('claude-opus-4-8')).toBeNull()
    expect(primaryModelFromUsage(42)).toBeNull()
    expect(primaryModelFromUsage({})).toBeNull()
    // Arrays pass typeof === 'object' but their keys are indices, not model IDs
    expect(primaryModelFromUsage([{ outputTokens: 100 }])).toBeNull()
  })
})
