import { describe, expect, it, vi } from 'vitest'
import {
  buildKickassRunArgs,
  buildPreflightPlan,
  executeKickassPlan,
  resolveCliInvocation,
  runKickassWithDeps,
  summarizeExecutionResults,
  verdictBoardUpdateForAction,
  type KickassDeps,
} from '../commands/kickass.js'
import type { ScanPRStatus as PRStatus, ScanResult } from '../lib/pr-status.js'

function pr(overrides: Partial<PRStatus> = {}): PRStatus {
  const nextAction = overrides.nextAction ?? 'review'
  return {
    owner: 'acme',
    repo: 'web',
    number: 7,
    title: 'PR 7',
    author: 'alice',
    url: 'https://github.com/acme/web/pull/7',
    headSha: 'abc123456789',
    headRef: 'feature',
    headRepo: 'acme/web',
    baseRef: 'main',
    freshness: 'stale',
    reviewState: nextAction === 'recheck' ? 'NEEDS_RECHECK' : 'NEEDS_REVIEW',
    nextAction,
    lastActiveAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    ageMs: 120_000,
    verdict: 'UNREVIEWED',
    latestAnnotation: null,
    ...overrides,
  }
}

function scan(prs: PRStatus[]): ScanResult {
  return {
    scannedAt: '2026-05-29T00:00:00.000Z',
    staleAfterMs: 60_000,
    cached: false,
    summary: {
      total: prs.length,
      stale: prs.length,
      not_stale: 0,
      actionable: prs.length,
    },
    prs,
  }
}

describe('buildKickassRunArgs', () => {
  // No --steps in most dispatches: run.ts calls identifyNextWorkflowStep against live
  // PR history so the correct step is determined from actual state, not the
  // potentially-stale scan cache. Kickass kicks one step; watch takes over the rest.
  // Exception: stale-sha re-reviews force --steps review (see below).

  it('omits --steps for review actions — detect-step owns routing', () => {
    expect(buildKickassRunArgs(pr({ nextAction: 'review' }))).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  // A conflicted PR (#282) is dispatched as a single conflict-resolve leg. The step's own
  // no_conflicts pre-check decides whether there is anything to do, so pinning the step
  // is safe even if GitHub's mergeable flag flips between the scan and the run.
  it('pins --steps conflict-resolve for resolve actions', () => {
    const plan = buildPreflightPlan([pr({ nextAction: 'resolve' })])

    expect(plan[0].action).toBe('resolve')
    expect(plan[0].transition).toBe('Conflicted -> Resolve')
    expect(buildKickassRunArgs(plan[0])).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'conflict-resolve',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  it('does not put a resolve leg into a round-mode loop', () => {
    const plan = buildPreflightPlan([pr({ nextAction: 'resolve' })], 'crazy')

    const args = buildKickassRunArgs(plan[0], 'crazy')
    expect(args).not.toContain('--crazy')
    expect(args).toContain('--no-timeout')
  })

  // Resolve pushes a merge commit, which a fork PR cannot accept — same constraint as fix.
  it('skips a conflicted fork PR', () => {
    const plan = buildPreflightPlan([pr({ nextAction: 'resolve', headRepo: 'someone-else/web' })])

    expect(plan[0].action).toBe('skip')
    expect(plan[0].skipReason).toBe('fork_pr')
    expect(buildKickassRunArgs(plan[0])).toEqual([])
  })

  it('omits --steps for commit-delivered fix actions', () => {
    const plan = buildPreflightPlan([pr({
      nextAction: 'fix',
      reviewState: 'NEEDS_FIX',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
        sha: 'abc1234',
      },
    })], undefined, 'commit')

    expect(buildKickassRunArgs(plan[0])).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  it('omits --steps for non-commit fix actions', () => {
    const selected = pr({
      nextAction: 'fix',
      reviewState: 'NEEDS_FIX',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
        sha: 'abc1234',
      },
    })

    expect(buildKickassRunArgs(selected)).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  it('forces --steps review when review is needed for an unreviewed new HEAD sha', () => {
    // PR has a review for an older SHA; kickass demotes action to review with
    // explanation=no_usable_review_comment. Without --steps review, run.ts would
    // re-detect from live history and choose the stale review's fix step, applying
    // fixes to a diff that was never reviewed.
    const plan = buildPreflightPlan([pr({
      nextAction: 'fix',
      reviewState: 'NEEDS_FIX',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
        // sha absent → hasUsableCurrentHeadReview returns false → demoted to review
      },
    })])
    expect(plan[0].action).toBe('review')
    expect(plan[0].explanation).toBe('no_usable_review_comment')
    expect(buildKickassRunArgs(plan[0])).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--steps',
      'review',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  it('omits --steps for recheck actions', () => {
    expect(buildKickassRunArgs(pr({ nextAction: 'recheck' }))).toEqual([
      'run',
      'https://github.com/acme/web/pull/7',
      '--expected-head-sha',
      'abc123456789',
      '--trigger',
      'kickass',
    ])
  })

  it('uses --no-timeout instead of --crazy for fix actions in crazy round mode', () => {
    const plan = buildPreflightPlan([pr({
      nextAction: 'fix',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'NEEDS_WORK', type: 'review', sha: 'abc1234' },
    })], 'crazy', 'commit')
    const args = buildKickassRunArgs(plan[0], 'crazy')
    expect(args).not.toContain('--steps')
    expect(args).toContain('--no-timeout')
    expect(args).not.toContain('--crazy')
  })

  it('appends --halfcrazy to standalone recheck actions', () => {
    const plan = buildPreflightPlan([pr({
      nextAction: 'recheck',
      reviewState: 'NEEDS_RECHECK',
    })], 'halfcrazy', 'commit')
    const args = buildKickassRunArgs(plan[0], 'halfcrazy')
    expect(args).toContain('--half-crazy')
    expect(args).not.toContain('--crazy')
  })

  it('uses --no-timeout for fix actions even in PR-delivery mode with crazy', () => {
    const args = buildKickassRunArgs(pr({
      nextAction: 'fix',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'BLOCK', type: 'review', sha: 'abc1234' },
    }), 'crazy')
    expect(args).not.toContain('--steps')
    expect(args).not.toContain('--crazy')
    expect(args).toContain('--no-timeout')
  })
})

describe('runKickassWithDeps', () => {
  it('warns to use --force when a cached scan finds no PRs', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ''))
    })
    const deps: KickassDeps = {
      loadScanResult: async () => ({ ...scan([]), cached: true }),
      pickPRs: async () => [],
      confirm: async () => false,
      dispatchRun: async () => {},
      getCurrentHeadSha: async (item) => item.pr.headSha,
    }

    try {
      await runKickassWithDeps({ staleAfter: '1m' }, deps)
    } finally {
      logSpy.mockRestore()
    }

    expect(logs.join('\n')).toContain('No actionable PRs found.')
    expect(logs.join('\n')).toContain('This result came from the scan cache.')
    expect(logs.join('\n')).toContain('Rerun with --force to refresh the queue.')
  })

  it('shows no --force hint when a fresh scan finds no PRs', async () => {
    const logs: string[] = []
    const logSpy = vi.spyOn(console, 'log').mockImplementation((message?: unknown) => {
      logs.push(String(message ?? ''))
    })
    const deps: KickassDeps = {
      loadScanResult: async () => scan([]),
      pickPRs: async () => [],
      confirm: async () => false,
      dispatchRun: async () => {},
      getCurrentHeadSha: async (item) => item.pr.headSha,
    }

    try {
      await runKickassWithDeps({ staleAfter: '1m' }, deps)
    } finally {
      logSpy.mockRestore()
    }

    expect(logs.join('\n')).toContain('No actionable PRs found.')
    expect(logs.join('\n')).not.toContain('--force')
  })

  it('dry-run scans, picks PRs, and prints preflight without mutating', async () => {
    const selected = pr({
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'BLOCK',
        type: 'review',
        sha: 'abc1234',
      },
    })
    const calls: string[] = []
    const deps: KickassDeps = {
      loadScanResult: async () => {
        calls.push('scan')
        return scan([selected])
      },
      pickPRs: async (queue) => {
        calls.push(`pick:${queue.length}`)
        return queue
      },
      confirm: async () => {
        calls.push('confirm')
        return true
      },
      dispatchRun: async () => {
        calls.push('dispatch')
      },
      getCurrentHeadSha: async () => {
        calls.push('head')
        return selected.headSha
      },
    }

    await runKickassWithDeps({ dryRun: true, staleAfter: '1m' }, deps)

    expect(calls).toEqual(['scan', 'pick:1'])
  })

  it('includes not-stale actionable PRs in the queue (stale first)', async () => {
    const stalePR = pr({ number: 1, freshness: 'stale', nextAction: 'review' })
    const freshPR = pr({ number: 2, freshness: 'not_stale', nextAction: 'recheck' })
    let queueSeen: PRStatus[] = []
    const deps: KickassDeps = {
      loadScanResult: async () => scan([freshPR, stalePR]),
      pickPRs: async (queue) => { queueSeen = queue; return [] },
      confirm: async () => false,
      dispatchRun: async () => {},
      getCurrentHeadSha: async (item) => item.pr.headSha,
    }

    await runKickassWithDeps({ dryRun: false, staleAfter: '1m' }, deps)

    expect(queueSeen.map(p => p.number)).toEqual([1, 2])  // stale before not-stale
  })

  it('excludes merge-ready PRs from the picker queue', async () => {
    const approvePR = pr({ number: 1, nextAction: 'merge', reviewState: 'APPROVED' })
    const reviewPR = pr({ number: 2, nextAction: 'review' })
    let queueSeen: PRStatus[] = []
    const deps: KickassDeps = {
      loadScanResult: async () => scan([approvePR, reviewPR]),
      pickPRs: async (queue) => { queueSeen = queue; return [] },
      confirm: async () => false,
      dispatchRun: async () => {},
      getCurrentHeadSha: async (item) => item.pr.headSha,
    }

    await runKickassWithDeps({ dryRun: false, staleAfter: '1m' }, deps)

    expect(queueSeen.map(p => p.number)).toEqual([2])  // merge-ready excluded from picker
  })

  it('skips execution when the PR head changed after scan', async () => {
    const selected = pr({
      nextAction: 'review',
      reviewState: 'NEEDS_REVIEW',
      headSha: 'abc123456789',
    })
    const plan = buildPreflightPlan([selected])
    const dispatched: string[] = []

    const results = await executeKickassPlan(plan, {
      getCurrentHeadSha: async () => 'def987654321',
      dispatchRun: async (item) => { dispatched.push(item.pr.url) },
    })

    expect(dispatched).toEqual([])
    expect(results).toEqual([{ pr: selected, status: 'skipped', reason: 'stale_signature' }])
  })

  it('downgrades NEEDS_WORK fix to CR when no current-head review comment is usable', () => {
    const selected = pr({
      reviewState: 'NEEDS_FIX',
      nextAction: 'fix',
      latestAnnotation: {
        origin: 'claude',
        reviewer: 'codex',
        verdict: 'NEEDS_WORK',
        type: 'review',
      },
    })

    const plan = buildPreflightPlan([selected])

    expect(plan).toHaveLength(1)
    expect(plan[0].action).toBe('review')
    expect(plan[0].transition).toBe('PR -> CR')
    expect(plan[0].explanation).toBe('no_usable_review_comment')
  })

  it('skips fork fix while allowing fork review', async () => {
    const review = pr({
      number: 1,
      nextAction: 'review',
      reviewState: 'NEEDS_REVIEW',
      headRepo: 'fork/web',
    })
    const fix = pr({
      number: 2, nextAction: 'fix', reviewState: 'NEEDS_FIX', headRepo: 'fork/web',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'BLOCK', type: 'review', sha: 'abc1234' },
    })
    const plan = buildPreflightPlan([review, fix])
    const dispatched: number[] = []

    const results = await executeKickassPlan(plan, {
      getCurrentHeadSha: async (item) => item.pr.headSha,
      dispatchRun: async (item) => { dispatched.push(item.pr.number) },
    })

    expect(plan.map(item => item.action)).toEqual(['review', 'skip'])
    expect(dispatched).toEqual([1])
    expect(results.map(result => result.reason)).toEqual([undefined, 'fork_pr'])
  })

  it('splits commit-delivered fix and recheck across a fresh head', async () => {
    const selected = pr({
      number: 9,
      reviewState: 'NEEDS_FIX',
      nextAction: 'fix',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'NEEDS_WORK', type: 'review', sha: 'abc1234' },
    })
    const plan = buildPreflightPlan([selected], 'crazy', 'commit')
    const dispatched: Array<{ action: string; headSha: string; args: string[] }> = []
    let head = selected.headSha

    const results = await executeKickassPlan(plan, {
      getCurrentHeadSha: async () => head,
      dispatchRun: async (item) => {
        dispatched.push({ action: item.action, headSha: item.pr.headSha, args: buildKickassRunArgs(item, 'crazy') })
        if (item.action === 'fix') head = 'def987654321'
      },
    })

    expect(results).toEqual([{ pr: selected, status: 'executed' }])
    expect(dispatched).toEqual([
      { action: 'fix', headSha: 'abc123456789', args: ['run', selected.url, '--expected-head-sha', 'abc123456789', '--no-timeout', '--trigger', 'kickass'] },
      { action: 'recheck', headSha: 'def987654321', args: ['run', selected.url, '--expected-head-sha', 'def987654321', '--crazy', '--trigger', 'kickass'] },
    ])
  })

  it('fix plan shows [crazy] badge in transition when roundMode is crazy', () => {
    const selected = pr({
      reviewState: 'NEEDS_FIX',
      nextAction: 'fix',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'NEEDS_WORK', type: 'review', sha: 'abc1234' },
    })
    const plan = buildPreflightPlan([selected], 'crazy', 'commit')
    expect(plan[0].transition).toContain('[crazy]')
    expect(plan[0].transition).toContain('fix→recheck')
  })

  it('marks non-commit fix plans as recheck deferred', () => {
    const selected = pr({
      reviewState: 'NEEDS_FIX',
      nextAction: 'fix',
      latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'NEEDS_WORK', type: 'review', sha: 'abc1234' },
    })
    const plan = buildPreflightPlan([selected], 'crazy', 'pull_request')
    expect(plan[0].transition).toBe('NEEDS_FIX -> fix')
    expect(plan[0].details).toContain('delivery pull_request')
    expect(plan[0].details).toContain('recheck deferred')
    expect(plan[0].chainRecheck).toBe(false)
  })

  it('does not classify --timeout CLI flag in subprocess failure message as timeout', async () => {
    // An ordinary subprocess failure whose command string contains --timeout should
    // produce reason 'subprocess' (non-retryable), not 'timeout' (retryable).
    const selected = pr({ number: 1, nextAction: 'review' })
    const cmdErr = Object.assign(
      new Error('Command failed with exit code 1: node crosscheck run --timeout 300s --no-timeout'),
      { timedOut: false, exitCode: 1 },
    )
    const results = await executeKickassPlan(buildPreflightPlan([selected]), {
      getCurrentHeadSha: async (item) => item.pr.headSha,
      dispatchRun: async () => { throw cmdErr },
    })
    // 'subprocess' is not retryable — no sleep, result is immediate
    expect(results[0]).toMatchObject({ status: 'failed', reason: 'subprocess' })
  })

  it('classifies execa timedOut=true as retryable timeout and retries successfully', async () => {
    vi.useFakeTimers()
    try {
      const selected = pr({ number: 1, nextAction: 'review' })
      let callCount = 0
      const resultsPromise = executeKickassPlan(buildPreflightPlan([selected]), {
        getCurrentHeadSha: async (item) => item.pr.headSha,
        dispatchRun: async () => {
          callCount++
          if (callCount === 1) {
            throw Object.assign(new Error('Command timed out after 30000ms'), { timedOut: true, exitCode: null })
          }
          // Second call (retry) succeeds
        },
      })
      await vi.runAllTimersAsync()
      const results = await resultsPromise
      expect(callCount).toBeGreaterThan(1)  // retry ran — error was classified as retryable
      expect(results[0].status).toBe('executed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('retries the chained recheck with current head when stale_signature fires on retry', async () => {
    // Scenario: fix commits (advancing head), but a transient network failure causes
    // executeItem to throw.  On retry the stale-signature guard fires; the new code
    // fetches the current head and runs a bare recheck instead of restoring the failure.
    vi.useFakeTimers()
    try {
      const selected = pr({
        number: 5,
        reviewState: 'NEEDS_FIX',
        nextAction: 'fix',
        latestAnnotation: { origin: 'claude', reviewer: 'codex', verdict: 'NEEDS_WORK', type: 'review', sha: 'abc1234' },
      })
      const plan = buildPreflightPlan([selected], 'crazy', 'commit')
      let headAdvanced = false
      const dispatched: string[] = []

      const resultsPromise = executeKickassPlan(plan, {
        getCurrentHeadSha: async (item) => headAdvanced ? 'newhead0000000' : item.pr.headSha,
        dispatchRun: async (item) => {
          dispatched.push(item.action)
          if (item.action === 'fix') {
            headAdvanced = true
            throw Object.assign(new Error('fetch failed'), { timedOut: false })
          }
          // recheck dispatch (from retry path) succeeds
        },
      })

      await vi.runAllTimersAsync()
      const results = await resultsPromise

      expect(dispatched).toEqual(['fix', 'recheck'])
      expect(results[0].status).toBe('executed')
    } finally {
      vi.useRealTimers()
    }
  })

  it('continues executing later PRs when one PR throws', async () => {
    const first = pr({ number: 1, nextAction: 'review' })
    const second = pr({ number: 2, nextAction: 'review' })
    const dispatched: number[] = []

    const results = await executeKickassPlan(buildPreflightPlan([first, second]), {
      getCurrentHeadSha: async (item) => {
        if (item.pr.number === 2) throw new Error('api unavailable')
        return item.pr.headSha
      },
      dispatchRun: async (item) => { dispatched.push(item.pr.number) },
    })

    expect(dispatched).toEqual([1])
    expect(results.map(result => [result.pr.number, result.status, result.reason])).toEqual([
      [1, 'executed', undefined],
      [2, 'failed', 'unknown'],
    ])
  })

  it('runs all PRs concurrently when concurrency > 1', async () => {
    const prs = [1, 2, 3].map(n => pr({ number: n, nextAction: 'review' }))
    const plan = buildPreflightPlan(prs)
    const startTimes: number[] = []
    const dispatched: number[] = []

    await executeKickassPlan(plan, {
      getCurrentHeadSha: async (item) => item.pr.headSha,
      dispatchRun: async (item) => {
        startTimes.push(Date.now())
        await new Promise(r => setTimeout(r, 20))
        dispatched.push(item.pr.number)
      },
    }, 3)

    // All 3 started within a short window (concurrent, not sequential)
    expect(startTimes[2] - startTimes[0]).toBeLessThan(15)
    expect(dispatched.sort()).toEqual([1, 2, 3])
  })

  it('respects concurrency cap — runs at most n PRs at a time', async () => {
    const prs = [1, 2, 3, 4].map(n => pr({ number: n, nextAction: 'review' }))
    const plan = buildPreflightPlan(prs)
    let active = 0
    let maxActive = 0

    await executeKickassPlan(plan, {
      getCurrentHeadSha: async (item) => item.pr.headSha,
      dispatchRun: async () => {
        active++
        maxActive = Math.max(maxActive, active)
        await new Promise(r => setTimeout(r, 20))
        active--
      },
    }, 2)

    expect(maxActive).toBeLessThanOrEqual(2)
  })

  it('summarizes execution outcomes', () => {
    expect(summarizeExecutionResults([
      { pr: pr({ number: 1 }), status: 'executed' },
      { pr: pr({ number: 2 }), status: 'skipped', reason: 'stale_signature' },
      { pr: pr({ number: 3 }), status: 'failed', reason: 'unknown' },
    ])).toBe('Execution summary: 1 executed, 1 skipped, 1 failed')
  })

  describe('stagger', () => {
    it('sequential mode ignores staggerMs — item still executes', async () => {
      const selected = pr({ nextAction: 'review', freshness: 'stale' })
      let dispatched = false
      const results = await executeKickassPlan(
        buildPreflightPlan([selected]),
        {
          getCurrentHeadSha: async (item) => item.pr.headSha,
          dispatchRun: async () => { dispatched = true },
        },
        1,    // sequential
        9999, // staggerMs — must be ignored in sequential mode
      )
      expect(results[0].status).toBe('executed')
      expect(dispatched).toBe(true)
    })

    it('concurrent mode with staggerMs=0 processes all items', async () => {
      const prs = [
        pr({ nextAction: 'review', number: 1, headSha: 'aaa111', url: 'https://github.com/acme/web/pull/1' }),
        pr({ nextAction: 'review', number: 2, headSha: 'bbb222', url: 'https://github.com/acme/web/pull/2' }),
      ]
      const dispatched: number[] = []
      const results = await executeKickassPlan(
        buildPreflightPlan(prs),
        {
          getCurrentHeadSha: async (item) => item.pr.headSha,
          dispatchRun: async (item) => { dispatched.push(item.pr.number); return '' },
        },
        2, // concurrency
        0, // staggerMs = 0 → no stagger
      )
      expect(results).toHaveLength(2)
      expect(results.every(r => r.status === 'executed')).toBe(true)
      expect(dispatched.sort()).toEqual([1, 2])
    })
  })
})

describe('verdictBoardUpdateForAction', () => {
  it('stores review verdicts in the review slot', () => {
    expect(verdictBoardUpdateForAction('review', 'APPROVE')).toEqual({ verdict: 'APPROVE' })
  })

  it('stores recheck verdicts in the recheck slot', () => {
    expect(verdictBoardUpdateForAction('recheck', 'NEEDS WORK')).toEqual({ recheckVerdict: 'NEEDS WORK' })
  })
})

describe('resolveCliInvocation', () => {
  it('runs built JavaScript through node', () => {
    expect(resolveCliInvocation({
      argvEntry: '/repo/dist/cli.js',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/dist/cli.js',
      urlToPath: url => url.pathname,
    })).toEqual({
      command: '/usr/local/bin/node',
      args: ['/repo/dist/cli.js'],
    })
  })

  it('runs TypeScript CLI entries through the local tsx binary', () => {
    const invocation = resolveCliInvocation({
      argvEntry: '/repo/src/cli.ts',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/src/cli.ts' || path.endsWith('/node_modules/.bin/tsx'),
      urlToPath: url => url.pathname,
    })

    expect(invocation.command.endsWith('/node_modules/.bin/tsx')).toBe(true)
    expect(invocation.args).toEqual(['/repo/src/cli.ts'])
  })

  it('throws when only a TypeScript CLI entry is available without tsx', () => {
    expect(() => resolveCliInvocation({
      argvEntry: '/repo/src/cli.ts',
      execPath: '/usr/local/bin/node',
      exists: path => path === '/repo/src/cli.ts',
      urlToPath: url => url.pathname,
    })).toThrow('Cannot run crosscheck actions from a TypeScript entrypoint')
  })
})
