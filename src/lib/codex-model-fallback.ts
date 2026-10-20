import { log as fileLog } from './logger.js'
import { CODEX_TIER_MODELS_API, CODEX_TIER_MODELS_SUBSCRIPTION } from './review-models.js'

const TIERS = ['fast', 'balanced', 'thorough'] as const

const rejectedModels = new Set<string>()

export function resetCodexModelRejections(): void {
  rejectedModels.clear()
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

// Only trust the CLI's top-level JSONL terminal event. Stderr, execa's message,
// and nested agent text can all contain content copied from the PR under review.
export function codexTurnFailureMessage(jsonl: unknown): string | null {
  if (typeof jsonl !== 'string') return null
  let message: string | null = null
  for (const line of jsonl.split('\n')) {
    let event: unknown
    try { event = JSON.parse(line) } catch { continue }
    if (!isRecord(event) || event.type !== 'turn.failed' || !isRecord(event.error)) continue
    if (typeof event.error.message === 'string') message = event.error.message
  }
  return message
}

export function codexModelRejection(err: unknown): string | null {
  const e = err as { codexJsonl?: unknown }
  const detail = codexTurnFailureMessage(e?.codexJsonl)
  return detail && /model is not supported|model_not_found|model `?[^ ]+`? does not exist/i.test(detail)
    ? detail
    : null
}

// Keep the machine-readable stream on execa errors so the fallback classifier
// can inspect a CLI event without trusting stderr or an echoed prompt.
export async function withCodexJsonlOutput<T>(run: () => Promise<T>): Promise<T> {
  try {
    return await run()
  } catch (err) {
    const stdout = (err as { stdout?: unknown } | null)?.stdout
    if (typeof stdout === 'string') {
      const wrapped = err instanceof Error ? err : new Error(String(err))
      Object.assign(wrapped, { codexJsonl: stdout })
      throw wrapped
    }
    throw err
  }
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
