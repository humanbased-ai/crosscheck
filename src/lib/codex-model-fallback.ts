import { existsSync, readFileSync, writeFileSync } from 'fs'
import yaml from 'js-yaml'
import { log as fileLog } from './logger.js'
import { CODEX_TIER_MODELS_API, CODEX_TIER_MODELS_SUBSCRIPTION } from './review-models.js'

const TIERS = ['fast', 'balanced', 'thorough'] as const

const rejectedModels = new Set<string>()

export function resetCodexModelRejections(): void {
  rejectedModels.clear()
}

// Only `ERROR:` lines count. codex echoes the prompt to stderr and execa puts
// the argv in the message, so the surrounding text carries the diff under
// review — which can itself say "model is not supported".
export function codexModelRejection(err: unknown): string | null {
  const e = err as { stderr?: unknown; message?: unknown }
  const text = [e?.stderr, e?.message].filter((part): part is string => typeof part === 'string').join('\n')
  for (const line of text.split('\n')) {
    const at = line.indexOf('ERROR:')
    if (at === -1) continue
    const detail = line.slice(at)
    if (/model is not supported|model_not_found|model `?[^ ]+`? does not exist/i.test(detail)) return detail.trim()
  }
  return null
}

function subscriptionTwin(model: string): string | undefined {
  const tier = TIERS.find(t => CODEX_TIER_MODELS_API[t] === model)
  const twin = tier ? CODEX_TIER_MODELS_SUBSCRIPTION[tier] : undefined
  return twin && twin !== model ? twin : undefined
}

// Rejected model -> the subscription-compatible model of the same tier, then
// the CLI's own default (no -c model). null means nothing is left to try.
export function codexFallbackModel(model: string): string | null {
  if (model === 'default') return null
  const twin = subscriptionTwin(model)
  if (twin && !rejectedModels.has(twin)) return twin
  return 'default'
}

export async function withCodexModelFallback<T>(
  model: string,
  step: string,
  run: (model: string) => Promise<T>,
  onFallback?: (msg: string) => void,
): Promise<T> {
  let current = model
  while (rejectedModels.has(current)) {
    const next = codexFallbackModel(current)
    if (!next) break
    current = next
  }
  for (;;) {
    try {
      return await run(current)
    } catch (err) {
      const rejection = codexModelRejection(err)
      const next = rejection ? codexFallbackModel(current) : null
      if (!rejection || !next) throw err
      rejectedModels.add(current)
      onFallback?.(`  codex rejected model ${current} — retrying ${step} with ${next}`)
      fileLog({ level: 'warn', event: 'codex_model_fallback', step, rejected_model: current, fallback_model: next, reason: rejection })
      current = next
    }
  }
}

export interface CodexModelReconcileChange { key: string; from: string; to: string }

// An earlier onboard wrote the API tier map into every config. Under
// subscription auth those IDs are replaced with their subscription twins; a
// value that is not a shipped API default was chosen by the user and is kept.
export function reconcileCodexModels(configPath: string | null): CodexModelReconcileChange[] {
  if (!configPath || !existsSync(configPath)) return []
  const raw = yaml.load(readFileSync(configPath, 'utf8'))
  if (!raw || typeof raw !== 'object') return []
  const codex = (raw as { vendors?: { codex?: Record<string, unknown> } }).vendors?.codex
  if (!codex || typeof codex !== 'object' || codex.auth === 'api-key') return []

  const changes: CodexModelReconcileChange[] = []
  if (typeof codex.model === 'string') {
    const twin = subscriptionTwin(codex.model)
    if (twin) {
      changes.push({ key: 'vendors.codex.model', from: codex.model, to: twin })
      codex.model = twin
    }
  }
  const tiers = codex.model_tiers
  if (tiers && typeof tiers === 'object') {
    const tierMap = tiers as Record<string, unknown>
    for (const tier of TIERS) {
      const configured = tierMap[tier]
      if (configured !== CODEX_TIER_MODELS_API[tier] || configured === CODEX_TIER_MODELS_SUBSCRIPTION[tier]) continue
      changes.push({ key: `vendors.codex.model_tiers.${tier}`, from: String(configured), to: CODEX_TIER_MODELS_SUBSCRIPTION[tier] })
      tierMap[tier] = CODEX_TIER_MODELS_SUBSCRIPTION[tier]
    }
  }
  if (changes.length === 0) return []

  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
  for (const change of changes) {
    console.log(`  updated ${change.key}: ${change.from} → ${change.to} (${change.from} is not available to a ChatGPT-account codex login)`)
  }
  return changes
}
