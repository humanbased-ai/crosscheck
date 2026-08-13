import { describe, it, expect } from 'vitest'
import {
  buildAdoptionReport,
  firstRunFailures,
  isoWeekMonday,
  percentile,
  prOpenToVerdictMs,
  type AdoptionLogLine,
} from '../lib/adoption.js'

const PERIOD = { from: '2026-07-01', to: '2026-07-14', log_files: 2 }

function line(event: string, fields: Partial<AdoptionLogLine> = {}): AdoptionLogLine {
  return { ts: '2026-07-08T10:00:00.000Z', event, ...fields }
}

describe('prOpenToVerdictMs', () => {
  const opened = '2026-07-08T09:00:00.000Z'
  const now = Date.parse('2026-07-08T10:30:00.000Z')

  it('measures from PR open to the moment the verdict is posted', () => {
    expect(prOpenToVerdictMs(opened, 'APPROVE', now)).toBe(90 * 60 * 1000)
  })

  it('returns undefined when the review produced no verdict', () => {
    expect(prOpenToVerdictMs(opened, null, now)).toBeUndefined()
  })

  it('returns undefined when the PR event carried no open time', () => {
    expect(prOpenToVerdictMs(undefined, 'BLOCK', now)).toBeUndefined()
  })

  it('returns undefined for an unparseable timestamp rather than NaN', () => {
    expect(prOpenToVerdictMs('last Tuesday', 'BLOCK', now)).toBeUndefined()
  })

  it('drops a negative elapsed time from clock skew instead of reporting it', () => {
    expect(prOpenToVerdictMs('2026-07-08T11:00:00.000Z', 'APPROVE', now)).toBeUndefined()
  })
})

describe('isoWeekMonday', () => {
  it('maps a mid-week timestamp to that week Monday', () => {
    expect(isoWeekMonday('2026-07-08T10:00:00.000Z')).toBe('2026-07-06')
  })

  it('maps Sunday back to the Monday that started its week', () => {
    expect(isoWeekMonday('2026-07-12T23:59:00.000Z')).toBe('2026-07-06')
  })

  it('returns null for an unparseable timestamp', () => {
    expect(isoWeekMonday('not-a-date')).toBeNull()
  })
})

describe('percentile', () => {
  it('returns a value that actually occurred in the sample', () => {
    const sorted = [10, 20, 30, 40, 50]
    expect(percentile(sorted, 0.5)).toBe(30)
    expect(percentile(sorted, 0.9)).toBe(50)
  })

  it('returns 0 for an empty sample', () => {
    expect(percentile([], 0.5)).toBe(0)
  })
})

describe('buildAdoptionReport', () => {
  it('counts the activation funnel and treats a missing completion as abandonment', () => {
    const report = buildAdoptionReport([
      line('onboard_started'),
      line('onboard_completed', { outcome: 'completed' }),
      line('onboard_started'),
      line('onboard_completed', { outcome: 'abandoned' }),
      line('onboard_started'),
    ], PERIOD)

    expect(report.onboarding).toEqual({ started: 3, completed: 1, abandoned: 2 })
  })

  it('separates rechecks from initial reviews via step_type', () => {
    const report = buildAdoptionReport([
      line('review_complete', { repo: 'acme/web', step_type: 'review', verdict: 'BLOCK' }),
      line('review_complete', { repo: 'acme/web', step_type: 'recheck', verdict: 'APPROVE' }),
    ], PERIOD)

    expect(report.activity.reviews_completed).toBe(2)
    expect(report.activity.rechecks_completed).toBe(1)
  })

  it('counts distinct repos, not reviews, as active repos', () => {
    const report = buildAdoptionReport([
      line('review_complete', { repo: 'acme/web', verdict: 'APPROVE' }),
      line('review_complete', { repo: 'acme/web', verdict: 'BLOCK' }),
      line('review_complete', { repo: 'acme/api', verdict: 'APPROVE' }),
    ], PERIOD)

    expect(report.activity.active_repos).toBe(2)
    expect(report.weekly).toEqual([{ week: '2026-07-06', active_repos: 2, reviews: 3 }])
  })

  it('buckets weekly activity by ISO week', () => {
    const report = buildAdoptionReport([
      line('review_complete', { ts: '2026-07-08T10:00:00.000Z', repo: 'acme/web', verdict: 'APPROVE' }),
      line('review_complete', { ts: '2026-07-15T10:00:00.000Z', repo: 'acme/api', verdict: 'APPROVE' }),
    ], PERIOD)

    expect(report.weekly.map(w => w.week)).toEqual(['2026-07-06', '2026-07-13'])
  })

  it('counts a fix only when it changed files', () => {
    const report = buildAdoptionReport([
      line('fix_complete', { applied_count: 3 }),
      line('fix_complete', { applied_count: 0 }),
      line('fix_complete', {}),
    ], PERIOD)

    expect(report.activity.fixes_applied).toBe(1)
  })

  it('summarises open-to-verdict latency and reports what could not be measured', () => {
    const minute = 60_000
    const report = buildAdoptionReport([
      line('review_complete', { repo: 'acme/web', verdict: 'APPROVE', open_to_verdict_ms: 10 * minute }),
      line('review_complete', { repo: 'acme/web', verdict: 'BLOCK', open_to_verdict_ms: 30 * minute }),
      line('review_complete', { repo: 'acme/web', verdict: 'APPROVE', open_to_verdict_ms: 120 * minute }),
      line('review_complete', { repo: 'acme/web', verdict: 'APPROVE' }),
    ], PERIOD)

    expect(report.open_to_verdict.count).toBe(3)
    expect(report.open_to_verdict.p50_ms).toBe(30 * minute)
    expect(report.open_to_verdict.max_ms).toBe(120 * minute)
    expect(report.open_to_verdict.unmeasured).toBe(1)
  })

  it('does not count a verdictless review as unmeasured latency', () => {
    const report = buildAdoptionReport([
      line('review_complete', { repo: 'acme/web' }),
    ], PERIOD)

    expect(report.open_to_verdict.unmeasured).toBe(0)
  })

  it('counts blocking findings from their own event', () => {
    const report = buildAdoptionReport([
      line('blocking_finding_posted', { repo: 'acme/web', verdict: 'BLOCK' }),
      line('blocking_finding_posted', { repo: 'acme/api', verdict: 'NEEDS WORK' }),
    ], PERIOD)

    expect(report.activity.blocking_findings_posted).toBe(2)
  })

  it('reports an empty shape rather than throwing on no logs', () => {
    const report = buildAdoptionReport([], PERIOD)

    expect(report.activity.reviews_completed).toBe(0)
    expect(report.weekly).toEqual([])
    expect(report.open_to_verdict).toEqual({ count: 0, p50_ms: 0, p90_ms: 0, max_ms: 0, unmeasured: 0 })
    expect(report.first_run_failures).toEqual({})
  })
})

describe('firstRunFailures', () => {
  it('attributes a session that never reached a verdict to its first error', () => {
    const failures = firstRunFailures([
      line('session_start', { command: 'run' }),
      line('error', { category: 'auth' }),
      line('error', { category: 'network' }),
      line('session_end'),
    ])

    expect(failures).toEqual({ auth: 1 })
  })

  it('ignores errors in a session that did complete a review', () => {
    const failures = firstRunFailures([
      line('session_start', { command: 'watch' }),
      line('review_complete', { repo: 'acme/web', verdict: 'APPROVE' }),
      line('error', { category: 'rate_limit' }),
      line('session_end'),
    ])

    expect(failures).toEqual({})
  })

  it('keeps sessions separate when one fails and the next succeeds', () => {
    const failures = firstRunFailures([
      line('session_start', { command: 'run' }),
      line('error', { category: 'auth' }),
      line('session_end'),
      line('session_start', { command: 'run' }),
      line('review_complete', { repo: 'acme/web', verdict: 'BLOCK' }),
      line('session_end'),
    ])

    expect(failures).toEqual({ auth: 1 })
  })

  it('counts a session that crashed without a session_end', () => {
    const failures = firstRunFailures([
      line('session_start', { command: 'watch' }),
      line('error', { category: 'timeout' }),
    ])

    expect(failures).toEqual({ timeout: 1 })
  })

  it('labels an uncategorised error rather than dropping it', () => {
    const failures = firstRunFailures([
      line('session_start', { command: 'run' }),
      line('error', {}),
    ])

    expect(failures).toEqual({ unknown: 1 })
  })

  it('still attributes errors in logs written before session events existed', () => {
    const failures = firstRunFailures([
      line('error', { category: 'git' }),
    ])

    expect(failures).toEqual({ git: 1 })
  })
})
