import { createRequire } from 'module'
import { z } from 'zod'
import type { CodexVendorConfig, QualityConfig, VendorConfig } from '../config/schema.js'

const require = createRequire(import.meta.url)

const TierModelSchema = z.object({
  fast: z.string(),
  balanced: z.string(),
  thorough: z.string(),
})

const ReviewModelTierConfigSchema = z.object({
  claude: TierModelSchema,
  codex_api: TierModelSchema,
})

const rawReviewModelTierConfig: unknown = require('../config/review-model-tiers.json')
const reviewModelTierConfig = ReviewModelTierConfigSchema.parse(rawReviewModelTierConfig)

export const CLAUDE_TIER_MODELS: Record<QualityConfig['tier'], string> = reviewModelTierConfig.claude
export const CODEX_TIER_MODELS_API: Record<QualityConfig['tier'], string> = reviewModelTierConfig.codex_api

/**
 * The tier in force for one call. Under `quality.mode: 'smart'` the per-PR
 * strategy wins; otherwise the single configured tier applies. Falls back to the
 * configured tier whenever no strategy resolved — one-shot commands, or a PR
 * whose file list could not be read.
 */
export function effectiveTier(
  quality: QualityConfig,
  strategy?: { tier: QualityConfig['tier'] | null } | null,
): QualityConfig['tier'] {
  if (quality.mode === 'smart' && strategy?.tier) return strategy.tier
  return quality.tier
}

export function resolveClaudeModel(
  quality: QualityConfig,
  vendor?: VendorConfig,
  strategy?: { tier: QualityConfig['tier'] | null } | null,
): string {
  // An explicit vendors.claude.model wins over the tier mapping. The claude CLI
  // accepts --model under both subscription and api-key auth, so we honor it
  // regardless of auth instead of silently dropping it.
  if (vendor?.model) return vendor.model
  return CLAUDE_TIER_MODELS[effectiveTier(quality, strategy)] ?? CLAUDE_TIER_MODELS.balanced
}

export function resolveCodexModel(
  quality: QualityConfig,
  vendor: CodexVendorConfig,
  strategy?: { tier: QualityConfig['tier'] | null } | null,
): string {
  const tier = effectiveTier(quality, strategy)
  // An explicitly configured model wins under either auth — the codex CLI
  // accepts -c model= with subscription (ChatGPT) auth too. Only the built-in
  // tier mapping stays api-key-only: with nothing configured, subscription
  // users keep the CLI's own default model, because the gpt-5.6-* IDs need
  // codex >= 0.147.0 and would 400 on an older CLI.
  const explicit = vendor.model || vendor.model_tiers?.[tier]
  if (explicit) return explicit
  if (vendor.auth !== 'api-key') return 'default'
  return CODEX_TIER_MODELS_API[tier] || CODEX_TIER_MODELS_API.balanced
}

// Derives a display name from the regular claude model ID shape:
// claude-{family}-{major}[-{minor}][-YYYYMMDD]. New models then render
// nicely without code changes. Returns null when the shape differs
// (e.g. old-style claude-3-5-sonnet-20241022 or codex IDs like gpt-5.6-sol),
// in which case the raw ID is displayed as-is.
function claudePrettyName(model: string): string | null {
  const m = /^claude-([a-z]+)-(\d+)(?:-(\d+))?(?:-\d{8})?$/.exec(model)
  if (!m) return null
  const family = m[1][0].toUpperCase() + m[1].slice(1)
  return m[3] ? `${family} ${m[2]}.${m[3]}` : `${family} ${m[2]}`
}

export function modelDisplayName(model: string): string | null {
  if (model === 'default') return null
  return claudePrettyName(model) ?? model
}

// Extracts the model that actually served the session from the claude CLI's
// `modelUsage` JSON field (keyed by full model ID). The requested model may be
// an alias ("opus") or be substituted by the CLI, so this is the ground truth.
// When several models appear (e.g. a helper model alongside the main one), the
// one with the most output tokens is the reviewer. Returns null when the field
// is missing or malformed.
export function primaryModelFromUsage(modelUsage: unknown): string | null {
  // Arrays pass typeof === 'object' but their Object.entries keys are indices,
  // not model IDs — reject them explicitly.
  if (modelUsage === null || typeof modelUsage !== 'object' || Array.isArray(modelUsage)) return null
  let best: string | null = null
  // -1 (not 0) so the first entry still wins when no entry has numeric tokens.
  let bestTokens = -1
  for (const [id, usage] of Object.entries(modelUsage)) {
    const out = (usage as { outputTokens?: unknown } | null)?.outputTokens
    const tokens = typeof out === 'number' ? out : 0
    if (tokens > bestTokens) {
      bestTokens = tokens
      best = id
    }
  }
  return best
}
