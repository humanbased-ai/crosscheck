import { describe, it, expect } from 'vitest'
import {
  buildCodexOptimizeArgs,
  countInstructionDiffLines,
  deriveConfigChanges,
  selectOptimizeAgent,
} from '../commands/optimize.js'
import type { Config } from '../config/schema.js'
import type { DiagnoseReport } from '../commands/diagnose.js'

function makeConfig(claudeEnabled: boolean, codexEnabled: boolean): Config {
  return {
    mode: 'cross-vendor',
    clone_protocol: 'ssh',
    orgs: [],
    users: [],
    repos: [],
    routing: { codex_reviews_patterns: [], claude_reviews_patterns: [], claude_branch_prefixes: [], codex_branch_prefixes: [], allowed_authors: [], author_routes: {}, fallback_reviewer: 'auto' },
    server: { port: 7892, webhook_path: '/webhook' },
    quality: { tier: 'balanced', mode: 'fixed', focus: [], custom_prompt: undefined },
    budget: { codex_monthly_usd: null, per_review_usd: 1 },
    vendors: {
      claude: { enabled: claudeEnabled, model: null, auth: 'subscription', effort: 'medium', timeout_sec: null },
      codex: { enabled: codexEnabled, model: null, auth: 'subscription', effort: 'medium', quality: 'medium', timeout_sec: null },
    },
    logs: { enabled: false, retention_days: 7, extended: { enabled: false } },
    tunnel: { backend: 'localhost.run', smee_channel: '' },
    impact: { assumed_human_review_minutes: 60, hourly_rate_usd: 150, defect_cost_usd: 150 },
    backtrace: { enabled: false },
    issue_enrichment: { enabled: false, provider: 'linear', team_keys: [], max_description_chars: 4000 },
    linear: { enabled: false, auth: { mode: 'api_key', api_key_env: 'LINEAR_API_KEY', client_id_env: 'LINEAR_CLIENT_ID', client_secret_env: 'LINEAR_CLIENT_SECRET', scopes: 'read write' }, identity: { actor: 'crosscheck', signature: '🤖 {actor} · {product}' }, comment_on: ['APPROVE', 'NEEDS_WORK', 'BLOCK'], team_keys: [] },
    watch: { idle_issue: { enabled: true, timeout_min: 30 } },
    display: { theme: { bar_fill: 'blue', bar_empty: 'dim', cr_approve: 'green', cr_needs_work: 'yellow', cr_block: 'red', fix_fill: 'cyan' } },
    post_review: {
      auto_fix: {
        delivery: { mode: 'pull_request', pr_title: 'fix: address CR issues in #{original_pr_title}', label: 'cr-autofix' },
      },
    },
    brand: { service_name: 'crosscheck', comment_header: '', comment_footer: '', reviewer_attribution: '' },
  }
}

function makeReport(
  claudeAttempts = 0, claudeSuccesses = 0,
  codexAttempts = 0, codexSuccesses = 0,
): DiagnoseReport {
  const performance: Record<string, { attempts: number; successes: number; failure_rate: number }> = {}
  if (claudeAttempts > 0) {
    performance['claude'] = {
      attempts: claudeAttempts,
      successes: claudeSuccesses,
      failure_rate: (claudeAttempts - claudeSuccesses) / claudeAttempts,
    }
  }
  if (codexAttempts > 0) {
    performance['codex'] = {
      attempts: codexAttempts,
      successes: codexSuccesses,
      failure_rate: (codexAttempts - codexSuccesses) / codexAttempts,
    }
  }
  return {
    period: { from: 'N/A', to: 'N/A', log_files: 0 },
    summary: { total_reviews: 0, successful: 0, failed: 0, failure_rate: 0 },
    errors: [],
    verdict_distribution: { APPROVE: 0, NEEDS_WORK: 0, BLOCK: 0 },
    verdict_parse_failures: 0,
    repos_seen: [],
    languages_detected: [],
    reviewer_performance: performance,
    suggestions: [],
  }
}

describe('selectOptimizeAgent', () => {
  it('returns codex when only codex is enabled', () => {
    const { agent } = selectOptimizeAgent(makeConfig(false, true), makeReport())
    expect(agent).toBe('codex')
  })

  it('returns claude when only claude is enabled', () => {
    const { agent } = selectOptimizeAgent(makeConfig(true, false), makeReport())
    expect(agent).toBe('claude')
  })

  it('returns claude as default when both enabled and no log data', () => {
    const { agent, reason } = selectOptimizeAgent(makeConfig(true, true), makeReport())
    expect(agent).toBe('claude')
    expect(reason).toMatch(/default/)
  })

  it('returns codex when both enabled and codex has higher success rate', () => {
    // codex 80%, claude 50%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 5, 10, 8))
    expect(agent).toBe('codex')
  })

  it('returns claude when both enabled and claude has higher success rate', () => {
    // claude 90%, codex 60%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 9, 10, 6))
    expect(agent).toBe('claude')
  })

  it('returns claude (default) when both enabled and rates are equal', () => {
    // both 70%
    const { agent } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 7, 10, 7))
    expect(agent).toBe('claude')
  })

  it('throws when no vendors are enabled', () => {
    expect(() => selectOptimizeAgent(makeConfig(false, false), makeReport())).toThrow(/No vendors enabled/)
  })

  it('reason string mentions source when only one vendor enabled', () => {
    const { reason } = selectOptimizeAgent(makeConfig(true, false), makeReport())
    expect(reason).toMatch(/only enabled vendor/)
  })

  it('reason string includes success rates when chosen by data', () => {
    const { reason } = selectOptimizeAgent(makeConfig(true, true), makeReport(10, 5, 10, 8))
    expect(reason).toMatch(/80%/)
    expect(reason).toMatch(/50%/)
  })
})

describe('deriveConfigChanges', () => {
  function makeFullConfig(tier: 'fast' | 'balanced' | 'thorough', budgetUsd = 2): Config {
    return {
      ...makeConfig(true, true),
      quality: { tier, mode: 'fixed', focus: [], custom_prompt: undefined },
      budget: { codex_monthly_usd: null, per_review_usd: budgetUsd },
    }
  }

  function reportWithSuggestions(suggestions: DiagnoseReport['suggestions']): DiagnoseReport {
    return {
      ...makeReport(),
      suggestions,
    }
  }

  it('proposes quality.tier downgrade on timeout suggestion', () => {
    const report = reportWithSuggestions([
      { type: 'config_change', reason: 'review timed out ×20 — consider lowering quality.tier to "fast" or "balanced"' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('thorough'))
    expect(changes).toHaveLength(1)
    expect(changes[0].field).toBe('quality.tier')
    expect(changes[0].oldValue).toBe('thorough')
    expect(changes[0].newValue).toBe('balanced')
  })

  it('steps down balanced → fast on timeout', () => {
    const report = reportWithSuggestions([
      { type: 'config_change', reason: 'review timed out ×5 — lower quality.tier' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('balanced'))
    expect(changes[0].newValue).toBe('fast')
  })

  it('produces no tier change when already at fast', () => {
    const report = reportWithSuggestions([
      { type: 'config_change', reason: 'review timed out ×5' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('fast'))
    expect(changes.filter(c => c.field === 'quality.tier')).toHaveLength(0)
  })

  it('proposes budget.per_review_usd doubling on budget suggestion', () => {
    const report = reportWithSuggestions([
      { type: 'config_change', reason: 'per-review budget exhausted ×2 — raise the budget cap' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('balanced', 1))
    const budgetChange = changes.find(c => c.field === 'budget.per_review_usd')
    expect(budgetChange).toBeDefined()
    expect(budgetChange!.oldValue).toBe('1')
    expect(budgetChange!.newValue).toBe('2')
  })

  it('deduplicates: only one tier change even with multiple timeout suggestions', () => {
    const report = reportWithSuggestions([
      { type: 'config_change', reason: 'review timed out ×10' },
      { type: 'config_change', reason: 'review timed out ×5' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('thorough'))
    expect(changes.filter(c => c.field === 'quality.tier')).toHaveLength(1)
  })

  it('ignores investigate and add_constraint suggestions', () => {
    const report = reportWithSuggestions([
      { type: 'investigate', reason: 'transient vendor-capacity errors' },
      { type: 'add_constraint', instruction: 'Do not run tsc.', reason: 'tsc not found ×3' },
    ])
    const changes = deriveConfigChanges(report, makeFullConfig('thorough'))
    expect(changes).toHaveLength(0)
  })
})

describe('optimize helpers', () => {
  it('runs codex optimize from a temporary non-git directory', () => {
    const args = buildCodexOptimizeArgs('/tmp/out.txt')
    expect(args).toContain('--skip-git-repo-check')
    expect(args).toEqual(expect.arrayContaining(['-o', '/tmp/out.txt']))
  })

  it('counts ANSI-colored instruction diff changes', () => {
    const diff = [
      '\u001b[32m+new instruction\u001b[39m',
      '\u001b[31m-old instruction\u001b[39m',
      ' unchanged',
    ].join('\n')

    expect(countInstructionDiffLines(diff)).toEqual({ additions: 1, deletions: 1 })
  })
})
