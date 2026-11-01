import type { CodexVendorConfig, OpenCodeVendorConfig, QualityConfig, ReviewModel, VendorConfig, Config } from '../config/schema.js'
import { CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../config/schema.js'
import type { Vendor } from './vendor.js'
import { resolveClaudeModel, resolveCodexModel, resolveOpenCodeModel, CODEX_TIER_MODELS_SUBSCRIPTION } from './review-models.js'
import { clampToLevels, isModelBanned, openCodeVariantsFor } from './review-strategy.js'

export function reviewModelExcluded(id: string): boolean {
  const name = id.toLowerCase().split('#')[0]
  if (isModelBanned(name) || isModelBanned(name.split('/').at(-1) ?? name)) return true
  return /(^|[/_.:-])(fable|mythos|opus(?:plan)?|astra|best)([\W_]|$)/.test(name)
    || /kimi-k[3-9]|glm-5(?:\.\d+)?(?![\w.-]*flash)(?:$|[-#:/])|deepseek-[\w.-]*pro|minimax-m[3-9](?:$|[.:/-])|gemini-(?![\w.-]*flash)[\w.-]*(?:pro|argon|ultra)|qwen[\w.-]*max|grok-[4-9]|gpt-[\w.-]*-pro/.test(name)
}

export function reviewModelClass(id: string): ReviewModel['model_class'] | undefined {
  if (reviewModelExcluded(id)) return undefined
  if (/flash|haiku|luna|terra|mini|lite/i.test(id)) return 'fast'
  if (/sonnet|(?:^|-)sol(?:$|[.-])/i.test(id)) return 'standard'
  return undefined
}

export function reviewCost(model: ReviewModel): number {
  if (model.input_usd_mtok === undefined || model.output_usd_mtok === undefined) return Infinity
  return .1 * model.input_usd_mtok + .048 * model.output_usd_mtok
}

/** The exact effort controls a review may send, including the profile ceiling. */
export function reviewEffortLevels(vendor: Vendor, quality: QualityConfig, model: string): string[] {
  if (model.includes('#')) return [] // An explicit OpenCode variant is already fixed.
  const discovered = quality.review_models?.[vendor]?.find(entry => entry.id === model)?.efforts
  const accepted = discovered ?? (vendor === 'claude' ? CLAUDE_EFFORT_LEVELS
    : vendor === 'codex' ? CODEX_EFFORT_LEVELS : openCodeVariantsFor(model) ?? [])
  const ceiling = quality.preference === 'speed-max' ? ['none', 'low', 'medium'] : ['none', 'low', 'medium', 'high']
  return accepted.filter(level => ceiling.includes(level))
}

export function selectReviewModel(
  vendor: Vendor,
  quality: QualityConfig,
  config: VendorConfig | CodexVendorConfig | OpenCodeVendorConfig,
): { model: string; effort?: string } {
  const saved = quality.review_models?.[vendor]
  let model: string
  let candidate: ReviewModel | undefined
  if (config.model && saved === undefined) {
    model = config.model
  } else if (saved !== undefined) {
    const pool = saved.filter(entry => !reviewModelExcluded(entry.id) && !reviewModelExcluded(entry.family ?? ''))
    if (pool.length === 0) throw new Error(`No eligible ${vendor} review models; run ck init.`)
    const preference = quality.preference ?? 'balanced'
    const ordered = [...pool].sort((a, b) => {
      if (preference === 'cost-min') return reviewCost(a) - reviewCost(b) || a.id.localeCompare(b.id)
      return Number(a.model_class === 'standard') - Number(b.model_class === 'standard')
        || reviewCost(a) - reviewCost(b) || a.id.localeCompare(b.id)
    })
    candidate = preference === 'balanced' && quality.tier !== 'fast'
      ? ordered.find(entry => entry.model_class === 'standard') ?? ordered[0]
      : ordered[0]
    model = candidate.id
  } else {
    model = vendor === 'claude' ? resolveClaudeModel(quality, config as VendorConfig)
      : vendor === 'codex' ? resolveCodexModel(quality, config as CodexVendorConfig)
      : resolveOpenCodeModel(quality, config as OpenCodeVendorConfig) ?? 'default'
    if (model === 'default' && vendor === 'codex') model = CODEX_TIER_MODELS_SUBSCRIPTION[quality.tier]
  }
  if (reviewModelExcluded(model) || reviewModelExcluded(candidate?.family ?? '')) {
    throw new Error(`Review model ${model} is excluded by the flagship ceiling; run ck init.`)
  }
  if (saved === undefined && !reviewModelClass(model) && model !== 'default') throw new Error(`Unknown custom review model ${model}; classify its non-flagship deployment with ck init.`)
  // OpenCode keeps working with no pin: 'default' leaves the model configured in
  // opencode.json in charge. Claude resolves a tier model and Codex maps its own
  // default before this point, so only OpenCode reaches it.
  const preference = quality.preference ?? 'balanced'
  let target = quality.tier === 'thorough' ? preference === 'speed-max' ? 'medium' : 'high'
    : quality.tier === 'fast' || preference === 'speed-max' ? 'low' : 'medium'
  if (['high', 'xhigh', 'max', 'ultra'].includes(config.effort)) target = preference === 'speed-max' ? 'medium' : 'high'
  const effort = clampToLevels(target, reviewEffortLevels(vendor, quality, model)) ?? undefined
  return { model, effort }
}


export function eligibleReviewConfig(config: Config): Config {
  const eligible = (vendor: Vendor): boolean => {
    const pool = config.quality.review_models?.[vendor]
    return config.vendors[vendor].enabled && (pool === undefined || pool.some(model => !reviewModelExcluded(model.id) && !reviewModelExcluded(model.family ?? '')))
  }
  const selected = { ...config, vendors: {
    claude: { ...config.vendors.claude, enabled: eligible('claude') },
    codex: { ...config.vendors.codex, enabled: eligible('codex') },
    opencode: { ...config.vendors.opencode, enabled: eligible('opencode') },
  } }
  if (!config.quality.preference) return selected
  const order = [...new Set([...config.agent_priority.review, ...(['codex', 'claude', 'opencode'] as const)])]
  const pool = order.filter(vendor => eligible(vendor) && config.quality.review_models?.[vendor]?.length)
  const chosen = (vendor: Vendor): ReviewModel => {
    const pick = selectReviewModel(vendor, config.quality, { ...config.vendors[vendor], model: null })
    return config.quality.review_models![vendor]!.find(model => model.id === pick.model)!
  }
  pool.sort((a, b) => {
    const first = chosen(a), second = chosen(b)
    const capacity = Number(first.model_class === 'standard') - Number(second.model_class === 'standard')
    const direction = config.quality.preference === 'balanced' && config.quality.tier !== 'fast' ? -1 : 1
    return (config.quality.preference === 'cost-min' ? 0 : direction * capacity) || reviewCost(first) - reviewCost(second)
  })
  return { ...selected, agent_priority: { ...config.agent_priority, review: [...pool, ...order.filter(vendor => eligible(vendor) && !pool.includes(vendor))] } }
}
