import { describe, it, expect } from 'vitest'
import {
  resolveReviewStrategy,
  detectDomain,
  escalate,
  clampEffort,
  effortLevelsFor,
  isModelBanned,
  strategyModelFor,
  strategyVersion,
  ladderLimits,
} from '../lib/review-strategy.js'
import { resolveClaudeModel, resolveCodexModel, effectiveTier } from '../lib/review-models.js'
import type { CodexVendorConfig, QualityConfig } from '../config/schema.js'
import { ConfigSchema, CLAUDE_EFFORT_LEVELS, CODEX_EFFORT_LEVELS } from '../config/schema.js'
import { buildReviewCommentBody } from '../github/client.js'
import { parseAnnotation } from '../lib/annotation.js'
import { filterStepsByTypes } from '../lib/repo-workflow.js'
import { strategyDeterminedModel, strategyVendor, resolveRoundExecution } from '../lib/runner.js'
import { claudeEffort } from '../reviewers/claude.js'
import { codexReasoningEffort } from '../reviewers/codex.js'
import { tierTimeoutMs } from '../reviewers/tier-timeouts.js'

const pr = (files: string[], over: Partial<Parameters<typeof resolveReviewStrategy>[0]> = {}) =>
  resolveReviewStrategy({ files, additions: 100, deletions: 50, ...over })

describe('PR classification', () => {
  it('skips a lockfile-only PR entirely', () => {
    const r = pr(['package-lock.json', 'pnpm-lock.yaml'])
    expect(r.classId).toBe('generated')
    expect(r.tier).toBeNull()
    expect(r.steps).toEqual([])
  })

  it('promotes a security path to thorough', () => {
    const r = pr(['src/auth/session.ts'])
    expect(r.classId).toBe('risky')
    expect(r.tier).toBe('thorough')
    expect(r.steps).toEqual(['review', 'fix', 'recheck'])
  })

  it('promotes on a risk:T3 label even with innocuous paths', () => {
    const r = pr(['src/widget.ts'], { labels: ['risk:T3'] })
    expect(r.classId).toBe('risky')
    expect(r.tier).toBe('thorough')
  })

  it('promotes a hotfix targeting the default branch', () => {
    const r = pr(['src/widget.ts'], { title: 'hotfix(api): patch', baseRef: 'main', defaultBranch: 'main' })
    expect(r.classId).toBe('risky')
  })

  it('does not promote a hotfix targeting a non-default branch', () => {
    const r = pr(['src/widget.ts'], { title: 'hotfix(api): patch', baseRef: 'staging', defaultBranch: 'main' })
    expect(r.classId).not.toBe('risky')
  })

  // Ordering regression: `risky` must sit above every cheapening rule, or a
  // deletion of auth code falls through to `fast`.
  it('classifies a deletion of auth code as risky, not deletion-only', () => {
    const r = pr(['src/auth/legacy-session.ts'], { additions: 0, deletions: 400 })
    expect(r.classId).toBe('risky')
    expect(r.tier).toBe('thorough')
  })

  it('classifies a two-file migration as risky, not trivial', () => {
    const r = pr(['db/migrations/20260101_add.sql', 'src/x.ts'], { additions: 10, deletions: 2 })
    expect(r.classId).toBe('risky')
  })

  // Regression: `additions_max` alone matched a +2/-2 typo fix, because a small
  // edit also has near-zero additions. Deletion-only needs a floor on deletions.
  it('classifies a small edit as trivial, not deletion-only', () => {
    const r = pr(['src/widget.ts'], { additions: 2, deletions: 2 })
    expect(r.classId).toBe('trivial')
    expect(r.steps).toContain('fix')
  })

  it('classifies a pure deletion as deletion-only with no fix loop', () => {
    const r = pr(['src/widget.ts', 'src/helper.ts'], { additions: 0, deletions: 300 })
    expect(r.classId).toBe('deletion_only')
    expect(r.tier).toBe('fast')
    expect(r.steps).toEqual(['review'])
  })

  it('gives a docs PR review with no fix or recheck', () => {
    const r = pr(['docs/design.md', 'docs/adr/0001.md', 'src/x.ts'])
    expect(r.classId).toBe('docs')
    expect(r.steps).toEqual(['review'])
  })

  it('classifies a test-only PR as fast', () => {
    const r = pr(['src/__tests__/a.test.ts', 'src/__tests__/b.spec.ts'])
    expect(r.classId).toBe('test_only')
    expect(r.tier).toBe('fast')
  })

  it('classifies a small source change as trivial', () => {
    const r = pr(['src/widget.ts'], { additions: 20, deletions: 10 })
    expect(r.classId).toBe('trivial')
    expect(r.tier).toBe('fast')
  })

  it('falls through to standard for an ordinary change', () => {
    const r = pr(['src/a.ts', 'src/b.ts', 'src/c.ts', 'src/d.ts'], { additions: 400, deletions: 200 })
    expect(r.classId).toBe('standard')
    expect(r.tier).toBe('balanced')
  })

  it('falls through to standard when no files can be listed', () => {
    expect(pr([]).classId).toBe('standard')
  })

  it('carries a citable reason and the strategy version on every class', () => {
    const r = pr(['src/auth/x.ts'])
    expect(r.reason.length).toBeGreaterThan(10)
    expect(r.version).toBe(strategyVersion())
  })
})

describe('domain detection', () => {
  it('detects a frontend-dominant PR', () => {
    expect(detectDomain(['a.tsx', 'b.scss', 'c.ts'])).toBe('frontend')
  })

  it('detects a backend-dominant PR', () => {
    expect(detectDomain(['a.py', 'b.go', 'c.tsx'])).toBe('backend')
  })

  // Backend is the conservative default: its preference list is `measured`
  // while the frontend list is still a hypothesis.
  it('falls back to backend on a tie or when neither is present', () => {
    expect(detectDomain(['a.tsx', 'b.py'])).toBe('backend')
    expect(detectDomain(['README.md'])).toBe('backend')
    expect(detectDomain([])).toBe('backend')
  })
})

describe('escalation ladder', () => {
  it('leaves round 1 at the class tier', () => {
    expect(escalate({ tier: 'balanced', effort: 'medium' }, 1, 'claude-sonnet-5'))
      .toEqual({ tier: 'balanced', effort: 'medium' })
  })

  it('raises effort at round 2 and again at round 3, holding the model', () => {
    expect(escalate({ tier: 'balanced', effort: 'medium' }, 2, 'claude-sonnet-5'))
      .toEqual({ tier: 'balanced', effort: 'high' })
    expect(escalate({ tier: 'balanced', effort: 'medium' }, 3, 'claude-sonnet-5'))
      .toEqual({ tier: 'balanced', effort: 'xhigh' })
  })

  it('never weakens the model across rounds', () => {
    const out = escalate({ tier: 'thorough', effort: 'high' }, 3, 'claude-opus-5')
    expect(out.tier).toBe('thorough')
  })

  // The OpenCode case: most open-weight models expose no effort ladder, so the
  // effort step has to degrade to a model step or escalation silently no-ops.
  it('promotes a tier when the model has no effort control', () => {
    expect(effortLevelsFor('claude-haiku-4-5-20251001')).toEqual([])
    expect(escalate({ tier: 'fast', effort: null }, 2, 'claude-haiku-4-5-20251001'))
      .toEqual({ tier: 'balanced', effort: null })
  })

  it('caps tier promotion at thorough', () => {
    expect(escalate({ tier: 'thorough', effort: null }, 3, 'claude-haiku-4-5-20251001').tier)
      .toBe('thorough')
  })
})

describe('effort clamping', () => {
  it('passes through a supported level', () => {
    expect(clampEffort('claude-opus-5', 'xhigh')).toBe('xhigh')
  })

  it('returns null for a model with no effort parameter', () => {
    expect(clampEffort('claude-haiku-4-5-20251001', 'high')).toBeNull()
  })

  it('snaps down to the nearest supported level', () => {
    // deepseek exposes none/high/max — xhigh must snap down to high, not fail.
    expect(clampEffort('deepseek-v4-pro', 'xhigh')).toBe('high')
  })
})

describe('banned models', () => {
  it('bans claude-fable-5 from review', () => {
    expect(isModelBanned('claude-fable-5')).toBe(true)
    expect(isModelBanned('claude-opus-5')).toBe(false)
  })

  it('never routes a banned model from any vendor tier', () => {
    for (const vendor of ['claude', 'codex', 'opencode']) {
      for (const tier of ['fast', 'balanced', 'thorough'] as const) {
        const model = strategyModelFor(vendor, tier)
        expect(model).toBeTruthy()
        expect(isModelBanned(model!)).toBe(false)
      }
    }
  })
})

describe('model resolution honours the strategy', () => {
  const quality = (over: Partial<QualityConfig> = {}): QualityConfig =>
    ({ tier: 'balanced', mode: 'smart', focus: [], ...over }) as QualityConfig

  it('uses the strategy tier in smart mode', () => {
    expect(resolveClaudeModel(quality(), undefined, { tier: 'thorough' })).toBe('claude-opus-5')
    expect(resolveClaudeModel(quality(), undefined, { tier: 'fast' })).toBe('claude-haiku-4-5-20251001')
  })

  it('ignores the strategy tier in fixed mode', () => {
    expect(resolveClaudeModel(quality({ mode: 'fixed' }), undefined, { tier: 'thorough' }))
      .toBe('claude-sonnet-5')
  })

  it('falls back to the configured tier when no strategy resolved', () => {
    expect(effectiveTier(quality(), null)).toBe('balanced')
    expect(effectiveTier(quality(), { tier: null })).toBe('balanced')
  })

  it('routes thorough to opus-5, not the legacy opus-4-8', () => {
    expect(resolveClaudeModel(quality(), undefined, { tier: 'thorough' })).toBe('claude-opus-5')
  })

  // Regression: the old `auth !== 'api-key' → 'default'` guard discarded a
  // configured model, sending 81% of observed reviews out unpinned.
  it('honours a configured codex model under subscription auth', () => {
    const vendor = { enabled: true, model: 'gpt-5.6-sol', auth: 'subscription', effort: 'medium', timeout_sec: null, quality: 'medium' } as CodexVendorConfig
    expect(resolveCodexModel(quality(), vendor)).toBe('gpt-5.6-sol')
  })

  it('drives the codex tier model from the strategy under api-key auth', () => {
    const vendor = { enabled: true, model: null, auth: 'api-key', effort: 'medium', timeout_sec: null, quality: 'medium' } as CodexVendorConfig
    expect(resolveCodexModel(quality(), vendor, { tier: 'thorough' })).toBe('gpt-5.6-sol')
    expect(resolveCodexModel(quality(), vendor, { tier: 'fast' })).toBe('gpt-5.6-luna')
  })

  it('keeps the CLI default under subscription auth with nothing configured', () => {
    // The built-in tier mapping stays api-key-only on purpose: the gpt-5.6-*
    // IDs require codex >= 0.147.0 and would 400 on an older CLI, so a
    // subscription user with no model configured keeps the CLI's own default.
    const vendor = { enabled: true, model: null, auth: 'subscription', effort: 'medium', timeout_sec: null, quality: 'medium' } as CodexVendorConfig
    expect(resolveCodexModel(quality(), vendor, { tier: 'thorough' })).toBe('default')
  })

  it('drives model_tiers selection from the strategy under subscription auth', () => {
    const vendor = { enabled: true, model: null, auth: 'subscription', effort: 'medium', timeout_sec: null, quality: 'medium', model_tiers: { thorough: 'gpt-5.6-sol' } } as CodexVendorConfig
    expect(resolveCodexModel(quality(), vendor, { tier: 'thorough' })).toBe('gpt-5.6-sol')
    expect(resolveCodexModel(quality(), vendor, { tier: 'fast' })).toBe('default')
  })
})

describe('ladder limits', () => {
  it('bounds rounds, blocking findings, and wall clock', () => {
    const l = ladderLimits()
    expect(l.maxRounds).toBe(3)
    expect(l.maxBlocking).toBe(5)
    expect(l.maxWallClockMin).toBeGreaterThan(0)
  })
})

describe('strategy citation on the PR', () => {
  it('stamps version, class, and tier into the annotation', () => {
    const body = buildReviewCommentBody({
      body: 'findings', reviewer: 'claude', origin: 'codex', verdict: 'BLOCK',
      model: 'claude-opus-5', stepType: 'review', round: 1, sha: 'abc1234',
      strategy: { version: '1.0.0', classId: 'risky', tier: 'thorough', reason: 'touches a security path' },
    })
    expect(body).toContain('strategy=1.0.0')
    expect(body).toContain('class=risky')
    expect(body).toContain('tier=thorough')
    // Additive fields must not disturb the stable prefix other parsers read.
    expect(body).toMatch(/<!-- crosscheck: origin=codex reviewer=claude model=claude-opus-5 type=review round=1 verdict=BLOCK service=crosscheck/)
  })

  it('quotes the matched class reason so the routing decision is auditable', () => {
    const body = buildReviewCommentBody({
      body: 'findings', reviewer: 'claude', verdict: 'APPROVE', model: 'claude-opus-5',
      strategy: { version: '1.0.0', classId: 'risky', tier: 'thorough', reason: 'touches a security path' },
    })
    expect(body).toContain('thorough tier · touches a security path · strategy v1.0.0')
  })

  it('omits every strategy field under fixed mode', () => {
    const body = buildReviewCommentBody({
      body: 'findings', reviewer: 'claude', verdict: 'APPROVE', model: 'claude-sonnet-5',
    })
    expect(body).not.toContain('strategy=')
    expect(body).not.toContain('class=')
  })
})

describe('smart mode is the default', () => {
  // Regression: this default was silently lost in a squash merge, leaving every
  // config on `mode: undefined` while the docs advertised smart as the default.
  it('defaults quality.mode to smart on an empty config', () => {
    const quality = ConfigSchema.parse({}).quality
    expect(quality.mode).toBe('smart')
    expect(quality.tier).toBe('balanced')
  })

  it('lets an explicit fixed opt out', () => {
    expect(ConfigSchema.parse({ quality: { mode: 'fixed' } }).quality.mode).toBe('fixed')
  })
})

describe('citation only asserts what actually ran', () => {
  const strat = { version: '1.0.0', classId: 'risky', tier: 'thorough' as const, reason: 'security path' }

  // An explicit vendors.*.model outranks the tier map, so on a pinned config the
  // strategy's tier is not what ran. Citing it would assert a routing decision
  // that never happened — the property this feature exists to provide.
  it('withholds the citation when a pinned vendor model overrode the tier', () => {
    expect(strategyDeterminedModel({ model: 'gpt-5.6-terra' }, strat as never)).toBe(false)
    expect(strategyDeterminedModel({ model: null }, strat as never)).toBe(true)
  })

  it('withholds the citation under fixed mode', () => {
    expect(strategyDeterminedModel({ model: null }, null)).toBe(false)
  })
})

describe('strategy applies effort, not just tier', () => {
  // Regression: effort was resolved and logged but never sent, so the run line
  // named a level the CLI was never given.
  it('folds the class effort into the vendor config', () => {
    const vendor = { effort: 'medium' }
    const out = strategyVendor(vendor, { effort: 'high' } as never, CLAUDE_EFFORT_LEVELS)
    expect(out.effort).toBe('high')
  })

  it('leaves the vendor untouched when the class sets no effort', () => {
    const vendor = { effort: 'medium' }
    expect(strategyVendor(vendor, null, CLAUDE_EFFORT_LEVELS).effort).toBe('medium')
    expect(strategyVendor(vendor, { effort: null } as never, CLAUDE_EFFORT_LEVELS).effort).toBe('medium')
  })
})

describe('effort stays inside the vocabulary each vendor CLI accepts', () => {
  const roundStrategy = (round: number, model: string) => {
    const e = escalate({ tier: 'balanced', effort: 'medium' }, round, model)
    return { version: '1.0.0', classId: 'standard', reason: 'r', steps: [], domain: 'backend', ...e } as never
  }

  // Regression: round 3 asks for `xhigh`, which review-strategy.json lists as a
  // capability of claude-opus-5 — but vendors.claude.effort has no such level,
  // so claudeEffort() mapped the unknown value to `medium`. Round 3 then ran
  // WEAKER than round 2's `high`, inverting the ladder's one invariant.
  it('never sends claude a later round weaker than the round before', () => {
    const r2 = strategyVendor({ effort: 'medium' }, roundStrategy(2, 'claude-opus-5'), CLAUDE_EFFORT_LEVELS)
    const r3 = strategyVendor({ effort: 'medium' }, roundStrategy(3, 'claude-opus-5'), CLAUDE_EFFORT_LEVELS)
    expect(claudeEffort(r2.effort)).toBe('high')
    expect(claudeEffort(r3.effort)).toBe('high')
  })

  // Codex does expose xhigh, so clamping must not flatten it to claude's ceiling.
  it('passes xhigh through to codex, which accepts it', () => {
    const r3 = strategyVendor({ effort: 'medium' }, roundStrategy(3, 'gpt-5.6-sol'), CODEX_EFFORT_LEVELS)
    expect(codexReasoningEffort(r3.effort ?? '')).toBe('xhigh')
  })
})

describe('one round, one set of tier and effort decisions', () => {
  const config = (over: Record<string, unknown> = {}) => ConfigSchema.parse({ quality: { tier: 'balanced', mode: 'smart' }, ...over })
  const risky = { version: '1.0.0', classId: 'risky', reason: 'security path', tier: 'thorough', effort: 'high', steps: ['review', 'fix', 'recheck'], domain: 'backend' } as never

  it('applies the class tier to the whole round, not just the review', () => {
    const exec = resolveRoundExecution(config(), risky, 1)
    expect(exec.quality.tier).toBe('thorough')
    // The fix step reads its model AND its subprocess budget from this config;
    // a thorough model on the balanced 600s cap is cut off mid-fix.
    expect(tierTimeoutMs(exec.roundConfig.quality.tier)).toBe(tierTimeoutMs('thorough'))
    expect(exec.roundConfig.vendors.claude.effort).toBe('high')
  })

  // Regression: the review step ran the escalated round strategy while the fix
  // step re-folded the base class, so a promoted round fixed at the old tier.
  it('carries an escalated round into the config the fix step runs under', () => {
    const noEffortLadder = { ...(risky as unknown as Record<string, unknown>), tier: 'fast', effort: null } as never
    const exec = resolveRoundExecution(config(), noEffortLadder, 2)
    expect(exec.escalated).toBe(true)
    expect(exec.quality.tier).toBe(exec.roundConfig.quality.tier)
    expect(exec.strategy?.tier).toBe(exec.quality.tier)
  })

  it('leaves the config untouched under fixed mode', () => {
    const cfg = config({ quality: { tier: 'fast', mode: 'fixed' } })
    const exec = resolveRoundExecution(cfg, null, 3)
    expect(exec.quality.tier).toBe('fast')
    expect(exec.roundConfig).toBe(cfg)
    expect(exec.escalated).toBe(false)
  })
})

describe('annotation round-trips the citation', () => {
  it('parses strategy, class, and tier back out', () => {
    const body = buildReviewCommentBody({
      body: 'findings', reviewer: 'claude', origin: 'codex', verdict: 'BLOCK',
      model: 'claude-opus-5', stepType: 'review', round: 1,
      strategy: { version: '1.0.0', classId: 'risky', tier: 'thorough', reason: 'security path' },
    })
    const parsed = parseAnnotation(body)
    expect(parsed?.strategy).toBe('1.0.0')
    expect(parsed?.class).toBe('risky')
    expect(parsed?.tier).toBe('thorough')
  })
})

describe('class step sets narrow the pipeline', () => {
  const full: Array<{ name: string; type: string }> = [
    { name: 'conflict-resolve', type: 'conflict-resolve' },
    { name: 'review', type: 'review' },
    { name: 'fix', type: 'fix' },
    { name: 'recheck', type: 'recheck' },
  ]

  it('narrows a docs PR to review, dropping fix and recheck', () => {
    const kept = filterStepsByTypes(full as never, ['review'])
    expect(kept.map(s => s.type)).toEqual(['review'])
  })

  it('keeps conflict-resolve only when the depth permits code modification', () => {
    // review-only must not touch the code, so conflict-resolve goes too.
    expect(filterStepsByTypes(full as never, ['review']).map(s => s.type)).not.toContain('conflict-resolve')
    expect(filterStepsByTypes(full as never, ['review', 'fix']).map(s => s.type)).toContain('conflict-resolve')
  })

  // The class narrows; it never widens. A repo pinned to review-only stays
  // review-only however permissive the matched class is.
  it('cannot add a step the configured pipeline does not have', () => {
    const reviewOnly = [{ name: 'review', type: 'review' }]
    const kept = filterStepsByTypes(reviewOnly as never, ['review', 'fix', 'recheck'])
    expect(kept.map(s => s.type)).toEqual(['review'])
  })
})

describe('rounds escalate on measured non-convergence', () => {
  it('holds the class tier on round 1 and escalates after', () => {
    const base = { tier: 'balanced' as const, effort: 'medium' }
    expect(escalate(base, 1, 'claude-sonnet-5')).toEqual({ tier: 'balanced', effort: 'medium' })
    expect(escalate(base, 2, 'claude-sonnet-5').effort).toBe('high')
    expect(escalate(base, 3, 'claude-sonnet-5').effort).toBe('xhigh')
  })

  it('promotes the tier instead when the model has no effort ladder', () => {
    expect(escalate({ tier: 'fast', effort: null }, 2, 'claude-haiku-4-5-20251001'))
      .toEqual({ tier: 'balanced', effort: null })
  })
})

describe('codex under subscription auth', () => {
  const codex = (over: Partial<CodexVendorConfig> = {}): CodexVendorConfig =>
    ({ enabled: true, model: null, auth: 'subscription', effort: 'medium', quality: 'medium', timeout_sec: null, ...over }) as CodexVendorConfig
  const q = (tier: QualityConfig['tier']): QualityConfig => ({ tier, mode: 'smart', focus: [] }) as QualityConfig

  // Without model_tiers every tier collapses to the CLI's own default, so the
  // strategy's tier had no effect and must not be cited.
  it('collapses every tier to default with no model_tiers', () => {
    for (const tier of ['fast', 'balanced', 'thorough'] as const) {
      expect(resolveCodexModel(q(tier), codex())).toBe('default')
    }
  })

  it('withholds the citation when the resolved model is default', () => {
    const strat = { version: '1.0.0', classId: 'risky', tier: 'thorough' } as never
    expect(strategyDeterminedModel({ model: null }, strat, 'default')).toBe(false)
    expect(strategyDeterminedModel({ model: null }, strat, 'gpt-5.6-sol')).toBe(true)
  })

  // What onboard writes under smart, so tiers actually differ.
  it('varies by tier once model_tiers is written', () => {
    const v = codex({ model_tiers: { fast: 'gpt-5.6-luna', balanced: 'gpt-5.6-terra', thorough: 'gpt-5.6-sol' } })
    expect(resolveCodexModel(q('fast'), v)).toBe('gpt-5.6-luna')
    expect(resolveCodexModel(q('thorough'), v)).toBe('gpt-5.6-sol')
  })
})
