import { readFile, writeFile } from 'fs/promises'
import yaml from 'js-yaml'
import { ConfigSchema, type QualityConfig, type ReviewModel } from '../config/schema.js'
import { scanAgentModels, type AgentModelScan, type ScannedModel } from '../lib/agent-model-scan.js'
import { promptRepoPicker, promptSinglePicker } from '../lib/repo-picker.js'
import { reviewCost, selectReviewModel } from '../lib/review-selection.js'
import type { Vendor } from '../lib/vendor.js'

type Preference = NonNullable<QualityConfig['preference']>
export interface InitStrategyDependencies {
  scan: () => Promise<AgentModelScan[]>
  preference: (current: Preference) => Promise<Preference>
  models: (scan: AgentModelScan, selected: string[]) => Promise<string[]>
  classify: (model: ScannedModel) => Promise<ReviewModel['model_class'] | undefined>
  report: (message: string) => void
}
function description(model: ScannedModel): string {
  const cost = reviewCost({ ...model, model_class: model.model_class ?? 'standard' })
  return `${model.model_class ?? 'custom — classification required'} · ${cost === 0 ? 'advertised free tier; usage limits apply' : Number.isFinite(cost) ? `$${cost.toFixed(3)} API-equivalent scenario` : 'price unknown'} · ${model.source}`
}
const dependencies: InitStrategyDependencies = {
  scan: scanAgentModels,
  preference: async current => {
    if (!process.stdin.isTTY) return current
    const choices = ['balanced', 'speed-max', 'cost-min'] as const
    const index = await promptSinglePicker([
      { label: 'balanced', description: 'Eligible model capability with moderate effort' },
      { label: 'speed-max', description: 'Prefer fast models and lower effort; latency is a heuristic' },
      { label: 'cost-min', description: 'Prefer advertised free and cheaper models; raise effort for risk' },
    ], { title: 'Review strategy preference', defaultIndex: choices.indexOf(current) })
    if (!choices[index]) throw new Error('Invalid preference; configuration unchanged')
    return choices[index]
  },
  models: async (scan, selected) => {
    if (!process.stdin.isTTY) return selected
    return promptRepoPicker(scan.models.filter(model => !model.excluded).map(model => model.id), {
      title: `${scan.vendor} — models allowed for review (empty disables this review pool)`, initialSelected: selected,
      getDescription: name => description(scan.models.find(model => model.id === name)!),
    })
  },
  classify: async model => {
    if (!process.stdin.isTTY) return undefined
    const index = await promptSinglePicker([
      { label: 'Exclude', description: 'Leave this unknown deployment out of reviews' },
      { label: 'Fast, non-flagship', description: 'I know the underlying deployment and classify it as fast' },
      { label: 'Standard, non-flagship', description: 'I know the underlying deployment and classify it as standard' },
    ], { title: `Classify custom model ${model.id}`, defaultIndex: 0 })
    return index === 1 ? 'fast' : index === 2 ? 'standard' : undefined
  },
  report: message => console.log(message),
}

export async function initializeReviewStrategy(
  path: string,
  fresh = false,
  deps: InitStrategyDependencies = dependencies,
): Promise<void> {
  const raw = yaml.load(await readFile(path, 'utf8')) as Record<string, unknown>
  const current = ConfigSchema.parse(raw)
  const scans = await deps.scan()
  for (const scan of scans) {
    deps.report(`  ${scan.vendor}: ${scan.installed ? scan.authenticated ? 'authenticated' : 'installed; no saved authentication' : 'not installed'} · ${scan.models.length} models found`)
    for (const warning of scan.warnings) deps.report(`    ${warning}`)
  }
  const preference = await deps.preference(current.quality.preference ?? 'balanced')
  const pools = { ...current.quality.review_models }
  const enabled: Record<Vendor, boolean> = { claude: fresh ? false : current.vendors.claude.enabled, codex: fresh ? false : current.vendors.codex.enabled, opencode: fresh ? false : current.vendors.opencode.enabled }
  let touched = false
  const excluded = new Set(current.quality.excluded_models)
  async function prepare(index: number): Promise<void> {
    const discovered = scans[index]
    if (!discovered) return
    const scan = discovered.authenticated ? discovered : { ...discovered, models: discovered.models.filter(model => model.input_usd_mtok === 0 && model.output_usd_mtok === 0) }
    const free = scan.models.some(model => model.input_usd_mtok === 0 && model.output_usd_mtok === 0 && !model.excluded)
    if (!scan.installed || (!scan.authenticated && !free) || scan.warnings.length > 0) return prepare(index + 1)
    if (!fresh && !current.vendors[scan.vendor].enabled) return prepare(index + 1)
    // Keep existing allowlists on rerun. Newly discovered paid models are never auto-selected.
    const previous = current.quality.review_models?.[scan.vendor]
    // A logged-out scan only exposes free models. Keep previously selected paid
    // entries it cannot see instead of silently dropping them from the pool.
    const preserved = !fresh && !scan.authenticated
      ? (previous ?? []).filter(model => !scan.models.some(entry => entry.id === model.id))
      : []
    const selected = previous?.map(model => model.id) ?? scan.models.filter(model => !model.excluded && model.model_class).map(model => model.id)
    const requested = await deps.models(scan, selected)
    for (const model of scan.models) {
      if (requested.includes(model.id)) excluded.delete(model.id)
      else excluded.add(model.id)
    }
    const allowed: ReviewModel[] = [...preserved]
    async function classifyNext(position: number): Promise<void> {
      const name = requested[position]
      if (name === undefined) return
      const entry = scan.models.find(model => model.id === name && !model.excluded)
      if (!entry) {
        // Previously saved entries hidden by an unauthenticated scan are preserved above.
        if (preserved.some(model => model.id === name)) return classifyNext(position + 1)
        throw new Error('Invalid model selection; configuration unchanged')
      }
      const modelClass = entry.model_class ?? previous?.find(model => model.id === name)?.model_class ?? await deps.classify(entry)
      if (!modelClass) { excluded.add(name); return classifyNext(position + 1) }
      const { excluded: _excluded, ...fields } = entry
      allowed.push({ ...fields, model_class: modelClass })
      await classifyNext(position + 1)
    }
    await classifyNext(0)
    pools[scan.vendor] = allowed
    touched = true
    if (fresh) enabled[scan.vendor] = pools[scan.vendor]!.length > 0
    await prepare(index + 1)
  }
  await prepare(0)
  if (!touched) { deps.report('  No usable model inventory found; existing strategy preserved.'); return }
  const quality = { ...current.quality, preference, review_models: pools, refresh_free_models: true }
  const ranked = (['claude', 'codex', 'opencode'] as const).filter(vendor => enabled[vendor] && (pools[vendor]?.length ?? 0) > 0)
  if (ranked.length === 0) throw new Error('No eligible review models selected; configuration unchanged. Repair or select a non-flagship model with ck init.')
  ranked.sort((a, b) => {
    const chosen = (vendor: Vendor): ReviewModel => {
      const selection = selectReviewModel(vendor, quality, { ...current.vendors[vendor], model: null })
      return pools[vendor]!.find(model => model.id === selection.model)!
    }
    const first = chosen(a), second = chosen(b)
    const capacity = Number(first.model_class === 'standard') - Number(second.model_class === 'standard')
    return (preference === 'balanced' ? -capacity : preference === 'speed-max' ? capacity : 0) || reviewCost(first) - reviewCost(second)
  })
  const next = {
    ...raw, ...(fresh && { mode: ranked.length === 1 ? 'single-vendor' : 'cross-vendor' }), quality: { ...(raw.quality as object ?? {}), preference, review_models: pools, excluded_models: [...excluded], refresh_free_models: true },
    agent_priority: { ...current.agent_priority, review: ranked },
    ...(fresh && { vendors: Object.fromEntries(Object.entries(enabled).map(([vendor, config]) => [vendor, { ...((raw.vendors as Record<string, object> | undefined)?.[vendor] ?? {}), enabled: config, model: null }])) }),
  }
  ConfigSchema.parse(next)
  await writeFile(path, yaml.dump(next, { lineWidth: -1, noRefs: true }), { mode: 0o600 })
  deps.report(`  Review strategy: ${preference}; flagship models excluded. Watch refreshes advertised free models before new reviews.`)
}
