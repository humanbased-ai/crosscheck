import { describe, expect, it, vi } from 'vitest'
import { ConfigSchema, type ReviewModel } from '../config/schema.js'
import { eligibleReviewConfig } from '../lib/review-selection.js'
import { refreshFreeModelPool, WatchModelDiscovery } from '../lib/watch-models.js'
import type { AgentModelScan } from '../lib/agent-model-scan.js'

const free: ReviewModel = { id: 'opencode/glm-5.3-flash-free', model_class: 'fast', source: 'cli', efforts: ['high'], input_usd_mtok: 0, output_usd_mtok: 0 }
const scans = (models = [free]): AgentModelScan[] => [{ vendor: 'opencode', installed: true, authenticated: false, detail: 'free', warnings: [], models: models.map(model => ({ ...model, excluded: false })) }]
const config = () => ConfigSchema.parse({ vendors: { opencode: { enabled: true } }, quality: { preference: 'cost-min', refresh_free_models: true, model_refresh_sec: 30, review_models: { opencode: [] } } })

describe('watch-session free-model discovery', () => {
  it('adds only advertised free, non-flagship models on enabled agents and honors exclusions', () => {
    const cfg = config()
    const scan = scans([free, { ...free, id: 'opencode/kimi-k3' }, { ...free, id: 'opencode/paid-flash', output_usd_mtok: 1 }])
    expect(refreshFreeModelPool(cfg, scan).opencode).toMatchObject([{ id: free.id, auto_free: true }])
    expect(refreshFreeModelPool({ ...cfg, quality: { ...cfg.quality, excluded_models: [free.id] } }, scan).opencode).toEqual([])
    expect(refreshFreeModelPool({ ...cfg, vendors: { ...cfg.vendors, opencode: { ...cfg.vendors.opencode, enabled: false } } }, scan).opencode).toEqual([])
  })

  it('removes vanished or newly paid free models without opting into paid usage', () => {
    const cfg = config()
    cfg.quality.review_models = { opencode: [free] }
    expect(refreshFreeModelPool(cfg, scans([{ ...free, input_usd_mtok: .1 }])).opencode).toEqual([])
    expect(refreshFreeModelPool(cfg, scans([])).opencode).toEqual([])
    expect(cfg.quality.review_models.opencode).toEqual([free])
  })

  it('refreshes once per interval, shares concurrent scans, and freezes active review snapshots', async () => {
    let now = 0
    const scan = vi.fn().mockResolvedValueOnce(scans()).mockResolvedValueOnce(scans([{ ...free, id: 'opencode/deepseek-flash-free' }]))
    const discovery = new WatchModelDiscovery(scan, () => now)
    const cfg = config()
    const [first, concurrent] = await Promise.all([discovery.snapshot(cfg), discovery.snapshot(cfg)])
    expect(scan).toHaveBeenCalledTimes(1)
    expect(first.quality.review_models).toEqual(concurrent.quality.review_models)
    now = 29000
    await discovery.snapshot(cfg)
    expect(scan).toHaveBeenCalledTimes(1)
    now = 30000
    const next = await discovery.snapshot(cfg)
    expect(scan).toHaveBeenCalledTimes(2)
    expect(first.quality.review_models?.opencode?.[0].id).toBe(free.id)
    expect(next.quality.review_models?.opencode?.[0].id).toBe('opencode/deepseek-flash-free')
    expect(cfg.quality.review_models?.opencode).toEqual([])
  })

  it('keeps the last inventory on incomplete scans and does nothing when refresh is disabled', async () => {
    const cfg = config()
    cfg.quality.review_models = { opencode: [free] }
    const failed = scans([]); failed[0].warnings = ['metadata unavailable']
    expect(refreshFreeModelPool(cfg, failed).opencode).toEqual([free])
    const scan = vi.fn()
    const disabled = { ...cfg, quality: { ...cfg.quality, refresh_free_models: false } }
    expect(await new WatchModelDiscovery(scan).snapshot(disabled)).toBe(disabled)
    expect(scan).not.toHaveBeenCalled()
  })
})


it('reorders cost-min review preference when a new free route appears during watch', async () => {
  const cfg = config()
  cfg.agent_priority.review = ['codex', 'opencode']
  cfg.quality.review_models!.codex = [{ id: 'gpt-6.1-sol', model_class: 'standard', source: 'cli', efforts: ['medium'], input_usd_mtok: 2, output_usd_mtok: 10 }]
  expect(eligibleReviewConfig(cfg).agent_priority.review[0]).toBe('codex')
  const snapshot = await new WatchModelDiscovery(async () => scans()).snapshot(cfg)
  expect(eligibleReviewConfig(snapshot).agent_priority.review[0]).toBe('opencode')
  expect(cfg.agent_priority.review[0]).toBe('codex')
})
