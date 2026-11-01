import { execa } from 'execa'
import { readFile, mkdtemp, rm } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { parse as parseToml } from 'smol-toml'
import { stripVTControlCharacters } from 'util'
import { createRequire } from 'module'
import type { ReviewModel } from '../config/schema.js'
import { getAgentModelConfigPaths, getClaudeModelEnvironment } from '../config/loader.js'
import { probeReviewerReadiness, type ReviewerReadiness } from './reviewer-setup.js'
import { reviewModelClass, reviewModelExcluded } from './review-selection.js'
import type { Vendor } from './vendor.js'

const require = createRequire(import.meta.url)
const catalog = require('../config/review-strategy.json') as { models: Record<string, { in_usd_mtok?: number; out_usd_mtok?: number; effort_levels: string[] }> }
export interface ScannedModel extends Omit<ReviewModel, 'model_class'> {
  model_class?: ReviewModel['model_class']
  excluded: boolean
}
export interface AgentModelScan extends ReviewerReadiness {
  vendor: Vendor
  models: ScannedModel[]
  warnings: string[]
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
function id(value: unknown): string | undefined {
  return typeof value === 'string' && /^(?:[\w./:@+#-]|\[|\]){1,200}$/.test(value) ? value : undefined
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.flatMap(entry => id(entry) ? [entry as string] : []) : []
}
function candidate(name: string, source: ReviewModel['source'], family?: string): ScannedModel {
  const known = catalog.models[name]
  return {
    id: name, source, ...(family && { family }), model_class: reviewModelClass(family ?? name),
    excluded: reviewModelExcluded(name) || reviewModelExcluded(family ?? ''),
    efforts: known?.effort_levels ?? [],
    ...(known && { input_usd_mtok: known.in_usd_mtok, output_usd_mtok: known.out_usd_mtok }),
  }
}
function numeric(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : undefined
}

export function parseCodexModels(raw: string): ScannedModel[] {
  const parsed: unknown = JSON.parse(raw)
  if (!record(parsed) || !Array.isArray(parsed.models)) throw new Error('Unrecognized Codex model catalog')
  return parsed.models.flatMap(entry => {
    if (!record(entry) || entry.visibility === 'hide' || entry.hidden === true) return []
    const name = id(entry.slug ?? entry.model)
    if (!name) return []
    const levels = Array.isArray(entry.supported_reasoning_levels) ? entry.supported_reasoning_levels : []
    return [{ ...candidate(name, 'cli'), efforts: levels.flatMap(level => record(level) && id(level.effort) ? [level.effort as string] : []) }]
  })
}

/** OpenCode emits a provider/model header followed by a pretty-printed JSON object. */
export function parseOpenCodeModels(raw: string): ScannedModel[] {
  const clean = stripVTControlCharacters(raw)
  const headers = [...clean.matchAll(/^([\w.-]+\/[^\s]+)\r?\n(?=\{)/gm)]
  if (headers.length === 0) throw new Error('Unrecognized OpenCode model catalog')
  return headers.flatMap((header, index) => {
    const name = id(header[1])
    if (!name) return []
    const metadata: unknown = JSON.parse(clean.slice(header.index! + header[0].length, headers[index + 1]?.index).trim())
    if (!record(metadata)) return []
    if (record(metadata.capabilities) && metadata.capabilities.toolcall === false) return []
    const cost = record(metadata.cost) ? metadata.cost : {}
    const variants = record(metadata.variants) ? Object.keys(metadata.variants).filter(level => id(level)) : []
    const input = numeric(cost.input), output = numeric(cost.output)
    const ambiguousZero = input === 0 && output === 0 && !name.startsWith('opencode/') && !/(?:^|[/_.:-])free(?:$|[/_.:-])/i.test(name)
    const family = id(metadata.family)
    const actual = record(metadata.api) ? id(metadata.api.id) : undefined
    const native = name.split('/').at(-1)!
    const knownClass = actual && catalog.models[actual] ? reviewModelClass(actual) : undefined
    const modelClass = knownClass ?? (name.startsWith('opencode/') || catalog.models[native] ? reviewModelClass(name) : undefined)
    return [{
      ...candidate(name, 'cli', family),
      excluded: reviewModelExcluded(name) || reviewModelExcluded(family ?? '') || reviewModelExcluded(actual ?? ''),
      model_class: modelClass,
      efforts: variants,
      input_usd_mtok: ambiguousZero ? undefined : input, output_usd_mtok: ambiguousZero ? undefined : output,
    }]
  })
}

export function parseClaudeModels(raw: string, environment: Record<string, string> = {}): ScannedModel[] {
  const settings: unknown = JSON.parse(raw)
  if (!record(settings)) throw new Error('Unrecognized Claude settings')
  const env = { ...(record(settings.env) ? settings.env : {}), ...environment }
  const aliases: Record<string, string> = {
    haiku: id(env.ANTHROPIC_DEFAULT_HAIKU_MODEL) ?? 'claude-haiku-5-5',
    sonnet: id(env.ANTHROPIC_DEFAULT_SONNET_MODEL) ?? 'claude-sonnet-5-5',
  }
  const configured = id(env.ANTHROPIC_MODEL) ?? id(settings.model) ?? id(env.ANTHROPIC_DEFAULT_MODEL)
  const custom = id(env.ANTHROPIC_CUSTOM_MODEL_OPTION)
  const picker = record(settings.modelPicker) && Array.isArray(settings.modelPicker.options) ? settings.modelPicker.options : []
  const names = Array.isArray(settings.availableModels) ? strings(settings.availableModels)
    : [...Object.keys(aliases), ...(configured ? [configured] : []), ...(custom ? [custom] : []), ...picker.flatMap(option => record(option) && id(option.model) ? [option.model as string] : [])]
  const overrides = record(settings.modelOverrides) ? settings.modelOverrides : {}
  const denied = Array.isArray(settings.deniedModels) ? settings.deniedModels.filter((value): value is string => typeof value === 'string' && value.length <= 200) : []
  const models = names.flatMap(name => {
    const canonical = aliases[name] ?? name
    const requested = id(overrides[canonical]) ?? canonical
    const option = picker.find(entry => record(entry) && entry.model === name)
    const family = record(option) ? id(option.behavesAs) : undefined
    const blocked = denied.some(pattern => new RegExp('^' + pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*') + '$').test(requested))
    if (blocked) return []
    const entry = candidate(requested, configured === name || requested !== canonical ? 'configured' : 'catalog', family ?? canonical)
    // Pricing a private deployment by its underlying public model would invent its rate.
    if (requested !== canonical) { delete entry.input_usd_mtok; delete entry.output_usd_mtok }
    const cap = ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(String(settings.maxEffortLevel))
    if (cap >= 0) entry.efforts = entry.efforts.filter(level => ['low', 'medium', 'high', 'xhigh', 'max'].indexOf(level) <= cap)
    return [entry]
  })
  return [...new Map(models.map(entry => [entry.id, entry])).values()]
}

export interface AgentScanDependencies {
  probe: (vendor: Vendor) => Promise<ReviewerReadiness>
  read: (path: string) => Promise<string | undefined>
  run: (vendor: Vendor, args: string[], cwd: string) => Promise<string>
  paths: { claude: string; codex: string }
  claudeEnvironment: Record<string, string>
}
const dependencies: AgentScanDependencies = {
  probe: probeReviewerReadiness,
  read: async path => {
    try { return await readFile(path, 'utf8') } catch (err: unknown) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return undefined
      throw new Error('Could not read agent model settings')
    }
  },
  run: async (vendor, args, cwd) => (await execa(vendor, args, { cwd, timeout: 15_000, maxBuffer: 8 * 1024 * 1024 })).stdout,
  paths: getAgentModelConfigPaths(),
  claudeEnvironment: getClaudeModelEnvironment(),
}

export async function scanAgentModels(deps: AgentScanDependencies = dependencies): Promise<AgentModelScan[]> {
  const directory = await mkdtemp(join(tmpdir(), 'crosscheck-model-scan-'))
  try {
    return await Promise.all((['claude', 'codex', 'opencode'] as const).map(async vendor => {
      const readiness = await deps.probe(vendor)
      const scan: AgentModelScan = { vendor, ...readiness, models: [], warnings: [] }
      if (!readiness.installed || (!readiness.authenticated && vendor !== 'opencode')) return scan
      if (vendor === 'opencode' && !readiness.authenticated && /does not support|could not read|capability probe failed/i.test(readiness.detail)) {
        scan.warnings.push('OpenCode needs CLI/auth-probe repair before free-tier discovery can enable it.')
        return scan
      }
      try {
        if (vendor === 'claude') {
          scan.models = parseClaudeModels(await deps.read(deps.paths.claude) ?? '{}', deps.claudeEnvironment)
        } else if (vendor === 'codex') {
          const raw = await deps.read(deps.paths.codex)
          const config = raw ? parseToml(raw) : {}
          const profiles = record(config.profiles) ? config.profiles : {}
          const selectedProfile = typeof config.profile === 'string' ? profiles[config.profile] : undefined
          const profile = record(selectedProfile) ? selectedProfile : {}
          const active = { ...config, ...profile }
          if (typeof active.model_provider === 'string' && active.model_provider !== 'openai') {
            scan.warnings.push('Custom Codex provider is configured-only: the isolated review runner does not load provider definitions. Use its OpenCode route instead.')
            return scan
          }
          scan.models = parseCodexModels(await deps.run(vendor, ['debug', 'models'], directory))
          const selected = id(active.model)
          if (selected && !scan.models.some(model => model.id === selected)) scan.models.push(candidate(selected, 'configured'))
        } else {
          // --pure refuses plugin loading; never retry without it against user configuration.
          scan.models = parseOpenCodeModels(await deps.run(vendor, ['models', '--verbose', '--pure'], directory))
          const raw = await deps.run(vendor, ['debug', 'config', '--pure'], directory)
          const configured: unknown = JSON.parse(raw)
          if (record(configured)) {
            const selected = id(configured.model)
            if (selected) scan.models = scan.models.map(model => model.id === selected ? { ...model, source: 'configured' } : model)
          }
        }
      } catch {
        scan.warnings.push('Model discovery was incomplete; repair the agent configuration and rerun ck init. Raw diagnostics are withheld because they may contain credentials.')
      }
      return scan
    }))
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}
