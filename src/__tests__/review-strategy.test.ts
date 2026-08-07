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
