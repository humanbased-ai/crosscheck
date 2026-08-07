import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import yaml from 'js-yaml'
import { applyOnboardConfig, detectCurrentPreset, detectConflictResolveEnabled, type OnboardDecisions } from '../commands/onboard.js'
import { mkdirSync } from 'fs'

const BASE_DECISIONS: OnboardDecisions = {
  deployment: 'personal',
  login: 'alice',
  selectedRepos: ['alice/myapp'],
  selectedOrgs: [],
  vendorConfig: { mode: 'cross-vendor', claudeEnabled: true, codexEnabled: true },
  authorVendor: 'claude',
  qualityTier: 'balanced',
  qualityMode: 'smart' as const,
  enabledSkills: ['code-review-skill'],
  pipelinePreset: 'review-only',
  conflictResolve: false,
  tunnelBackend: 'localhost.run',
  smeeChannel: '',
  cloneProtocol: 'ssh',
}

let tmpDir: string
let configPath: string
let workflowDir: string

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-test-'))
  configPath = join(tmpDir, 'config.yml')
  workflowDir = join(tmpDir, 'workflow-dir')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

function readConfig(): Record<string, unknown> {
  return (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
}

describe('applyOnboardConfig — first run', () => {
  it('creates config with routing defaults when no file exists', () => {
    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    expect(cfg.deployment).toBe('personal')
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice'])
    expect(routing.fallback_reviewer).toBe('auto')
  })

  it('pins the codex model under fixed mode', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityTier: 'thorough', qualityMode: 'fixed' }, workflowDir)

    const cfg = readConfig()
    const quality = cfg.quality as Record<string, unknown>
    expect(quality.tier).toBe('thorough')
    expect(quality.mode).toBe('fixed')
    const vendors = cfg.vendors as Record<string, Record<string, unknown>>
    expect(vendors.claude.model).toBeUndefined()
    expect(vendors.claude.effort).toBe('max')
    // One model on every PR is exactly what `fixed` means.
    expect(vendors.codex.model).toBe('gpt-5.6-sol')
  })

  it('pins no vendor model under smart mode', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityTier: 'thorough', qualityMode: 'smart' }, workflowDir)

    const cfg = readConfig()
    const quality = cfg.quality as Record<string, unknown>
    expect(quality.mode).toBe('smart')
    // A pinned model outranks the strategy in resolveClaudeModel/resolveCodexModel,
    // which would make per-PR tier selection a silent no-op.
    const vendors = cfg.vendors as Record<string, Record<string, unknown>>
    expect(vendors.codex.model).toBeUndefined()
    expect(vendors.claude.model).toBeUndefined()
    // Tier is still written — it is the fallback when a PR's files can't be read.
    expect(quality.tier).toBe('thorough')
  })

  it('clears a model pinned by an earlier fixed-mode run when switching to smart', () => {
    writeFileSync(configPath, yaml.dump({ vendors: { codex: { model: 'gpt-5.6-terra' } } }))
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityMode: 'smart' }, workflowDir)

    const vendors = readConfig().vendors as Record<string, Record<string, unknown>>
    expect(vendors.codex.model).toBeUndefined()
  })

  it('writes the enabled skill selection', () => {
    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    expect((readConfig().skills as Record<string, unknown>).enabled).toEqual(['code-review-skill'])
  })

  it('writes workflow.yml for all three presets', () => {
    for (const preset of ['review-only', 'review-fix', 'review-fix-recheck'] as const) {
      // Fresh workflowDir per preset to test first-write behavior
      const dir = join(workflowDir, preset)
      applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: preset }, dir)
      expect(existsSync(join(dir, 'workflow.yml'))).toBe(true)
    }
  })

  it('workflow.yml has correct step count per preset', () => {
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const loadWf = (dir: string) => {
      const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: unknown[] }
      return raw.steps.length
    }
    const dirA = join(workflowDir, 'a')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only' }, dirA)
    expect(loadWf(dirA)).toBe(1)

    const dirB = join(workflowDir, 'b')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, dirB)
    expect(loadWf(dirB)).toBe(2)

    const dirC = join(workflowDir, 'c')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, dirC)
    expect(loadWf(dirC)).toBe(3)
  })

  it('workflow.yml steps have inline instructions', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)
    const raw = yaml.load(readFileSync(join(workflowDir, 'workflow.yml'), 'utf8')) as { steps: Array<{ instructions?: string }> }
    expect(typeof raw.steps[0].instructions).toBe('string')
    expect(raw.steps[0].instructions!.length).toBeGreaterThan(10)
  })
})

describe('applyOnboardConfig — authorVendor routing', () => {
  it('authorVendor: claude writes author_routes[login] = claude', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, authorVendor: 'claude' }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect((routing.author_routes as Record<string, string>).alice).toBe('claude')
  })

  it('authorVendor: codex writes author_routes[login] = codex', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, authorVendor: 'codex' }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect((routing.author_routes as Record<string, string>).alice).toBe('codex')
  })

  it('authorVendor: both removes login entry from author_routes', () => {
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, authorVendor: 'both' }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect(routing.author_routes).toBeUndefined()
  })

  it('authorVendor: both preserves other entries while removing login entry', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { author_routes: { alice: 'claude', 'bot-user': 'codex' }, fallback_reviewer: 'auto' },
    }))
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, authorVendor: 'both' }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect(routing.author_routes).toEqual({ 'bot-user': 'codex' })
  })

  it('--reconfigure: overwrites existing author_routes[login] with new choice', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { author_routes: { alice: 'claude' }, fallback_reviewer: 'auto' },
    }))
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, authorVendor: 'codex' }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect((routing.author_routes as Record<string, string>).alice).toBe('codex')
  })

  it('team mode: skips author_routes regardless of authorVendor', () => {
    applyOnboardConfig(configPath, {
      ...BASE_DECISIONS,
      deployment: 'team',
      login: 'alice',
      authorVendor: 'codex',
    }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    expect(routing.author_routes).toBeUndefined()
  })

  it('single-vendor mode: preserves existing author_routes (step skipped, authorVendor defaults to both)', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { author_routes: { alice: 'claude' }, fallback_reviewer: 'auto' },
    }))
    applyOnboardConfig(configPath, {
      ...BASE_DECISIONS,
      vendorConfig: { mode: 'single-vendor', claudeEnabled: true, codexEnabled: false },
      authorVendor: 'both',  // default when step is skipped
    }, workflowDir)
    const routing = (readConfig().routing as Record<string, unknown>)
    // author_routes must be untouched — single-vendor step is not applicable
    expect(routing.author_routes).toEqual({ alice: 'claude' })
  })
})

describe('applyOnboardConfig — re-run preservation', () => {
  it('preserves quality.focus and quality.custom_prompt', () => {
    // Seed config with custom quality settings
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      quality: {
        tier: 'fast',
        focus: ['security', 'performance'],
        custom_prompt: 'Be concise.',
      },
    }))

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, qualityTier: 'balanced' }, workflowDir)

    const cfg = readConfig()
    const quality = cfg.quality as Record<string, unknown>
    expect(quality.tier).toBe('balanced')              // updated
    expect(quality.focus).toEqual(['security', 'performance'])  // preserved
    expect(quality.custom_prompt).toBe('Be concise.')  // preserved
  })

  it('preserves budget fields', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      budget: { codex_monthly_usd: 50, per_review_usd: 3.00 },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const budget = cfg.budget as Record<string, unknown>
    expect(budget.per_review_usd).toBe(3.00)
    expect(budget.codex_monthly_usd).toBe(50)
  })

  it('preserves routing.allowed_authors on re-run', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: {
        allowed_authors: ['alice', 'my-bot'],
        fallback_reviewer: 'claude',
      },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice', 'my-bot'])  // custom list preserved
    expect(routing.fallback_reviewer).toBe('claude')              // custom value preserved
  })

  it('preserves other users in author_routes; updates only login entry', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: {
        allowed_authors: ['alice'],
        author_routes: { alice: 'codex', 'my-agent': 'codex' },
        fallback_reviewer: 'auto',
      },
    }))

    // BASE_DECISIONS has authorVendor: 'claude' — alice's entry should be updated to 'claude'
    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.author_routes).toEqual({ alice: 'claude', 'my-agent': 'codex' })
  })

  it('preserves branding and server fields', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      brand: { service_name: 'mycheck' },
      server: { port: 9000 },
      logs: { retention_days: 14 },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    expect((cfg.brand as Record<string, unknown>).service_name).toBe('mycheck')
    expect((cfg.server as Record<string, unknown>).port).toBe(9000)
    expect((cfg.logs as Record<string, unknown>).retention_days).toBe(14)
  })

  it('writes selected repos without a steps field (per-repo depth lives in ~/.crosscheck/workflows/)', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'team',
      repos: [{ owner: 'alice', name: 'myapp' }],
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    expect(cfg.repos).toEqual([
      { owner: 'alice', name: 'myapp' },
    ])
  })
})

describe('applyOnboardConfig — users / routing edge cases', () => {
  it('clears users when switching to team mode with no scope selected', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      users: ['alice'],
      routing: { allowed_authors: ['alice'], fallback_reviewer: 'auto' },
    }))

    applyOnboardConfig(configPath, {
      ...BASE_DECISIONS,
      deployment: 'team',
      selectedRepos: [],
      selectedOrgs: [],
    }, workflowDir)

    const cfg = readConfig()
    expect(cfg.users).toBeUndefined()
  })

  it('initialises allowed_authors when routing exists but allowed_authors is empty', () => {
    // Simulate an unpatched example config: routing block present but no allowed_authors
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { fallback_reviewer: 'auto' },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice'])
  })

  it('preserves non-empty allowed_authors even if partial routing exists', () => {
    writeFileSync(configPath, yaml.dump({
      deployment: 'personal',
      routing: { allowed_authors: ['alice', 'bot'], fallback_reviewer: 'claude' },
    }))

    applyOnboardConfig(configPath, BASE_DECISIONS, workflowDir)

    const cfg = readConfig()
    const routing = cfg.routing as Record<string, unknown>
    expect(routing.allowed_authors).toEqual(['alice', 'bot'])
    expect(routing.fallback_reviewer).toBe('claude')
  })
})

describe('applyOnboardConfig — workflow.yml lifecycle', () => {
  it('regenerates workflow.yml on preset downgrade (extra step types removed)', () => {
    // First run: recheck writes a 3-step workflow
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, workflowDir)
    const original = readFileSync(join(workflowDir, 'workflow.yml'), 'utf8')

    // Downgrade to review-only — sequence drifts (extra fix/recheck), so file is regenerated
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only' }, workflowDir)
    const downgraded = readFileSync(join(workflowDir, 'workflow.yml'), 'utf8')

    expect(downgraded).not.toBe(original)
    const raw = yaml.load(downgraded) as { steps: Array<{ type: string }> }
    expect(raw.steps).toHaveLength(1)
    expect(raw.steps[0].type).toBe('review')
  })

  it('regenerates workflow.yml when preset upgrade requires new step types', () => {
    const workflowPath = join(workflowDir, 'workflow.yml')

    // First run: review-only (1 step, no fix or recheck)
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only' }, workflowDir)
    const oneStepContent = readFileSync(workflowPath, 'utf8')

    // Upgrade to review-fix — fix type is missing, so file is regenerated
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)
    const twoStepContent = readFileSync(workflowPath, 'utf8')

    expect(twoStepContent).not.toBe(oneStepContent)
    const raw = yaml.load(twoStepContent) as { steps: Array<{ type: string }> }
    expect(raw.steps.some(s => s.type === 'fix')).toBe(true)
  })

  it('preserves workflow.yml with legacy "address" step type on same preset', () => {
    const workflowPath = join(workflowDir, 'workflow.yml')

    // First run to create the workflow dir, then overwrite with a legacy-shaped file.
    // workflow.ts schema transforms 'address' → 'fix' at parse time, so semantically
    // these workflows are equivalent and should not trigger regeneration.
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)

    const legacyContent = yaml.dump({
      on: ['opened', 'synchronize'],
      steps: [
        { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: 'my custom review instructions' },
        { name: 'fix', type: 'address', reviewer: 'origin', when: "review.verdict != 'APPROVE'", max_rounds: 1, instructions: 'my custom fix instructions' },
      ],
    })
    writeFileSync(workflowPath, legacyContent)

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)

    // File should be preserved — sequence after legacy normalization matches review-fix
    expect(readFileSync(workflowPath, 'utf8')).toBe(legacyContent)
  })

  it('preserves user-customized workflow.yml on re-run with same preset', () => {
    const workflowPath = join(workflowDir, 'workflow.yml')

    // First run: writes template
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)
    const templateContent = readFileSync(workflowPath, 'utf8')

    // User customizes the file (adds a comment but keeps both step types)
    const customContent = templateContent + '\n# my custom step\n'
    writeFileSync(workflowPath, customContent)

    // Re-run with same preset — both required types (review, fix) present
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix' }, workflowDir)
    expect(readFileSync(workflowPath, 'utf8')).toBe(customContent)
  })

  // Regression for PR #119 review: original bug scenario seeded with a real
  // legacy workflow file (not via applyOnboardConfig). Locks in that legacy
  // 'address' is normalized in the sequence comparison and the file is
  // regenerated down to a single review step.
  it('regenerates legacy address+recheck workflow on preset downgrade', () => {
    const workflowPath = join(workflowDir, 'workflow.yml')
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(workflowPath, yaml.dump({
      on: ['opened', 'synchronize'],
      steps: [
        { name: 'review', type: 'review' },
        { name: 'fix', type: 'address' },
        { name: 'recheck', type: 'recheck' },
      ],
    }))

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only' }, workflowDir)

    const raw = yaml.load(readFileSync(workflowPath, 'utf8')) as { steps: Array<{ type: string }> }
    expect(raw.steps).toHaveLength(1)
    expect(raw.steps[0].type).toBe('review')
  })
})

describe('detectCurrentPreset', () => {
  function seedWorkflow(content: string): void {
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(join(workflowDir, 'workflow.yml'), content)
  }

  it('returns review-fix-recheck (the default) when no workflow file exists', () => {
    expect(detectCurrentPreset(workflowDir)).toBe('review-fix-recheck')
  })

  it('returns review-fix for a workflow with review + fix steps', () => {
    seedWorkflow(yaml.dump({
      on: ['opened'],
      steps: [{ name: 'review', type: 'review' }, { name: 'fix', type: 'fix' }],
    }))
    expect(detectCurrentPreset(workflowDir)).toBe('review-fix')
  })

  it('returns review-fix-recheck when a recheck step is present', () => {
    seedWorkflow(yaml.dump({
      on: ['opened'],
      steps: [
        { name: 'review', type: 'review' },
        { name: 'fix', type: 'fix' },
        { name: 'recheck', type: 'recheck' },
      ],
    }))
    expect(detectCurrentPreset(workflowDir)).toBe('review-fix-recheck')
  })

  // Regression: legacy workflows used `type: address` before the rename to `fix`.
  // detectCurrentPreset must normalize so onboard does not infer review-only and
  // then silently drop the legacy step on regenerate.
  it('treats legacy address step as fix when inferring preset', () => {
    seedWorkflow(yaml.dump({
      on: ['opened'],
      steps: [{ name: 'review', type: 'review' }, { name: 'fix', type: 'address' }],
    }))
    expect(detectCurrentPreset(workflowDir)).toBe('review-fix')
  })

  it('returns review-fix-recheck (the default) for a malformed workflow', () => {
    seedWorkflow('not: valid: yaml: at all: [')
    expect(detectCurrentPreset(workflowDir)).toBe('review-fix-recheck')
  })
})

describe('applyOnboardConfig — max_rounds in workflow.yml', () => {
  it('writes max_rounds: 1 on fix and recheck steps by default', () => {
    const dir = join(workflowDir, 'maxrounds-default')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck' }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number }> }
    const fixStep = raw.steps.find(s => s.type === 'fix')
    const recheckStep = raw.steps.find(s => s.type === 'recheck')
    expect(fixStep?.max_rounds).toBe(1)
    expect(recheckStep?.max_rounds).toBe(1)
  })

  it('writes custom max_rounds on fix and recheck steps', () => {
    const dir = join(workflowDir, 'maxrounds-custom')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck', maxRounds: 3 }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number }> }
    const fixStep = raw.steps.find(s => s.type === 'fix')
    const recheckStep = raw.steps.find(s => s.type === 'recheck')
    expect(fixStep?.max_rounds).toBe(3)
    expect(recheckStep?.max_rounds).toBe(3)
  })

  it('max_rounds does not apply to review-only preset (fix step absent)', () => {
    const dir = join(workflowDir, 'maxrounds-review-only')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only', maxRounds: 3 }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number }> }
    expect(raw.steps.length).toBe(1)
    expect(raw.steps[0].type).toBe('review')
  })

  it('patches max_rounds in-place when preset unchanged (preserves custom instructions)', () => {
    const dir = join(workflowDir, 'maxrounds-patch')
    mkdirSync(dir, { recursive: true })
    // Seed a workflow with custom instructions
    writeFileSync(join(dir, 'workflow.yml'), yaml.dump({
      on: ['opened', 'synchronize'],
      steps: [
        { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: 'my custom review instructions' },
        { name: 'fix', type: 'fix', reviewer: 'origin', when: "review.verdict != 'APPROVE'", max_rounds: 1, instructions: 'my custom fix instructions' },
        { name: 'recheck', type: 'recheck', reviewer: 'auto', when: 'fix.applied_count > 0', max_rounds: 1, instructions: 'my custom recheck instructions' },
      ],
    }))

    // Re-run onboard with max_rounds: 2 — must patch in-place, not regenerate
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck', maxRounds: 2 }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number; instructions?: string }> }

    // max_rounds updated on fix and recheck
    expect(raw.steps.find(s => s.type === 'fix')?.max_rounds).toBe(2)
    expect(raw.steps.find(s => s.type === 'recheck')?.max_rounds).toBe(2)
    // custom instructions preserved
    expect(raw.steps.find(s => s.type === 'review')?.instructions).toBe('my custom review instructions')
    expect(raw.steps.find(s => s.type === 'fix')?.instructions).toBe('my custom fix instructions')
    expect(raw.steps.find(s => s.type === 'recheck')?.instructions).toBe('my custom recheck instructions')
  })

  it('patches max_rounds when decreasing back to 1 (preserves custom instructions)', () => {
    const dir = join(workflowDir, 'maxrounds-downgrade')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'workflow.yml'), yaml.dump({
      on: ['opened', 'synchronize'],
      steps: [
        { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1, instructions: 'custom review' },
        { name: 'fix', type: 'fix', reviewer: 'origin', when: "review.verdict != 'APPROVE'", max_rounds: 3, instructions: 'custom fix' },
        { name: 'recheck', type: 'recheck', reviewer: 'auto', when: 'fix.applied_count > 0', max_rounds: 3, instructions: 'custom recheck' },
      ],
    }))

    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix-recheck', maxRounds: 1 }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number; instructions?: string }> }
    expect(raw.steps.find(s => s.type === 'fix')?.max_rounds).toBe(1)
    expect(raw.steps.find(s => s.type === 'recheck')?.max_rounds).toBe(1)
    expect(raw.steps.find(s => s.type === 'fix')?.instructions).toBe('custom fix')
    expect(raw.steps.find(s => s.type === 'recheck')?.instructions).toBe('custom recheck')
  })
})

describe('applyOnboardConfig — conflict-resolve', () => {
  it('conflictResolve: true prepends conflict-resolve step as first step', () => {
    const dir = join(workflowDir, 'cr-enabled')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: true }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string }> }
    expect(raw.steps[0].type).toBe('conflict-resolve')
    expect(raw.steps).toHaveLength(3)  // conflict-resolve + review + fix
  })

  it('conflictResolve: false does not add conflict-resolve step', () => {
    const dir = join(workflowDir, 'cr-disabled')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: false }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string }> }
    expect(raw.steps.some(s => s.type === 'conflict-resolve')).toBe(false)
    expect(raw.steps).toHaveLength(2)
  })

  it('enabling conflict-resolve on re-run regenerates workflow', () => {
    const dir = join(workflowDir, 'cr-enable-rerun')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: false }, dir)
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: true }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string }> }
    expect(raw.steps[0].type).toBe('conflict-resolve')
  })

  it('disabling conflict-resolve on re-run regenerates workflow', () => {
    const dir = join(workflowDir, 'cr-disable-rerun')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: true }, dir)
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-fix', conflictResolve: false }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string }> }
    expect(raw.steps.some(s => s.type === 'conflict-resolve')).toBe(false)
  })

  it('conflict-resolve has max_rounds: 3 and reviewer: origin', () => {
    const dir = join(workflowDir, 'cr-config')
    applyOnboardConfig(configPath, { ...BASE_DECISIONS, pipelinePreset: 'review-only', conflictResolve: true }, dir)
    const raw = yaml.load(readFileSync(join(dir, 'workflow.yml'), 'utf8')) as { steps: Array<{ type: string; max_rounds?: number; reviewer?: string }> }
    const crStep = raw.steps.find(s => s.type === 'conflict-resolve')
    expect(crStep?.max_rounds).toBe(3)
    expect(crStep?.reviewer).toBe('origin')
  })
})

describe('detectConflictResolveEnabled', () => {
  function seedWorkflow(content: string): void {
    mkdirSync(workflowDir, { recursive: true })
    writeFileSync(join(workflowDir, 'workflow.yml'), content)
  }

  it('returns false when no workflow file exists', () => {
    expect(detectConflictResolveEnabled(workflowDir)).toBe(false)
  })

  it('returns false when workflow has no conflict-resolve step', () => {
    seedWorkflow(yaml.dump({ on: ['opened'], steps: [{ name: 'review', type: 'review' }] }))
    expect(detectConflictResolveEnabled(workflowDir)).toBe(false)
  })

  it('returns true when workflow has a conflict-resolve step', () => {
    seedWorkflow(yaml.dump({
      on: ['opened'],
      steps: [
        { name: 'conflict-resolve', type: 'conflict-resolve' },
        { name: 'review', type: 'review' },
      ],
    }))
    expect(detectConflictResolveEnabled(workflowDir)).toBe(true)
  })

  it('returns false for malformed workflow', () => {
    seedWorkflow('not: valid: yaml: at all: [')
    expect(detectConflictResolveEnabled(workflowDir)).toBe(false)
  })
})
