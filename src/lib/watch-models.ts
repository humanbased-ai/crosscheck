import type { Config, QualityConfig } from '../config/schema.js'
import { scanAgentModels, type AgentModelScan } from './agent-model-scan.js'
import { reviewCost, reviewModelExcluded } from './review-selection.js'

type Pools = NonNullable<QualityConfig['review_models']>

export function refreshFreeModelPool(config: Config, scans: AgentModelScan[]): Pools {
  const pools = { ...config.quality.review_models }
  if (!config.vendors.opencode.enabled) return pools
  const scan = scans.find(entry => entry.vendor === 'opencode')
  if (!scan || !scan.installed || scan.warnings.length > 0) return pools
  const available = scan.models.filter(model => !model.excluded && !reviewModelExcluded(model.id) && !config.quality.excluded_models?.includes(model.id))
  const existing = pools.opencode ?? []
  const updated = existing.flatMap(model => {
    const current = available.find(entry => entry.id === model.id)
    // A free listing must never turn into a paid opt-in through refresh.
    if (!current) return reviewCost(model) === 0 || model.auto_free ? [] : [model]
    if ((reviewCost(model) === 0 || model.auto_free) && reviewCost({ ...current, model_class: model.model_class }) !== 0) return []
    const { excluded: _excluded, ...metadata } = current
    return [{ ...metadata, model_class: model.model_class, ...(model.auto_free && { auto_free: true }) }]
  })
  for (const entry of available) {
    if (!entry.model_class || entry.input_usd_mtok !== 0 || entry.output_usd_mtok !== 0 || updated.some(model => model.id === entry.id)) continue
    const { excluded: _excluded, ...metadata } = entry
    updated.push({ ...metadata, model_class: entry.model_class, auto_free: true })
  }
  // Only materialise an empty pool when one already existed. Writing `[]` for a
  // vendor that never had a pool would disable a model_tiers-only OpenCode setup.
  if (pools.opencode !== undefined || updated.length > 0) pools.opencode = updated
  return pools
}

/** Metadata refresh is single-flight; each review receives an immutable config snapshot. */
export class WatchModelDiscovery {
  private cached?: { key: string; expires: number; pools: Pools }
  private pending?: { key: string; promise: Promise<Pools> }
  constructor(
    private readonly scan: () => Promise<AgentModelScan[]> = scanAgentModels,
    private readonly now: () => number = Date.now,
    private readonly report: (message: string) => void = message => console.warn(message),
  ) {}

  async snapshot(config: Config): Promise<Config> {
    if (!config.quality.refresh_free_models || !config.vendors.opencode.enabled) return config
    const key = JSON.stringify({ pools: config.quality.review_models, excluded: config.quality.excluded_models, enabled: config.vendors.opencode.enabled })
    if (this.cached?.key === key && this.cached.expires > this.now()) {
      return { ...config, quality: { ...config.quality, review_models: this.cached.pools } }
    }
    if (this.pending?.key !== key) {
      const promise = this.scan().then(scans => refreshFreeModelPool(config, scans)).catch(() => {
        this.report('Model metadata refresh failed; retaining the last configured inventory. Run ck init to diagnose.')
        return config.quality.review_models ?? {}
      })
      this.pending = { key, promise }
    }
    const pending = this.pending
    const pools = await pending.promise
    if (this.pending === pending) {
      this.cached = { key, pools, expires: this.now() + (config.quality.model_refresh_sec ?? 900) * 1000 }
      this.pending = undefined
    }
    return { ...config, quality: { ...config.quality, review_models: pools } }
  }
}
