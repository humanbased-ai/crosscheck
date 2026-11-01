import { describe, expect, it, vi } from 'vitest'
import { parseClaudeModels, parseCodexModels, parseOpenCodeModels, scanAgentModels, type AgentScanDependencies } from '../lib/agent-model-scan.js'

const openCode = (name: string, metadata: object) => `${name}\n${JSON.stringify(metadata, null, 2)}\n`

describe('agent model metadata scanning', () => {
  it('keeps only safe OpenCode fields, prices and exact supported variants', () => {
    const raw = openCode('private/free-flash-review', {
      family: 'flash', cost: { input: 0, output: 0 }, variants: { high: {}, max: {} },
      headers: { Authorization: 'fixture-secret' }, options: { apiKey: 'fixture-secret' }, api: { id: 'gpt-6-luna', url: 'https://fixture-secret.example' },
    })
    const models = parseOpenCodeModels(raw)
    expect(models[0]).toMatchObject({ id: 'private/free-flash-review', model_class: 'fast', input_usd_mtok: 0, efforts: ['high', 'max'] })
    expect(JSON.stringify(models)).not.toContain('fixture-secret')
  })

  it('does not interpret placeholder zero prices on an unpriced custom route as a free offer', () => {
    const [model] = parseOpenCodeModels(openCode('private/flash-review', { cost: { input: 0, output: 0 } }))
    expect(model.model_class).toBeUndefined()
    expect(model.input_usd_mtok).toBeUndefined()
    expect(model.output_usd_mtok).toBeUndefined()
  })

  it('excludes hidden and non-tool models and recognizes opaque flagship deployments', () => {
    expect(parseCodexModels(JSON.stringify({ models: [
      { slug: 'gpt-6-luna', visibility: 'list', supported_reasoning_levels: [{ effort: 'low' }] },
      { slug: 'hidden-review', visibility: 'hide' },
    ] }))).toHaveLength(1)
    const raw = openCode('private/reviewer', { api: { id: 'claude-opus-5-5' } })
      + openCode('private/embedding', { capabilities: { toolcall: false } })
    expect(parseOpenCodeModels(raw)).toMatchObject([{ id: 'private/reviewer', excluded: true }])
  })

  it('honors Claude allowlists, model remaps, deny patterns and custom model classification', () => {
    const models = parseClaudeModels(JSON.stringify({
      availableModels: ['haiku', 'sonnet', 'gateway-review'], deniedModels: ['claude-haiku-*'],
      modelPicker: { options: [{ model: 'gateway-review', behavesAs: 'opus' }] },
      env: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'private-deployment', ANTHROPIC_API_KEY: 'fixture-secret' },
    }))
    expect(models.map(model => model.id)).toEqual(['private-deployment', 'gateway-review'])
    expect(models[0].model_class).toBeUndefined()
    expect(models[0].input_usd_mtok).toBeUndefined()
    expect(models[1].excluded).toBe(true)
    expect(JSON.stringify(models)).not.toContain('fixture-secret')
    expect(parseClaudeModels('{"availableModels":[]}')).toEqual([])
  })

  const deps = (): AgentScanDependencies => ({
    probe: async () => ({ installed: true, authenticated: true, detail: 'ready' }),
    read: async () => undefined,
    run: async vendor => vendor === 'codex' ? '{"models":[]}' : '{}',
    paths: { claude: '/user/claude-settings.json', codex: '/user/codex-config.toml' }, claudeEnvironment: {},
  })

  it('reports custom Codex providers without claiming the isolated runner supports them', async () => {
    const run = vi.fn(deps().run)
    const scans = await scanAgentModels({ ...deps(), run, read: async path => path.includes('codex') ? 'model_provider = "private"\nmodel = "custom-review"' : '{}' })
    expect(scans.find(scan => scan.vendor === 'codex')).toMatchObject({ models: [], warnings: [expect.stringContaining('configured-only')] })
    expect(run.mock.calls.some(call => call[0] === 'codex')).toBe(false)
  })

  it('can discover free OpenCode models without credentials and never runs inference', async () => {
    const run = vi.fn(async (_vendor: string, args: string[]) => args[0] === 'models'
      ? openCode('opencode/glm-5.3-flash-free', { cost: { input: 0, output: 0 }, variants: { high: {} } }) : '{"model":"opencode/glm-5.3-flash-free","secret":"fixture-secret"}')
    const scans = await scanAgentModels({ ...deps(), probe: async () => ({ installed: true, authenticated: false, detail: 'no auth' }), run })
    expect(scans[2].models).toMatchObject([{ source: 'configured', id: 'opencode/glm-5.3-flash-free' }])
    expect(run.mock.calls.map(call => call[1])).toEqual([['models', '--verbose', '--pure'], ['debug', 'config', '--pure']])
    expect(JSON.stringify(scans)).not.toContain('fixture-secret')
  })

  it('withholds secret-bearing diagnostics and marks a failed metadata scan incomplete', async () => {
    const scans = await scanAgentModels({ ...deps(), run: async () => { throw new Error('apiKey=fixture-secret') } })
    expect(scans[1].warnings).toHaveLength(1)
    expect(JSON.stringify(scans)).not.toContain('fixture-secret')
  })
})


it('does not let free-tier discovery bypass an unsupported headless OpenCode CLI', async () => {
  const run = vi.fn(async () => '{}')
  const scans = await scanAgentModels({
    probe: async () => ({ installed: true, authenticated: false, detail: "opencode does not support 'run --auto'" }),
    read: async () => undefined, run, paths: { claude: '/fixture/claude', codex: '/fixture/codex' }, claudeEnvironment: {},
  })
  expect(scans[2]).toMatchObject({ models: [], warnings: [expect.stringContaining('repair')] })
  expect(run).not.toHaveBeenCalled()
})
