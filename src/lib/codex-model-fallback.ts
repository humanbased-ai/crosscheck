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
