import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { initializeReviewStrategy, type InitStrategyDependencies } from '../commands/init-review-strategy.js'
import { ConfigSchema } from '../config/schema.js'
import type { AgentModelScan } from '../lib/agent-model-scan.js'

let directory: string
let path: string
beforeEach(async () => { directory = await mkdtemp(join(tmpdir(), 'crosscheck-init-strategy-')); path = join(directory, 'config.yml') })
afterEach(async () => { await rm(directory, { recursive: true, force: true }) })
const scans: AgentModelScan[] = [{
  vendor: 'opencode', installed: true, authenticated: false, detail: 'no credentials', warnings: [],
  models: [
    { id: 'opencode/glm-5.3-flash-free', model_class: 'fast', source: 'cli', efforts: ['high'], input_usd_mtok: 0, output_usd_mtok: 0, excluded: false },
    { id: 'opencode/kimi-k3-free', source: 'cli', efforts: [], input_usd_mtok: 0, output_usd_mtok: 0, excluded: true },
    { id: 'private/reviewer', source: 'configured', efforts: [], excluded: false },
  ],
}]
const deps = (): InitStrategyDependencies => ({ scan: async () => scans, preference: async () => 'cost-min', models: async (_scan, selected) => selected, classify: async () => undefined, report: vi.fn() })
const read = async () => ConfigSchema.parse(yaml.load(await readFile(path, 'utf8')))

describe('ck init model strategy persistence', () => {
  it('uses the discovered free pool, preserves unrelated config, and avoids unavailable default agents on first init', async () => {
    await writeFile(path, 'orgs: [research-team]\nvendors:\n  opencode:\n    enabled: false\n')
    await initializeReviewStrategy(path, true, deps())
    const saved = await read()
    expect(saved.quality.preference).toBe('cost-min')
    expect(saved.quality.review_models?.opencode?.map(model => model.id)).toEqual(['opencode/glm-5.3-flash-free'])
    expect(saved.vendors.opencode.enabled).toBe(true)
    expect(saved.vendors.codex.enabled).toBe(false)
    expect(saved.vendors.claude.enabled).toBe(false)
    expect(saved.agent_priority.review).toEqual(['opencode'])
    expect(saved.orgs).toEqual(['research-team'])
  })

  it('preserves enabled-agent opt-outs, existing model selections and the saved preference on rerun', async () => {
    await writeFile(path, yaml.dump({ quality: { preference: 'speed-max', review_models: { opencode: [scans[0].models[0]] } }, vendors: { opencode: { enabled: true }, claude: { enabled: false } } }))
    const choices = vi.fn(deps().models)
    await initializeReviewStrategy(path, false, { ...deps(), models: choices, preference: async current => current })
    expect(choices.mock.calls[0][1]).toEqual(['opencode/glm-5.3-flash-free'])
    expect((await read()).quality.preference).toBe('speed-max')
    expect((await read()).vendors.claude.enabled).toBe(false)
  })

  it.each(['interactive', 'noninteractive'])('preserves paid selections on a logged-out %s rerun', async mode => {
    const paid = { id: 'private/paid-review', model_class: 'standard', source: 'configured', efforts: ['high'], input_usd_mtok: 1, output_usd_mtok: 5 }
    await writeFile(path, yaml.dump({ quality: { review_models: { opencode: [paid, scans[0].models[0]] } }, vendors: { opencode: { enabled: true } } }))
    await initializeReviewStrategy(path, false, { ...deps(), models: async (_scan, selected) =>
      mode === 'interactive' ? [scans[0].models[0].id] : selected,
    })
    expect((await read()).quality.review_models?.opencode).toContainEqual(paid)
    expect((await read()).quality.review_models?.opencode).toHaveLength(2)
  })

  it('requires explicit classification for an unknown custom deployment and excludes unchecked free models from watch refresh', async () => {
    await writeFile(path, 'vendors:\n  opencode:\n    enabled: true\n')
    await initializeReviewStrategy(path, false, { ...deps(), scan: async () => scans.map(scan => ({ ...scan, authenticated: true })), models: async () => ['private/reviewer'], classify: async () => 'standard' })
    const saved = await read()
    expect(saved.quality.review_models?.opencode).toMatchObject([{ id: 'private/reviewer', model_class: 'standard' }])
    expect(saved.quality.excluded_models).toContain('opencode/glm-5.3-flash-free')
  })

  it('leaves the file untouched after incomplete discovery or an invalid model selection', async () => {
    const original = 'vendors:\n  opencode:\n    enabled: true\n'
    await writeFile(path, original)
    await initializeReviewStrategy(path, false, { ...deps(), scan: async () => [{ ...scans[0], warnings: ['configuration unreadable'] }] })
    expect(await readFile(path, 'utf8')).toBe(original)
    await expect(initializeReviewStrategy(path, false, { ...deps(), models: async () => ['opencode/kimi-k3-free'] })).rejects.toThrow(/invalid model selection/i)
    expect(await readFile(path, 'utf8')).toBe(original)
  })
})
