import { describe, it, expect } from 'vitest'
import { modelDisplayName, primaryModelFromUsage, resolveClaudeModel, resolveCodexModel } from '../lib/review-models.js'
import type { CodexVendorConfig, QualityConfig, VendorConfig } from '../config/schema.js'

const quality = (tier: QualityConfig['tier']): QualityConfig => ({
  tier,
  mode: 'fixed',
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
    expect(resolveClaudeModel(quality('balanced'))).toBe('claude-sonnet-5')
    expect(resolveClaudeModel(quality('thorough'))).toBe('claude-opus-4-8')
  })

  it('honors an explicit vendors.claude.model over the tier mapping', () => {
    // Regression for #176: vendors.claude.model was silently ignored.
    expect(resolveClaudeModel(quality('balanced'), claudeVendor('opus'))).toBe('opus')
    expect(resolveClaudeModel(quality('fast'), claudeVendor('claude-opus-4-8'))).toBe('claude-opus-4-8')
    // Honored under both auth modes (claude CLI accepts --model for subscription too).
    expect(resolveClaudeModel(quality('thorough'), claudeVendor('sonnet', 'api-key'))).toBe('sonnet')
  })

  it('falls back to the tier mapping when vendors.claude.model is unset', () => {
    expect(resolveClaudeModel(quality('thorough'), claudeVendor(null))).toBe('claude-opus-4-8')
  })

  it('resolves Codex API-key models by tier and configured override', () => {
    expect(resolveCodexModel(quality('fast'), codexVendor('api-key'))).toBe('gpt-5.6-luna')
    expect(resolveCodexModel(quality('balanced'), codexVendor('api-key'))).toBe('gpt-5.6-terra')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key'))).toBe('gpt-5.6-sol')
    expect(resolveCodexModel(quality('thorough'), codexVendor('api-key', 'custom-model'))).toBe('custom-model')
  })

  it('honors Codex per-tier model overrides when no global model is set', () => {
    const vendor = {
      ...codexVendor('api-key'),
      model_tiers: { thorough: 'custom-thorough-model' },
    }
    expect(resolveCodexModel(quality('thorough'), vendor)).toBe('custom-thorough-model')
    expect(resolveCodexModel(quality('balanced'), vendor)).toBe('gpt-5.6-terra')
  })

  it('uses the CLI default for Codex subscription auth with no model configured', () => {
    expect(resolveCodexModel(quality('thorough'), codexVendor('subscription'))).toBe('default')
    expect(modelDisplayName('default')).toBeNull()
  })

  it('honors an explicit model under Codex subscription auth', () => {
    expect(resolveCodexModel(quality('balanced'), codexVendor('subscription', 'gpt-5.6-sol'))).toBe('gpt-5.6-sol')
  })

  it('honors model_tiers under Codex subscription auth without the built-in fallback', () => {
    const vendor = {
      ...codexVendor('subscription'),
      model_tiers: { thorough: 'custom-thorough-model' },
    }
    expect(resolveCodexModel(quality('thorough'), vendor)).toBe('custom-thorough-model')
    // Tiers without an explicit entry stay on the CLI default — the built-in
    // tier mapping applies to api-key auth only.
    expect(resolveCodexModel(quality('balanced'), vendor)).toBe('default')
  })

  it('derives display names for current claude and codex models', () => {
    expect(modelDisplayName('claude-opus-4-8')).toBe('Opus 4.8')
    expect(modelDisplayName('claude-opus-4-7')).toBe('Opus 4.7')
    expect(modelDisplayName('claude-sonnet-5')).toBe('Sonnet 5')
    expect(modelDisplayName('claude-haiku-4-5-20251001')).toBe('Haiku 4.5')
    expect(modelDisplayName('gpt-5.6-luna')).toBe('gpt-5.6-luna')
    expect(modelDisplayName('gpt-5.6-terra')).toBe('gpt-5.6-terra')
    expect(modelDisplayName('gpt-5.6-sol')).toBe('gpt-5.6-sol')
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
      'claude-sonnet-5': { outputTokens: 4200 },
    })).toBe('claude-sonnet-5')
  })

  it('tolerates entries without numeric outputTokens', () => {
    expect(primaryModelFromUsage({
      'claude-sonnet-5': { outputTokens: 'n/a' },
    })).toBe('claude-sonnet-5')
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
