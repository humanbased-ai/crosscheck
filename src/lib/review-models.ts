import type { CodexVendorConfig, QualityConfig, VendorConfig } from '../config/schema.js'

export const CLAUDE_TIER_MODELS: Record<string, string> = {
  fast: 'claude-haiku-4-5-20251001',
  balanced: 'claude-sonnet-4-6',
  thorough: 'claude-opus-4-7',
}

export const CODEX_TIER_MODELS_API: Record<string, string> = {
  fast: 'gpt-4o-mini',
  balanced: 'o4-mini',
  thorough: 'o3',
}

export function resolveClaudeModel(quality: QualityConfig, vendor?: VendorConfig): string {
  // An explicit vendors.claude.model wins over the tier mapping. The claude CLI
  // accepts --model under both subscription and api-key auth (unlike Codex), so
  // we honor it regardless of auth instead of silently dropping it.
  if (vendor?.model) return vendor.model
  return CLAUDE_TIER_MODELS[quality.tier] ?? CLAUDE_TIER_MODELS.balanced
}

export function resolveCodexModel(quality: QualityConfig, vendor: CodexVendorConfig): string {
  if (vendor.auth !== 'api-key') return 'default'
  return vendor.model || CODEX_TIER_MODELS_API[quality.tier] || CODEX_TIER_MODELS_API.balanced
}

// Derives a display name from the regular claude model ID shape:
// claude-{family}-{major}[-{minor}][-YYYYMMDD]. New models then render
// nicely without code changes. Returns null when the shape differs
// (e.g. old-style claude-3-5-sonnet-20241022 or codex IDs like o4-mini),
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
