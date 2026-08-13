// Adoption metrics answer "is crosscheck actually being used, and does it reach a
// verdict fast enough to matter" — a different question from `impact`, which prices
// the value of reviews that already happened.
//
// Every number here is derived from the local NDJSON logs in ~/.crosscheck/logs.
// Nothing is transmitted: there is no endpoint, no account, and no network call in
// this file. See docs/metrics.md for the field-by-field inventory.

export interface AdoptionLogLine {
  ts: string
  event: string
  repo?: string
  pr?: number
  command?: string
  verdict?: string
  outcome?: string
  category?: string
  step_type?: string
  applied_count?: number
  open_to_verdict_ms?: number
}

export interface WeeklyActivity {
  /** Monday of the ISO week, `YYYY-MM-DD`. */
  week: string
  active_repos: number
  reviews: number
}

export interface LatencySummary {
  count: number
  /** Milliseconds from PR open to posted verdict. */
  p50_ms: number
  p90_ms: number
  max_ms: number
  /** Verdicts whose PR event carried no `created_at`, so they have no latency. */
  unmeasured: number
}

export interface AdoptionReport {
  period: { from: string; to: string; log_files: number }
  onboarding: { started: number; completed: number; abandoned: number }
  activity: {
    reviews_started: number
    reviews_completed: number
    rechecks_completed: number
    blocking_findings_posted: number
    fixes_applied: number
    /** Distinct repos with at least one completed review in the window. */
    active_repos: number
  }
  weekly: WeeklyActivity[]
  open_to_verdict: LatencySummary
  /** Error category of the first failure in each session that never completed a
   *  review — the thing that stops a new install from ever getting a verdict. */
  first_run_failures: Record<string, number>
}

// A verdict-bearing latency is only meaningful for a review that produced one; a
// verdictless review (from `crosscheck review`) has nothing to time to.
export function prOpenToVerdictMs(
  createdAt: string | undefined,
  verdict: string | null,
  now: number = Date.now(),
): number | undefined {
  if (verdict === null || createdAt === undefined) return undefined
  const opened = new Date(createdAt).getTime()
  if (Number.isNaN(opened)) return undefined
  const elapsed = now - opened
  // A negative elapsed time means the clocks disagree, not that the PR was
  // reviewed before it existed. Drop it rather than publish a nonsense number.
  return elapsed >= 0 ? elapsed : undefined
}

export function isoWeekMonday(ts: string): string | null {
  const d = new Date(ts)
  if (Number.isNaN(d.getTime())) return null
  const day = d.getUTCDay()
  const diff = day === 0 ? -6 : 1 - day
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + diff))
    .toISOString().slice(0, 10)
}

export function percentile(sorted: number[], fraction: number): number {
  if (sorted.length === 0) return 0
  // Nearest-rank on the sorted sample: no interpolation, so every reported value
  // is one that actually occurred.
  const rank = Math.ceil(fraction * sorted.length) - 1
  return sorted[Math.min(Math.max(rank, 0), sorted.length - 1)]
}

export function buildAdoptionReport(
  lines: AdoptionLogLine[],
  period: { from: string; to: string; log_files: number },
): AdoptionReport {
  const weekly = new Map<string, { repos: Set<string>; reviews: number }>()
  const activeRepos = new Set<string>()
  const latencies: number[] = []
  let unmeasured = 0

  const counts = {
    onboard_started: 0,
    onboard_completed: 0,
    reviews_started: 0,
    reviews_completed: 0,
    rechecks_completed: 0,
    blocking: 0,
    fixes: 0,
  }

  for (const line of lines) {
    switch (line.event) {
      case 'onboard_started':
        counts.onboard_started++
        break
      case 'onboard_completed':
        // The event is emitted for both outcomes so an abandoned setup is
        // visible; only a success counts as completed.
        if (line.outcome === 'completed') counts.onboard_completed++
        break
      case 'review_started':
        counts.reviews_started++
        break
      case 'review_complete': {
        counts.reviews_completed++
        if (line.step_type === 'recheck') counts.rechecks_completed++
        if (line.repo) {
          activeRepos.add(line.repo)
          const week = isoWeekMonday(line.ts)
          if (week) {
            const bucket = weekly.get(week) ?? { repos: new Set<string>(), reviews: 0 }
            bucket.repos.add(line.repo)
            bucket.reviews++
            weekly.set(week, bucket)
          }
        }
        if (typeof line.open_to_verdict_ms === 'number') latencies.push(line.open_to_verdict_ms)
        else if (line.verdict) unmeasured++
        break
      }
      case 'blocking_finding_posted':
        counts.blocking++
        break
      case 'fix_complete':
        // delivery: 'comment' still counts — a suggestion the author applied is
        // adoption. A no-op fix (applied_count 0) is not.
        if ((line.applied_count ?? 0) > 0) counts.fixes++
        break
    }
  }

  latencies.sort((a, b) => a - b)

  return {
    period,
    onboarding: {
      started: counts.onboard_started,
      completed: counts.onboard_completed,
      abandoned: Math.max(0, counts.onboard_started - counts.onboard_completed),
    },
    activity: {
      reviews_started: counts.reviews_started,
      reviews_completed: counts.reviews_completed,
      rechecks_completed: counts.rechecks_completed,
      blocking_findings_posted: counts.blocking,
      fixes_applied: counts.fixes,
      active_repos: activeRepos.size,
    },
    weekly: [...weekly.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([week, { repos, reviews }]) => ({ week, active_repos: repos.size, reviews })),
    open_to_verdict: {
      count: latencies.length,
      p50_ms: percentile(latencies, 0.5),
      p90_ms: percentile(latencies, 0.9),
      max_ms: latencies.at(-1) ?? 0,
      unmeasured,
    },
    first_run_failures: firstRunFailures(lines),
  }
}

// "First run" is a session that never completed a review. Its first error is the
// one that stopped a new install from reaching a verdict — the category worth
// fixing. Sessions that did complete a review are excluded even if they later
// errored: those are operational failures, not activation failures.
export function firstRunFailures(lines: AdoptionLogLine[]): Record<string, number> {
  const sessions: Array<{ completedReview: boolean; firstErrorCategory: string | null }> = []
  let current: { completedReview: boolean; firstErrorCategory: string | null } | null = null

  const close = () => {
    if (current) sessions.push(current)
    current = null
  }

  for (const line of lines) {
    if (line.event === 'session_start') {
      close()
      current = { completedReview: false, firstErrorCategory: null }
      continue
    }
    // Logs from before session events existed, or a truncated file, would
    // otherwise drop every entry on the floor.
    if (current === null) current = { completedReview: false, firstErrorCategory: null }
    if (line.event === 'review_complete') current.completedReview = true
    if (line.event === 'error' && current.firstErrorCategory === null) {
      current.firstErrorCategory = line.category ?? 'unknown'
    }
    if (line.event === 'session_end') close()
  }
  close()

  const failures: Record<string, number> = {}
  for (const session of sessions) {
    if (session.completedReview || session.firstErrorCategory === null) continue
    failures[session.firstErrorCategory] = (failures[session.firstErrorCategory] ?? 0) + 1
  }
  return failures
}
