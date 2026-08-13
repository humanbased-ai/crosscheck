import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  isRetryableFixError,
  getEffectiveStepType,
  exceedsMaxRounds,
  anyFixApplied,
  countCrosscheckCommitsForPR,
  countCrosscheckCommitsForPRDetailed,
  buildWorkflowCompleteEvent,
  resolveFixVendor,
  resolveConflictResolveVendor,
  summariseStepOutcomes,
  mergeStepOutcomes,
  resolveFixLanding,
} from '../lib/runner.js'
import type { StepResult } from '../lib/workflow.js'

describe('isRetryableFixError', () => {
  it('returns false for auth failure errors', () => {
    expect(isRetryableFixError(new Error('claude auth failure during fix step — run: claude auth login'))).toBe(false)
    expect(isRetryableFixError(new Error('not logged in'))).toBe(false)
    expect(isRetryableFixError(new Error('auth failure: bad credentials'))).toBe(false)
  })

  it('returns true for timeout errors', () => {
    expect(isRetryableFixError(new Error('Command timed out after 180000 milliseconds: claude --print --output-format json'))).toBe(true)
    expect(isRetryableFixError(new Error('spawnSync claude ETIMEDOUT'))).toBe(true)
  })

  it('returns false for credit and quota limit errors', () => {
    expect(isRetryableFixError(new Error('claude: usage limit exceeded'))).toBe(false)
    expect(isRetryableFixError(new Error('codex: 429 Too Many Requests'))).toBe(false)
    expect(isRetryableFixError(new Error('quota exceeded'))).toBe(false)
  })

  it('returns true for subprocess exit errors', () => {
    expect(isRetryableFixError(new Error('Command failed: claude --print --output-format text'))).toBe(true)
  })

  it('returns true for unknown/unexpected errors', () => {
    expect(isRetryableFixError(new Error('something unexpected happened'))).toBe(true)
  })

  it('handles non-Error thrown values', () => {
    expect(isRetryableFixError('timeout string')).toBe(true)
    expect(isRetryableFixError('auth failure: bad token')).toBe(false)
    expect(isRetryableFixError(null)).toBe(true)
  })
})

describe('resolveFixLanding', () => {
  it('commit mode lands on the PR branch with no fallback', () => {
    expect(resolveFixLanding('commit')).toBe('branch')
  })

  it('pull_request mode lands on the PR branch but may fall back to a separate PR', () => {
    // The key behavior fix: pull_request no longer means "always a separate PR".
    // It lands on the original branch first, keeping fix+recheck+approval on one PR,
    // and only opens a follow-up PR when the branch push can't land.
    expect(resolveFixLanding('pull_request')).toBe('branch-then-separate-pr')
  })

  it('comment mode never pushes', () => {
    expect(resolveFixLanding('comment')).toBe('comment')
  })
})

describe('exceedsMaxRounds', () => {
  it('returns false when round is undefined (no tracking)', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, undefined)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, undefined)).toBe(false)
  })

  it('skips fix step when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('fix', 'fix', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('fix', 'fix', 1, 1)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 2)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', 2, 3)).toBe(true)
  })

  it('skips recheck step (from workflow) when round exceeds max_rounds', () => {
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 2)).toBe(true)
    expect(exceedsMaxRounds('recheck', 'recheck', 1, 1)).toBe(false)
  })

  it('never skips a review step coerced to recheck (always runs assessment)', () => {
    expect(exceedsMaxRounds('recheck', 'review', 1, 2)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'review', 1, 99)).toBe(false)
  })

  it('never skips a plain review step', () => {
    expect(exceedsMaxRounds('review', 'review', 1, 2)).toBe(false)
  })

  it('never skips when overrideMaxRounds is Infinity (crazy/halfcrazy mode)', () => {
    // --crazy / --halfcrazy pass Infinity as the effective maxRounds; step.max_rounds is ignored
    expect(exceedsMaxRounds('fix', 'fix', Infinity, 99)).toBe(false)
    expect(exceedsMaxRounds('recheck', 'recheck', Infinity, 99)).toBe(false)
    expect(exceedsMaxRounds('fix', 'fix', Infinity, 1)).toBe(false)
  })
})

// Gates whether a recheck step following a review in the SAME session has anything
// to evaluate. Critical for fix-less depths (per-repo `review,recheck`): there the
// recheck's `fix.applied_count > 0` guard names a step that isn't in the workflow,
// and evaluateWhen fails open on missing results — so this is the only thing
// stopping a duplicate recheck on the freshly reviewed SHA.
describe('anyFixApplied', () => {
  it('is false before any step has run', () => {
    expect(anyFixApplied({})).toBe(false)
  })

  it('is false after a review-only session (no applied_count recorded)', () => {
    expect(anyFixApplied({ review: { verdict: 'NEEDS_WORK' } })).toBe(false)
  })

  it('is false when a fix ran but applied nothing', () => {
    expect(anyFixApplied({ review: { verdict: 'NEEDS_WORK' }, fix: { applied_count: 0 } })).toBe(false)
  })

  it('is true once a fix applied at least one change', () => {
    expect(anyFixApplied({ review: { verdict: 'NEEDS_WORK' }, fix: { applied_count: 1 } })).toBe(true)
  })

  it('counts a conflict-resolve step that applied changes', () => {
    expect(anyFixApplied({ 'conflict-resolve': { applied_count: 3 } })).toBe(true)
  })

  it('ignores skipped steps', () => {
    expect(anyFixApplied({ fix: { skipped: true } })).toBe(false)
  })
})

describe('countCrosscheckCommitsForPR', () => {
  let tmpDir: string

  // Build a repo with a `base` branch carrying [crosscheck] commits (simulating
  // a long-lived branch like staging) and a `head` branch ahead of it. The
  // count must include only commits unique to head.
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })

  const commit = (file: string, content: string, message: string): void => {
    writeFileSync(join(tmpDir, file), content)
    git('add', file)
    git('commit', '-m', message)
  }

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-runner-test-'))
    git('init', '-q', '-b', 'base')
    git('config', 'user.email', 'test@example.com')
    git('config', 'user.name', 'Test')
    git('config', 'commit.gpgsign', 'false')

    // base branch: 6 [crosscheck] commits from prior merged PRs
    commit('seed.txt', 'seed\n', 'chore: initial')
    for (let i = 0; i < 6; i++) {
      commit(`base${i}.txt`, `b${i}\n`, `[crosscheck] fix from prior PR #${i}`)
    }

    // Promote base into refs/remotes/origin/base so the helper's
    // `origin/<base>..HEAD` range resolves the same way it does in production
    // (clone.ts fetches the base ref into refs/remotes/origin/<base>).
    git('update-ref', 'refs/remotes/origin/base', 'base')

    // head branch ahead of base
    git('checkout', '-q', '-b', 'feature')
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  // The scoped/unscoped distinction matters because an unscoped count is an
  // over-count of whole-repo history, not a real cap hit. Reporting the two
  // identically made a transient base-fetch failure look like "you have already
  // had 5 fixes", which silently disabled auto-fix on every repo with prior
  // [crosscheck] commits.
  describe('scoped vs unscoped reporting', () => {
    it('reports scoped: true when origin/<base> resolves', () => {
      commit('a.txt', 'a\n', '[crosscheck] fix round 1')
      expect(countCrosscheckCommitsForPRDetailed(tmpDir, 'base')).toEqual({ count: 1, scoped: true })
    })

    it('reports scoped: false and over-counts when origin/<base> is missing', () => {
      commit('a.txt', 'a\n', '[crosscheck] fix round 1')
      git('update-ref', '-d', 'refs/remotes/origin/base')

      const result = countCrosscheckCommitsForPRDetailed(tmpDir, 'base')
      expect(result.scoped).toBe(false)
      // 6 inherited from base history + 1 on this branch — none of the 6 are ours.
      expect(result.count).toBe(7)
    })

    it('still fails closed: the over-count trips the cap rather than bypassing it', () => {
      git('update-ref', '-d', 'refs/remotes/origin/base')
      expect(countCrosscheckCommitsForPRDetailed(tmpDir, 'base').count).toBeGreaterThanOrEqual(5)
    })

    it('keeps the scalar helper behaviour identical for existing callers', () => {
      commit('a.txt', 'a\n', '[crosscheck] fix round 1')
      expect(countCrosscheckCommitsForPR(tmpDir, 'base'))
        .toBe(countCrosscheckCommitsForPRDetailed(tmpDir, 'base').count)
    })
  })

  it('counts only [crosscheck] commits ahead of base (ignores base history)', () => {
    // Two fix commits on this PR — base has 6 prior crosscheck commits we must ignore
    commit('a.txt', 'a\n', '[crosscheck] fix round 1')
    commit('b.txt', 'b\n', '[crosscheck] fix round 2')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(2)
  })

  it('returns 0 when the PR has no crosscheck commits, even if base has many', () => {
    commit('feat.txt', 'feat\n', 'feat: human work only')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(0)
  })

  it('ignores non-crosscheck commits on the PR branch', () => {
    commit('feat.txt', 'feat\n', 'feat: add thing')
    commit('a.txt', 'a\n', '[crosscheck] fix one')
    commit('docs.txt', 'docs\n', 'docs: update readme')
    expect(countCrosscheckCommitsForPR(tmpDir, 'base')).toBe(1)
  })

  it('falls back to full-history count when origin/<base> does not exist (fail closed)', () => {
    // 6 [crosscheck] commits on base + 1 on feature = 7 total in the branch
    // history. If the scoped range fails, we must still see them so the
    // 5-commit cap trips rather than silently passing.
    commit('a.txt', 'a\n', '[crosscheck] fix one')
    expect(countCrosscheckCommitsForPR(tmpDir, 'nonexistent-branch')).toBe(7)
  })

  it('returns 0 only when neither the scoped range nor the full history is readable', () => {
    // Point tmpDir at a non-repo location — both git invocations will fail.
    const nonRepo = mkdtempSync(join(tmpdir(), 'crosscheck-not-a-repo-'))
    try {
      expect(countCrosscheckCommitsForPR(nonRepo, 'main')).toBe(0)
    } finally {
      rmSync(nonRepo, { force: true, recursive: true })
    }
  })
})

describe('getEffectiveStepType', () => {
  it('coerces review → recheck when isRecheckRun is true', () => {
    expect(getEffectiveStepType('review', true)).toBe('recheck')
  })

  it('preserves review when isRecheckRun is false', () => {
    expect(getEffectiveStepType('review', false)).toBe('review')
  })

  it('preserves fix regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('fix', true)).toBe('fix')
    expect(getEffectiveStepType('fix', false)).toBe('fix')
  })

  it('preserves recheck regardless of isRecheckRun', () => {
    expect(getEffectiveStepType('recheck', true)).toBe('recheck')
    expect(getEffectiveStepType('recheck', false)).toBe('recheck')
  })
})

describe('buildWorkflowCompleteEvent', () => {
  const base = {
    owner: 'o', repoName: 'r', prNumber: 1,
    workflowId: 'wf-123',
    workflowStart: 1000,
    stepsRun: ['review', 'fix', 'recheck'],
    results: {
      review:  { verdict: 'NEEDS_WORK' as const, commentBody: 'x' },
      fix:     { applied_count: 1 },
      recheck: { verdict: 'APPROVE' as const, commentBody: 'y' },
    },
    workflowFailed: false,
    now: 1500,
  }

  it('emits ended_reason=completed and level=info on a clean run', () => {
    const ev = buildWorkflowCompleteEvent(base)
    expect(ev.event).toBe('workflow_complete')
    expect(ev.ended_reason).toBe('completed')
    expect(ev.level).toBe('info')
    expect(ev.workflow_id).toBe('wf-123')
    expect(ev.repo).toBe('o/r')
    expect(ev.pr).toBe(1)
  })

  it('emits ended_reason=error and level=warn when workflowFailed is true', () => {
    const ev = buildWorkflowCompleteEvent({ ...base, workflowFailed: true })
    expect(ev.ended_reason).toBe('error')
    expect(ev.level).toBe('warn')
  })

  // The verdict picked is the LATEST step that produced one, scanning in
  // reverse. This is how runWorkflow itself computes the return value, so
  // a downstream join on workflow_id <-> verdict stays consistent.
  it('picks last_verdict from the most recent step that produced a verdict', () => {
    const ev = buildWorkflowCompleteEvent(base)
    expect(ev.last_verdict).toBe('APPROVE')
  })

  it('picks last_step from the last entry in stepsRun', () => {
    const ev = buildWorkflowCompleteEvent(base)
    expect(ev.last_step).toBe('recheck')
  })

  // Edge case: a workflow that throws before any step ran (e.g., loadWorkflow
  // failed). stepsRun is empty; lastStep is null, not undefined or crash.
  it('returns last_step=null when stepsRun is empty', () => {
    const ev = buildWorkflowCompleteEvent({ ...base, stepsRun: [], results: {} })
    expect(ev.last_step).toBeNull()
    expect(ev.last_verdict).toBeNull()
    expect(ev.steps_run).toEqual([])
  })

  it('returns last_verdict=null when no step produced a verdict', () => {
    const ev = buildWorkflowCompleteEvent({
      ...base, results: { fix: { applied_count: 0 } },
    })
    expect(ev.last_verdict).toBeNull()
  })

  it('computes total_duration_ms from injected now minus workflowStart', () => {
    const ev = buildWorkflowCompleteEvent({ ...base, now: 4000, workflowStart: 1000 })
    expect(ev.total_duration_ms).toBe(3000)
  })

  it('includes round when provided, omits it otherwise', () => {
    const withRound = buildWorkflowCompleteEvent({ ...base, round: 2 })
    expect(withRound.round).toBe(2)

    const withoutRound = buildWorkflowCompleteEvent(base)
    expect('round' in withoutRound).toBe(false)
  })

  it('preserves steps_run order so consumers can read the workflow shape', () => {
    const ev = buildWorkflowCompleteEvent({
      ...base, stepsRun: ['custom-review', 'gate-check', 'apply-fixes', 'final-pass'],
    })
    expect(ev.steps_run).toEqual(['custom-review', 'gate-check', 'apply-fixes', 'final-pass'])
  })

  it('aggregates total_tokens and splits when steps carry token data', () => {
    const ev = buildWorkflowCompleteEvent({
      ...base,
      results: {
        review:  { verdict: 'NEEDS_WORK', tokens_used: 5000, input_tokens: 4000, output_tokens: 1000, vendor: 'codex' },
        fix:     { applied_count: 2, tokens_used: 8000, vendor: 'claude' },
        recheck: { verdict: 'APPROVE', tokens_used: 3000, input_tokens: 2500, output_tokens: 500, vendor: 'codex' },
      },
    })
    expect(ev.total_tokens).toBe(16000)
    expect(ev.total_input_tokens).toBe(6500)
    expect(ev.total_output_tokens).toBe(1500)
  })

  it('omits total_tokens when no step has token data', () => {
    const ev = buildWorkflowCompleteEvent(base)
    expect('total_tokens' in ev).toBe(false)
  })

  it('omits split fields when no step has input/output token splits', () => {
    const ev = buildWorkflowCompleteEvent({
      ...base,
      results: {
        review: { verdict: 'NEEDS_WORK', tokens_used: 5000, vendor: 'codex' },
        fix:    { applied_count: 1, tokens_used: 3000, vendor: 'claude' },
      },
    })
    expect(ev.total_tokens).toBe(8000)
    expect('total_input_tokens' in ev).toBe(false)
    expect('total_output_tokens' in ev).toBe(false)
  })

  it('collects unique vendors_used across steps', () => {
    const ev = buildWorkflowCompleteEvent({
      ...base,
      results: {
        review:  { verdict: 'NEEDS_WORK', vendor: 'codex' },
        fix:     { applied_count: 1, vendor: 'claude' },
        recheck: { verdict: 'APPROVE', vendor: 'codex' },
      },
    })
    expect(ev.vendors_used).toEqual(expect.arrayContaining(['codex', 'claude']))
    expect((ev.vendors_used as string[]).length).toBe(2)
  })

  it('includes quality_tier when provided', () => {
    const ev = buildWorkflowCompleteEvent({ ...base, qualityTier: 'thorough' })
    expect(ev.quality_tier).toBe('thorough')
    const without = buildWorkflowCompleteEvent(base)
    expect('quality_tier' in without).toBe(false)
  })
})

describe('resolveFixVendor', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = (claudeEnabled: boolean, codexEnabled: boolean, fallbackReviewer: 'auto' | 'claude' | 'codex' | null = 'auto') => ({
    vendors: {
      claude: { enabled: claudeEnabled },
      codex: { enabled: codexEnabled },
    },
    routing: { fallback_reviewer: fallbackReviewer },
  }) as any

  describe('human-origin fallback — respects routing.fallback_reviewer', () => {
    it('auto (default): prefers codex when both enabled', () => {
      // 'auto' mirrors resolveReviewer auto path: codex-first config-enabled check
      expect(resolveFixVendor('origin', 'human', cfg(true, true))).toEqual({ vendor: 'codex', usedHumanFallback: true })
    })

    it('auto: falls to claude when codex disabled', () => {
      expect(resolveFixVendor('origin', 'human', cfg(true, false))).toEqual({ vendor: 'claude', usedHumanFallback: true })
    })

    it('explicit claude: uses claude regardless of codex availability', () => {
      expect(resolveFixVendor('origin', 'human', cfg(true, true, 'claude'))).toEqual({ vendor: 'claude', usedHumanFallback: true })
    })

    it('explicit codex: uses codex when enabled', () => {
      expect(resolveFixVendor('origin', 'human', cfg(true, true, 'codex'))).toEqual({ vendor: 'codex', usedHumanFallback: true })
    })

    it('explicit codex disabled: returns null rather than falling to claude', () => {
      expect(resolveFixVendor('origin', 'human', cfg(true, false, 'codex'))).toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('null fallback_reviewer: skips fix (no fallback)', () => {
      expect(resolveFixVendor('origin', 'human', cfg(true, true, null))).toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('returns null when both vendors disabled regardless of fallback_reviewer', () => {
      expect(resolveFixVendor('origin', 'human', cfg(false, false))).toEqual({ vendor: null, usedHumanFallback: false })
    })
  })

  describe('scoped to reviewer:origin only', () => {
    it('reviewer:claude with human origin resolves via resolveReviewer, no fallback', () => {
      expect(resolveFixVendor('claude', 'human', cfg(true, true))).toEqual({ vendor: 'claude', usedHumanFallback: false })
      expect(resolveFixVendor('claude', 'human', cfg(false, true))).toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('reviewer:auto with human origin uses resolveReviewer auto path, no fallback', () => {
      expect(resolveFixVendor('auto', 'human', cfg(true, true))).toEqual({ vendor: 'codex', usedHumanFallback: false })
    })
  })

  describe('non-human origins — unchanged behaviour', () => {
    it('returns codex for codex-origin with reviewer:origin', () => {
      expect(resolveFixVendor('origin', 'codex', cfg(true, true))).toEqual({ vendor: 'codex', usedHumanFallback: false })
    })

    it('returns claude for claude-origin with reviewer:origin', () => {
      expect(resolveFixVendor('origin', 'claude', cfg(true, true))).toEqual({ vendor: 'claude', usedHumanFallback: false })
    })
  })

  describe('smartSwitchFallback takes precedence', () => {
    it('smartSwitchFallback resolves via resolveReviewer before human-origin branch fires', () => {
      // reviewer:origin + origin:human + smartSwitchFallback='codex' → resolveReviewer returns
      // 'codex' directly, so usedHumanFallback is false even though origin is human
      expect(resolveFixVendor('origin', 'human', cfg(false, true), 'codex')).toEqual({ vendor: 'codex', usedHumanFallback: false })
    })
  })
})

describe('resolveConflictResolveVendor', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const cfg = (claudeEnabled: boolean, codexEnabled: boolean, fallbackReviewer: 'auto' | 'claude' | 'codex' | null = 'auto') => ({
    vendors: {
      claude: { enabled: claudeEnabled },
      codex: { enabled: codexEnabled },
    },
    routing: { fallback_reviewer: fallbackReviewer },
  }) as any

  describe('human-origin fallback — the no_vendor regression', () => {
    // The default workflow gives conflict-resolve `reviewer: origin`. A PR whose
    // origin cannot be attributed resolved to null and skipped with 'no_vendor',
    // even with routing.fallback_reviewer set — the fix step honoured it, this
    // step did not.
    it('explicit claude: resolves instead of skipping with no_vendor', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(true, true, 'claude')))
        .toEqual({ vendor: 'claude', usedHumanFallback: true })
    })

    it('auto: picks claude even with codex enabled — codex cannot resolve conflicts', () => {
      // Diverges from resolveFixVendor's codex-first auto path on purpose: routing
      // to codex here only trades a 'no_vendor' skip for a
      // 'codex_conflict_resolve_unsupported' one.
      expect(resolveConflictResolveVendor('origin', 'human', cfg(true, true)))
        .toEqual({ vendor: 'claude', usedHumanFallback: true })
    })

    it('auto with claude disabled: no vendor supports the step', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(false, true)))
        .toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('explicit codex: honoured, so the caller reports the precise unsupported skip', () => {
      // An explicit fallback_reviewer is an operator decision. Silently swapping it
      // for claude would hide a misconfiguration behind a step that works anyway.
      expect(resolveConflictResolveVendor('origin', 'human', cfg(true, true, 'codex')))
        .toEqual({ vendor: 'codex', usedHumanFallback: true })
    })

    it('null fallback_reviewer: still skips — opting out stays opt-out', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(true, true, null)))
        .toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('explicit claude but claude disabled: no fallback invented', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(false, true, 'claude')))
        .toEqual({ vendor: null, usedHumanFallback: false })
    })

    it('returns null when both vendors disabled regardless of fallback_reviewer', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(false, false)))
        .toEqual({ vendor: null, usedHumanFallback: false })
    })
  })

  describe('scoped to reviewer:origin only', () => {
    it('reviewer:claude with human origin resolves directly, no fallback', () => {
      expect(resolveConflictResolveVendor('claude', 'human', cfg(true, true)))
        .toEqual({ vendor: 'claude', usedHumanFallback: false })
    })

    it('reviewer:auto with human origin uses the resolveReviewer auto path unchanged', () => {
      // 'auto' encodes explicit intent, so it keeps resolveReviewer's codex-first
      // path and the caller skips with codex_conflict_resolve_unsupported.
      expect(resolveConflictResolveVendor('auto', 'human', cfg(true, true)))
        .toEqual({ vendor: 'codex', usedHumanFallback: false })
    })
  })

  describe('attributed origins', () => {
    it('claude origin resolves to claude', () => {
      expect(resolveConflictResolveVendor('origin', 'claude', cfg(true, true)))
        .toEqual({ vendor: 'claude', usedHumanFallback: false })
    })

    // Regression (#284): `Crosscheck-Reviewer: codex` detection makes a
    // crosscheck-authored Codex fix PR resolve to origin 'codex'. Conflict
    // resolution is Claude-only, so returning codex would skip the step and leave
    // the PR's conflicts unresolved (before #284 these PRs were 'human' and the
    // auto fallback picked Claude). Because the assignment came from origin
    // detection, substitute the capable vendor rather than skip.
    it('codex origin substitutes claude — codex cannot resolve conflicts', () => {
      expect(resolveConflictResolveVendor('origin', 'codex', cfg(true, true)))
        .toEqual({ vendor: 'claude', usedHumanFallback: false, substitutedOriginVendor: 'codex' })
    })

    it('codex origin with claude disabled: no capable vendor, stays codex so the caller reports the precise skip', () => {
      expect(resolveConflictResolveVendor('origin', 'codex', cfg(false, true)))
        .toEqual({ vendor: 'codex', usedHumanFallback: false })
    })
  })

  describe('smartSwitchFallback takes precedence', () => {
    it('resolves via resolveReviewer before the human-origin branch fires', () => {
      expect(resolveConflictResolveVendor('origin', 'human', cfg(true, true, 'claude'), 'codex'))
        .toEqual({ vendor: 'codex', usedHumanFallback: false })
    })
  })
})

describe('summariseStepOutcomes', () => {
  const results = (entries: Record<string, StepResult>): Record<string, StepResult> => entries

  it('separates steps that ran from steps that skipped', () => {
    const out = summariseStepOutcomes(['review', 'fix', 'recheck'], results({
      review: { verdict: 'BLOCK' },
      fix: { applied_count: 2 },
      recheck: { skipped: true, skipReason: 'when_condition' },
    }))
    expect(out.ran).toEqual(['review', 'fix'])
    expect(out.skipped).toEqual([{ step: 'recheck', reason: 'when_condition' }])
  })

  // The reported defect: `crosscheck resolve` dispatches conflict-resolve alone,
  // it skips for want of a vendor, and verdict is null either way — so only the
  // empty `ran` list distinguishes this from a review that found nothing.
  it('reports an empty ran list when every dispatched step skipped', () => {
    const out = summariseStepOutcomes(['conflict-resolve'], results({
      'conflict-resolve': { skipped: true, skipReason: 'no_vendor' },
    }))
    expect(out.ran).toEqual([])
    expect(out.skipped).toEqual([{ step: 'conflict-resolve', reason: 'no_vendor' }])
  })

  it('counts a dispatched step with no recorded result as ran', () => {
    // Absence of a result is not evidence of a skip; only an explicit skip is.
    // Guessing the other way would report a working run as a no-op.
    const out = summariseStepOutcomes(['review'], results({}))
    expect(out.ran).toEqual(['review'])
    expect(out.skipped).toEqual([])
  })

  it('falls back to "unknown" when a skip recorded no reason', () => {
    const out = summariseStepOutcomes(['fix'], results({ fix: { skipped: true } }))
    expect(out.skipped).toEqual([{ step: 'fix', reason: 'unknown' }])
  })

  it('deduplicates a step dispatched more than once', () => {
    const out = summariseStepOutcomes(['fix', 'fix'], results({ fix: { applied_count: 1 } }))
    expect(out.ran).toEqual(['fix'])
  })

  it('returns empty lists when no step was dispatched', () => {
    expect(summariseStepOutcomes([], results({}))).toEqual({ ran: [], skipped: [] })
  })
})

describe('mergeStepOutcomes', () => {
  // The crazy/halfcrazy loops re-enter runWorkflow, so the completion line has to
  // reflect the whole invocation. Reporting only the first round called a run
  // that later applied a fix "no step ran".
  it('counts a step that ran in a later round as ran', () => {
    const merged = mergeStepOutcomes(
      { ran: [], skipped: [{ step: 'fix', reason: 'no_review_comment' }] },
      { ran: ['fix'], skipped: [] },
    )
    expect(merged).toEqual({ ran: ['fix'], skipped: [] })
  })

  it('keeps a step skipped when it skipped in every round', () => {
    const merged = mergeStepOutcomes(
      { ran: [], skipped: [{ step: 'conflict-resolve', reason: 'no_vendor' }] },
      { ran: [], skipped: [{ step: 'conflict-resolve', reason: 'no_vendor' }] },
    )
    expect(merged?.skipped).toEqual([{ step: 'conflict-resolve', reason: 'no_vendor' }])
  })

  // Listing one step twice reads as two distinct problems.
  it('reports a repeatedly skipped step once, with its latest reason', () => {
    const merged = mergeStepOutcomes(
      { ran: [], skipped: [{ step: 'fix', reason: 'when_condition' }] },
      { ran: [], skipped: [{ step: 'fix', reason: 'no_vendor' }] },
    )
    expect(merged?.skipped).toEqual([{ step: 'fix', reason: 'no_vendor' }])
  })

  it('does not duplicate a step that ran in both rounds', () => {
    const merged = mergeStepOutcomes({ ran: ['review'], skipped: [] }, { ran: ['review'], skipped: [] })
    expect(merged?.ran).toEqual(['review'])
  })

  it('keeps first-seen ordering across both sides', () => {
    const merged = mergeStepOutcomes(
      { ran: ['review'], skipped: [{ step: 'fix', reason: 'when_condition' }] },
      { ran: ['recheck'], skipped: [{ step: 'conflict-resolve', reason: 'no_conflicts' }] },
    )
    expect(merged?.ran).toEqual(['review', 'recheck'])
    expect(merged?.skipped.map(s => s.step)).toEqual(['fix', 'conflict-resolve'])
  })

  it('passes through when either side is absent', () => {
    const only = { ran: ['review'], skipped: [] }
    expect(mergeStepOutcomes(undefined, only)).toBe(only)
    expect(mergeStepOutcomes(only, undefined)).toBe(only)
    expect(mergeStepOutcomes(undefined, undefined)).toBeUndefined()
  })
})
