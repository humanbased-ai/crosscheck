import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import type { Config } from '../config/schema.js'
import {
  createGithubClient,
  listCheckRuns,
  listCommitStatuses,
  listIssueComments,
  listOpenPRs,
  listOrgRepos,
  listPRCommitActivity,
  listPRReviewComments,
  listTimelineEvents,
  listUserRepos,
  type CommitStatusDetail,
  type OpenPR,
} from '../github/client.js'
import { getPRMergeSummary } from '../github/merge.js'
import { isAuthorAllowed } from './filter.js'
import { getLogDir, logError } from './logger.js'
import { parseAnnotationFieldsFenced } from './annotation.js'
import { readRepoWorkflowStepTypes } from './repo-workflow.js'
import { dedupScopes, type Scope } from './scopes.js'

export type Freshness = 'stale' | 'not_stale'

// Workflow stage — what action is pending on this PR.
export type ReviewState = 'NEEDS_REVIEW' | 'NEEDS_FIX' | 'NEEDS_RECHECK' | 'APPROVED'

export type NextAction = 'review' | 'fix' | 'recheck' | 'merge' | null

// AI verdict — what the reviewer decided. UNREVIEWED means no review found for current HEAD.
export type ReviewVerdict = 'UNREVIEWED' | 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'

// Raw annotation vocabulary emitted and parsed from review comments. Unchanged.
export type CrosscheckVerdict = 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'

export interface CrosscheckAnnotation {
  marker?: string
  origin?: string
  reviewer?: string
  verdict?: CrosscheckVerdict
  type?: string
  sha?: string
}

export interface PRActivityComment {
  body: string
  createdAt: string
  updatedAt?: string
}

export interface PRActivityCommit {
  sha: string
  committedAt: string
}

export interface PRActivityTimestamp {
  state?: string
  name?: string
  conclusion?: string | null
  status?: string | null
  updatedAt: string
}

export interface PRWorkflowLogEvent {
  ts: string
  event: string
  repo?: string
  pr?: number
  verdict?: string | null
  applied_count?: number
  conflicts_resolved?: number
  last_verdict?: string | null
  [key: string]: unknown
}

export interface PRStatusInput {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  url: string
  headSha: string
  headRef: string
  headRepo?: string | null
  baseRef: string
  prUpdatedAt: string
  comments: PRActivityComment[]
  reviewComments: PRActivityComment[]
  commits: PRActivityCommit[]
  commitStatuses: CommitStatusDetail[]
  checkRuns: PRActivityTimestamp[]
  timelineEvents: PRActivityTimestamp[]
  logEvents: PRWorkflowLogEvent[]
  merge?: PRMergeSummary
}

export interface PRMergeSummary {
  mergeable: boolean | null
  mergeStateStatus?: string
  protectedBase: boolean | null
}

export interface ScanPRStatus {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  url: string
  headSha: string
  headRef: string
  headRepo?: string | null
  baseRef: string
  freshness: Freshness
  reviewState: ReviewState
  nextAction: NextAction
  lastActiveAt: string
  staleAfterMs: number
  ageMs: number
  verdict: ReviewVerdict
  latestAnnotation: CrosscheckAnnotation | null
  merge?: PRMergeSummary
}

export interface ScanSummary {
  total: number
  stale: number
  not_stale: number
  actionable: number
}

export interface ScanResult {
  scannedAt: string
  staleAfterMs: number
  scopeHash?: string
  cached: boolean
  summary: ScanSummary
  prs: ScanPRStatus[]
}

export interface DeriveStatusOptions {
  nowMs: number
  staleAfterMs: number
}

export interface ScanOpenPRStatusesOptions {
  now?: Date
  staleAfterMs: number
}

interface TimedAnnotation {
  annotation: CrosscheckAnnotation
  timestamp: string
}

interface TimedVerdict {
  verdict: CrosscheckVerdict
  timestamp: string
  annotation: CrosscheckAnnotation | null
}

const GITHUB_SCAN_CONCURRENCY = 8

// Only state-changing workflow events should refresh staleness. No-op
// bookkeeping like step_skipped/comment_posted can happen while a PR still
// needs operator action, so those entries stay out of the activity signal.
const WORKFLOW_ACTIVITY_EVENTS = new Set([
  'review_complete',
  'fix_complete',
  'conflict_resolve_complete',
  'workflow_complete',
])

export function parseCrosscheckAnnotation(body: string): CrosscheckAnnotation | null {
  const fields = parseAnnotationFieldsFenced(body)
  if (!fields) return null

  const verdict = normalizeVerdict(fields.get('verdict'))
  return {
    ...(fields.has('__marker__') && { marker: fields.get('__marker__') }),
    ...(fields.has('origin') && { origin: fields.get('origin') }),
    ...(fields.has('reviewer') && { reviewer: fields.get('reviewer') }),
    ...(verdict && { verdict }),
    ...(fields.has('type') && { type: fields.get('type') }),
    ...(fields.has('sha') && { sha: fields.get('sha') }),
  }
}

export function derivePRStatus(input: PRStatusInput, options: DeriveStatusOptions): ScanPRStatus {
  const annotations = latestTimedAnnotations([...input.comments, ...input.reviewComments])
  const latestAnnotation = annotations[0] ?? null
  const latestVerdict = latestTimedVerdict(input, annotations)
  const latestFix = latestAppliedFixAfter(input.logEvents, latestVerdict?.timestamp)
  const lastActiveMs = maxTimestampMs([
    input.prUpdatedAt,
    ...input.comments.flatMap(comment => [comment.createdAt, comment.updatedAt]),
    ...input.reviewComments.flatMap(comment => [comment.createdAt, comment.updatedAt]),
    ...input.commits.map(commit => commit.committedAt),
    ...input.commitStatuses.map(status => status.updatedAt),
    ...input.checkRuns.map(run => run.updatedAt),
    ...input.timelineEvents.map(event => event.updatedAt),
    ...input.logEvents.filter(event => WORKFLOW_ACTIVITY_EVENTS.has(event.event)).map(event => event.ts),
  ]) ?? Date.parse(input.prUpdatedAt)

  const ageMs = Math.max(0, options.nowMs - lastActiveMs)
  const reviewState = computeReviewState(latestVerdict, latestFix)
  const nextAction = nextActionForState(reviewState)
  const freshness: Freshness = ageMs >= options.staleAfterMs && nextAction !== null ? 'stale' : 'not_stale'

  return {
    owner: input.owner,
    repo: input.repo,
    number: input.number,
    title: input.title,
    author: input.author,
    url: input.url,
    headSha: input.headSha,
    headRef: input.headRef,
    ...(input.headRepo !== undefined && { headRepo: input.headRepo }),
    baseRef: input.baseRef,
    freshness,
    reviewState,
    nextAction,
    lastActiveAt: new Date(lastActiveMs).toISOString(),
    staleAfterMs: options.staleAfterMs,
    ageMs,
    verdict: latestVerdict?.verdict ?? 'UNREVIEWED',
    latestAnnotation: latestAnnotation?.annotation ?? null,
    ...(input.merge && { merge: input.merge }),
  }
}

export function summarizeStatuses(prs: ScanPRStatus[]): ScanSummary {
  return {
    total: prs.length,
    stale: prs.filter(pr => pr.freshness === 'stale').length,
    not_stale: prs.filter(pr => pr.freshness === 'not_stale').length,
    actionable: prs.filter(pr => pr.nextAction !== null).length,
  }
}

function applyRepoWorkflowOverrideToStatus(status: ScanPRStatus): ScanPRStatus {
  if (status.nextAction === null || status.nextAction === 'merge') return status
  const repoSteps = readRepoWorkflowStepTypes(status.owner, status.repo)
  if (!repoSteps || repoSteps.includes(status.nextAction)) return status
  return {
    ...status,
    nextAction: null,
    freshness: 'not_stale',
  }
}

export async function scanOpenPRStatuses(
  config: Config,
  token: string,
  options: ScanOpenPRStatusesOptions,
): Promise<ScanResult> {
  const now = options.now ?? new Date()
  const [repoScopes, logEvents] = await Promise.all([
    buildRepoScopes(config, token),
    loadWorkflowLogEvents(),
  ])
  const octokit = createGithubClient(token)
  const limitGithub = createConcurrencyLimiter(GITHUB_SCAN_CONCURRENCY)

  const perRepoPRs = await Promise.all(
    repoScopes.map(({ owner, repo }) =>
      limitGithub(async () => {
        try {
          const prs = await listOpenPRs(owner, repo, token)
          return prs
            .filter(pr => isAuthorAllowed(config.routing.allowed_authors, pr.author))
            .map(pr => ({ owner, repo, pr }))
        } catch (err: unknown) {
          logError({ event: 'scan_repo_skipped', owner, repo }, err)
          return [] as Array<{ owner: string; repo: string; pr: OpenPR }>
        }
      }),
    ),
  )

  const statusResults = await Promise.all(
    perRepoPRs.flat().map(async ({ owner, repo, pr }) => {
      try {
        const [
          comments,
          reviewComments,
          commits,
          commitStatuses,
          checkRuns,
          timelineEvents,
          merge,
        ] = await Promise.all([
          limitGithub(() => listIssueComments(owner, repo, pr.number, token)),
          limitGithub(() => listPRReviewComments(owner, repo, pr.number, token)),
          limitGithub(() => listPRCommitActivity(owner, repo, pr.number, token)),
          limitGithub(() => listCommitStatuses(owner, repo, pr.headSha, token)),
          limitGithub(() => listCheckRuns(owner, repo, pr.headSha, token)),
          limitGithub(() => listTimelineEvents(owner, repo, pr.number, token)),
          limitGithub(() => getPRMergeSummary(octokit, owner, repo, pr.number, pr.baseRef)),
        ])

        const status = derivePRStatus({
          owner,
          repo,
          number: pr.number,
          title: pr.title,
          author: pr.author,
          url: pr.url ?? `https://github.com/${owner}/${repo}/pull/${pr.number}`,
          headSha: pr.headSha,
          headRef: pr.headRef,
          headRepo: pr.headRepo,
          baseRef: pr.baseRef,
          prUpdatedAt: pr.updatedAt ?? pr.createdAt,
          comments,
          reviewComments,
          commits,
          commitStatuses,
          checkRuns,
          timelineEvents,
          logEvents: filterLogEventsForPR(logEvents, owner, repo, pr.number),
          merge,
        }, { nowMs: now.getTime(), staleAfterMs: options.staleAfterMs })
        return applyRepoWorkflowOverrideToStatus(status)
      } catch (err: unknown) {
        logError({ event: 'scan_pr_skipped', owner, repo, pr: pr.number }, err)
        return null
      }
    }),
  )
  const statuses = statusResults.filter((status): status is ScanPRStatus => status !== null)

  statuses.sort((a, b) => {
    if (a.freshness !== b.freshness) return a.freshness === 'stale' ? -1 : 1
    return Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt)
  })

  return {
    scannedAt: now.toISOString(),
    staleAfterMs: options.staleAfterMs,
    cached: false,
    summary: summarizeStatuses(statuses),
    prs: statuses,
  }
}

export function loadWorkflowLogEvents(logDir = getLogDir()): PRWorkflowLogEvent[] {
  if (!existsSync(logDir)) return []
  const files = readdirSync(logDir)
    .filter(file => file.endsWith('.ndjson'))
    .sort()
    .map(file => join(logDir, file))

  return files.flatMap(file => parseLogFile(file))
}

export function filterLogEventsForPR(
  events: PRWorkflowLogEvent[],
  owner: string,
  repo: string,
  pr: number,
): PRWorkflowLogEvent[] {
  const fullName = `${owner}/${repo}`
  return events.filter(event => event.repo === fullName && event.pr === pr)
}

function parseLogFile(path: string): PRWorkflowLogEvent[] {
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(line => line.trim().length > 0)
    .flatMap(line => {
      try {
        const parsed = JSON.parse(line) as unknown
        return isWorkflowLogEvent(parsed) ? [parsed] : []
      } catch {
        return []
      }
    })
}

function isWorkflowLogEvent(value: unknown): value is PRWorkflowLogEvent {
  if (typeof value !== 'object' || value === null) return false
  const record = value as Record<string, unknown>
  return typeof record.ts === 'string' && typeof record.event === 'string'
}

// Use createdAt for ordering annotation timestamps — updatedAt would flip verdict
// ordering if an older comment is edited after a newer one is posted.
// Returns all annotations sorted descending by createdAt; bare markers without
// a verdict are included so callers can skip them when searching for a verdict.
function latestTimedAnnotations(comments: PRActivityComment[]): TimedAnnotation[] {
  return comments.flatMap(comment => {
    const annotation = parseCrosscheckAnnotation(comment.body)
    if (!annotation) return []
    return [{ annotation, timestamp: comment.createdAt }]
  }).sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))
}

function latestTimedVerdict(input: PRStatusInput, annotations: TimedAnnotation[]): TimedVerdict | null {
  const annotationVerdicts = annotations.flatMap(({ annotation, timestamp }) => (
    annotation.verdict
      ? [{ verdict: annotation.verdict, timestamp, annotation }]
      : []
  ))

  const logVerdicts = input.logEvents.flatMap(event => {
    if (event.event !== 'review_complete' && event.event !== 'workflow_complete') return []
    const verdict = normalizeVerdict(event.verdict ?? event.last_verdict)
    return verdict ? [{ verdict, timestamp: event.ts, annotation: null }] : []
  })

  return [...annotationVerdicts, ...logVerdicts]
    .sort((a, b) => Date.parse(b.timestamp) - Date.parse(a.timestamp))[0] ?? null
}

function latestAppliedFixAfter(events: PRWorkflowLogEvent[], after: string | undefined): PRWorkflowLogEvent | null {
  const afterMs = after ? Date.parse(after) : 0
  return events
    .filter(event => Date.parse(event.ts) >= afterMs)
    .filter(event => {
      if (event.event === 'fix_complete') return typeof event.applied_count === 'number' && event.applied_count > 0
      if (event.event === 'conflict_resolve_complete') return typeof event.conflicts_resolved === 'number' && event.conflicts_resolved > 0
      return false
    })
    .sort((a, b) => Date.parse(b.ts) - Date.parse(a.ts))[0] ?? null
}

function verdictToReviewState(verdict: CrosscheckVerdict): ReviewState {
  if (verdict === 'APPROVE') return 'APPROVED'
  return 'NEEDS_FIX' // NEEDS_WORK and BLOCK both require a fix; severity is on the verdict field
}

function computeReviewState(latestVerdict: TimedVerdict | null, latestFix: PRWorkflowLogEvent | null): ReviewState {
  if (!latestVerdict) return 'NEEDS_REVIEW'
  if (latestFix) return 'NEEDS_RECHECK'
  return verdictToReviewState(latestVerdict.verdict)
}

function nextActionForState(state: ReviewState): NextAction {
  if (state === 'NEEDS_REVIEW') return 'review'
  if (state === 'NEEDS_RECHECK') return 'recheck'
  if (state === 'NEEDS_FIX') return 'fix'
  if (state === 'APPROVED') return 'merge'
  return null
}

function createConcurrencyLimiter(limit: number): <T>(task: () => Promise<T>) => Promise<T> {
  let active = 0
  const waiting: Array<() => void> = []

  return async function limitTask<T>(task: () => Promise<T>): Promise<T> {
    if (active >= limit) {
      await new Promise<void>(resolve => {
        waiting.push(resolve)
      })
    }
    active += 1
    try {
      return await task()
    } finally {
      active -= 1
      waiting.shift()?.()
    }
  }
}

function maxTimestampMs(values: Array<string | undefined>): number | null {
  const timestamps = values
    .filter((value): value is string => typeof value === 'string')
    .map(value => Date.parse(value))
    .filter(value => Number.isFinite(value))
  if (timestamps.length === 0) return null
  return Math.max(...timestamps)
}

function normalizeVerdict(value: unknown): CrosscheckVerdict | null {
  if (typeof value !== 'string') return null
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE' || normalized === 'NEEDS_WORK' || normalized === 'BLOCK') return normalized
  return null
}

async function buildRepoScopes(config: Config, token: string): Promise<Array<{ owner: string; repo: string }>> {
  const userScopes = await Promise.all(
    config.users.map(async (user) => {
      try {
        const repos = await listUserRepos(user, token)
        return repos.map(({ owner, name }) => ({ owner, repo: name }) as Scope)
      } catch (err: unknown) {
        logError({ event: 'scan_user_scope_skipped', user }, err)
        return [] as Scope[]
      }
    }),
  )

  const rawScopes: Scope[] = [
    ...config.orgs.map(org => ({ org }) as Scope),
    ...config.repos.map(repo => ({ owner: repo.owner, repo: repo.name }) as Scope),
    ...userScopes.flat(),
  ]

  const deduped = dedupScopes(rawScopes).scopes
  const expanded = await Promise.all(
    deduped.map(async (scope) => {
      if ('org' in scope) {
        try {
          const repos = await listOrgRepos(scope.org, token)
          return repos.map(repo => ({ owner: repo.owner, repo: repo.name }))
        } catch (err: unknown) {
          logError({ event: 'scan_org_scope_skipped', org: scope.org }, err)
          return [] as Array<{ owner: string; repo: string }>
        }
      }
      return [{ owner: scope.owner, repo: scope.repo }]
    }),
  )

  const byKey = new Map<string, { owner: string; repo: string }>()
  for (const repo of expanded.flat()) {
    byKey.set(`${repo.owner.toLowerCase()}/${repo.repo.toLowerCase()}`, repo)
  }
  return [...byKey.values()]
}

// ── Legacy API (used by backtrace.ts / watch workflow) ──────────────────────
// This block preserves the foldPRStatus-based API that was present in staging.
// The scan command uses the newer derivePRStatus / ScanPRStatus API above.

export type PRReviewState = 'NEEDS_REVIEW' | 'APPROVED' | 'NEEDS_FIX' | 'FIX_IN_PROGRESS' | 'NEEDS_RECHECK'
export type PRNextAction = 'review' | 'fix' | 'recheck' | 'none'
export type PRVerdict = 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'

export interface PRStatusCommit {
  sha: string
  committedAt?: string
  committed_at?: string
}

export interface PRStatusCommitStatus {
  context: string
  state: string
  updatedAt?: string
  updated_at?: string
}

export interface PRStatusPullRequest {
  owner: string
  repo: string
  number: number
  title: string
  author: string
  headSha: string
  headRef: string
  headRepo: string | null
  baseRef: string
  body: string | null
  createdAt: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
  commits?: PRStatusCommit[]
  commitStatuses?: PRStatusCommitStatus[]
  statuses?: PRStatusCommitStatus[]
}

export interface PRStatusComment {
  id: number
  body: string
  createdAt?: string
  created_at?: string
  updatedAt?: string
  updated_at?: string
}

export interface PRStatusLogEvent {
  ts?: string
  level?: string
  event: string
  repo?: string
  pr?: number
  sha?: string
  headSha?: string
  head_sha?: string
  step_type?: string
  type?: string
  verdict?: string | null
  applied_count?: number
  tokens_used?: number
  [key: string]: unknown
}

export interface TokenBucket {
  review: number
  fix: number
  recheck: number
  total: number
}

export interface TokenTotals {
  byPR: Record<string, TokenBucket>
  byPRHeadSha: Record<string, TokenBucket>
}

export interface PRProgressStep {
  kind: 'cr' | 'fix' | 'recheck'
  at: Date
  verdict?: PRVerdict
  appliedCount?: number
  tokens?: number
}

// Legacy PRStatus — distinct from ScanPRStatus (the scan command shape).
// Used by backtrace.ts and the watch workflow.
export interface PRStatus {
  pr: PRStatusPullRequest
  state: PRReviewState
  nextAction: PRNextAction
  verdict: PRVerdict | null
  lastActive: Date
  tokenTotals: TokenBucket
  progress: PRProgressStep[]
  stale?: boolean
}

interface LegacyParsedAnnotation {
  marker?: string
  type?: string
  reviewer?: string
  verdict?: PRVerdict
}

interface LegacyReviewEvent {
  type: 'review' | 'recheck'
  verdict: PRVerdict
  at: Date
}

interface LegacyFixEvent {
  at: Date
  appliedCount?: number
  tokens?: number
  complete: boolean
}

const LEGACY_EMPTY_BUCKET: TokenBucket = { review: 0, fix: 0, recheck: 0, total: 0 }

function legacyCloneBucket(bucket: TokenBucket = LEGACY_EMPTY_BUCKET): TokenBucket {
  return { review: bucket.review, fix: bucket.fix, recheck: bucket.recheck, total: bucket.total }
}

function legacyAddTokens(bucket: TokenBucket, kind: keyof Omit<TokenBucket, 'total'>, tokens: number): void {
  bucket[kind] += tokens
  bucket.total += tokens
}

function legacyPrKey(owner: string, repo: string, number: number): string {
  return `${owner}/${repo}#${number}`
}

function legacyLogEventKey(event: PRStatusLogEvent): string | null {
  if (!event.repo || typeof event.pr !== 'number') return null
  return `${event.repo}#${event.pr}`
}

function legacyLogEventSha(event: PRStatusLogEvent): string | null {
  if (typeof event.sha === 'string' && event.sha.length > 0) return event.sha
  if (typeof event.headSha === 'string' && event.headSha.length > 0) return event.headSha
  if (typeof event.head_sha === 'string' && event.head_sha.length > 0) return event.head_sha
  return null
}

function legacyParseDate(value: unknown): Date | null {
  if (typeof value !== 'string') return null
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? null : date
}

function legacyMaxDate(current: Date | null, candidate: Date | null): Date | null {
  if (!candidate) return current
  if (!current || candidate.getTime() > current.getTime()) return candidate
  return current
}

function legacyNormalizeVerdict(value: string | undefined): PRVerdict | undefined {
  if (!value) return undefined
  const normalized = value.trim().toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE') return 'APPROVE'
  if (normalized === 'NEEDS_WORK' || normalized === 'NEEDSWORK') return 'NEEDS_WORK'
  if (normalized === 'BLOCK') return 'BLOCK'
  return undefined
}

function legacyParseLatestAnnotation(body: string): LegacyParsedAnnotation | null {
  const fields = parseAnnotationFieldsFenced(body)
  if (!fields) return null

  const attrs: LegacyParsedAnnotation = {}
  for (const [key, value] of fields) {
    if (key === '__marker__') attrs.marker = value
    else if (key === 'type') attrs.type = value
    else if (key === 'reviewer') attrs.reviewer = value
    else if (key === 'verdict') attrs.verdict = legacyNormalizeVerdict(value)
  }
  return attrs
}

function legacyCommentCreatedAt(comment: PRStatusComment): Date | null {
  return legacyParseDate(comment.createdAt) ?? legacyParseDate(comment.created_at)
}

function legacyCommentDate(comment: PRStatusComment): Date | null {
  return legacyParseDate(comment.updatedAt) ?? legacyParseDate(comment.updated_at)
    ?? legacyParseDate(comment.createdAt) ?? legacyParseDate(comment.created_at)
}

function legacyCollectReviewEvents(comments: PRStatusComment[]): LegacyReviewEvent[] {
  const events: LegacyReviewEvent[] = []
  for (const comment of comments) {
    const annotation = legacyParseLatestAnnotation(comment.body)
    const at = legacyCommentCreatedAt(comment)
    if (!annotation?.verdict || !at) continue
    if (annotation.type === 'review' || annotation.type === 'recheck') {
      events.push({ type: annotation.type, verdict: annotation.verdict, at })
      continue
    }
    if (!annotation.type && annotation.reviewer) {
      events.push({
        type: comment.body.startsWith('> Recheck of') ? 'recheck' : 'review',
        verdict: annotation.verdict,
        at,
      })
    }
  }
  return events.sort((a, b) => a.at.getTime() - b.at.getTime())
}

function legacyCollectCommentFixEvents(comments: PRStatusComment[]): LegacyFixEvent[] {
  const events: LegacyFixEvent[] = []
  for (const comment of comments) {
    const annotation = legacyParseLatestAnnotation(comment.body)
    const at = legacyCommentCreatedAt(comment)
    if (!annotation || !at) continue
    if (annotation.marker === 'fix_applied') events.push({ at, complete: true })
  }
  return events
}

function legacyIsFixStartedEvent(event: PRStatusLogEvent): boolean {
  return event.event === 'fix_started'
    || (event.event === 'step_started' && (event.step_type === 'fix' || event.type === 'fix'))
}

function legacyCollectLogFixEvents(logEvents: PRStatusLogEvent[]): LegacyFixEvent[] {
  return logEvents.flatMap((event): LegacyFixEvent[] => {
    const at = legacyParseDate(event.ts)
    if (!at) return []
    if (event.event === 'fix_complete') {
      return [{
        at,
        appliedCount: typeof event.applied_count === 'number' ? event.applied_count : undefined,
        tokens: typeof event.tokens_used === 'number' ? event.tokens_used : undefined,
        complete: true,
      }]
    }
    if (legacyIsFixStartedEvent(event)) return [{ at, complete: false }]
    return []
  }).sort((a, b) => a.at.getTime() - b.at.getTime())
}

function legacyCollectProgress(reviewEvents: LegacyReviewEvent[], fixEvents: LegacyFixEvent[]): PRProgressStep[] {
  const steps: PRProgressStep[] = [
    ...reviewEvents.map((event, index): PRProgressStep => ({
      kind: event.type === 'review' && index === 0 ? 'cr' : 'recheck',
      at: event.at,
      verdict: event.verdict,
    })),
    ...fixEvents.filter(event => event.complete).map((event): PRProgressStep => ({
      kind: 'fix',
      at: event.at,
      appliedCount: event.appliedCount,
      tokens: event.tokens,
    })),
  ]
  return steps.sort((a, b) => a.at.getTime() - b.at.getTime())
}

function legacyRelevantLogEvents(pr: PRStatusPullRequest, logEvents: PRStatusLogEvent[]): PRStatusLogEvent[] {
  const key = legacyPrKey(pr.owner, pr.repo, pr.number)
  return logEvents.filter(event => legacyLogEventKey(event) === key)
}

function legacyRelevantLogDate(event: PRStatusLogEvent): Date | null {
  if (
    event.event === 'review_complete'
    || event.event === 'fix_complete'
    || event.event === 'conflict_resolve_complete'
    || event.event === 'comment_posted'
    || event.event === 'pr_received'
    || event.event === 'pr_skipped'
    || legacyIsFixStartedEvent(event)
  ) {
    return legacyParseDate(event.ts)
  }
  return null
}

export function computeTokenTotals(logEvents: PRStatusLogEvent[]): TokenTotals {
  const totals: TokenTotals = { byPR: {}, byPRHeadSha: {} }
  for (const event of logEvents) {
    const key = legacyLogEventKey(event)
    const tokens = typeof event.tokens_used === 'number' ? event.tokens_used : 0
    if (!key || tokens <= 0) continue

    const kind = event.event === 'fix_complete'
      ? 'fix'
      : event.event === 'review_complete' && (event.step_type === 'recheck' || event.type === 'recheck')
        ? 'recheck'
        : event.event === 'review_complete'
          ? 'review'
          : null
    if (!kind) continue

    totals.byPR[key] = legacyCloneBucket(totals.byPR[key])
    legacyAddTokens(totals.byPR[key], kind, tokens)

    const sha = legacyLogEventSha(event)
    if (sha) {
      const shaKey = `${key}@${sha}`
      totals.byPRHeadSha[shaKey] = legacyCloneBucket(totals.byPRHeadSha[shaKey])
      legacyAddTokens(totals.byPRHeadSha[shaKey], kind, tokens)
    }
  }
  return totals
}

export function computeLastActive(
  pr: PRStatusPullRequest,
  comments: PRStatusComment[],
  logEvents: PRStatusLogEvent[],
): Date {
  let latest = legacyParseDate(pr.updatedAt) ?? legacyParseDate(pr.updated_at)
    ?? legacyParseDate(pr.createdAt) ?? legacyParseDate(pr.created_at)

  for (const comment of comments) {
    latest = legacyMaxDate(latest, legacyCommentDate(comment))
  }

  for (const event of legacyRelevantLogEvents(pr, logEvents)) {
    latest = legacyMaxDate(latest, legacyRelevantLogDate(event))
  }
  for (const commit of pr.commits ?? []) {
    latest = legacyMaxDate(latest, legacyParseDate(commit.committedAt) ?? legacyParseDate(commit.committed_at))
  }
  for (const status of [...(pr.commitStatuses ?? []), ...(pr.statuses ?? [])]) {
    latest = legacyMaxDate(latest, legacyParseDate(status.updatedAt) ?? legacyParseDate(status.updated_at))
  }

  return latest ?? new Date(0)
}

export function foldPRStatus(
  pr: PRStatusPullRequest,
  comments: PRStatusComment[],
  logEvents: PRStatusLogEvent[],
): PRStatus {
  const logsForPR = legacyRelevantLogEvents(pr, logEvents)
  const reviewEvents = legacyCollectReviewEvents(comments)
  const fixEvents = [...legacyCollectCommentFixEvents(comments), ...legacyCollectLogFixEvents(logsForPR)]
    .sort((a, b) => a.at.getTime() - b.at.getTime())
  const latestReview = reviewEvents.at(-1)
  const latestFixAfterReview = latestReview
    ? fixEvents.filter(event => event.at.getTime() > latestReview.at.getTime()).at(-1)
    : undefined

  let state: PRReviewState = 'NEEDS_REVIEW'
  let nextAction: PRNextAction = 'review'
  const verdict = latestReview?.verdict ?? null

  if (latestReview) {
    if (latestReview.verdict === 'APPROVE') {
      state = 'APPROVED'
      nextAction = 'none'
    } else if (latestFixAfterReview?.complete) {
      state = 'NEEDS_RECHECK'
      nextAction = 'recheck'
    } else if (latestFixAfterReview && !latestFixAfterReview.complete) {
      state = 'FIX_IN_PROGRESS'
      nextAction = 'fix'
    } else {
      // NEEDS_WORK and BLOCK both land in NEEDS_FIX; severity is preserved in verdict
      state = 'NEEDS_FIX'
      nextAction = 'fix'
    }
  }

  const totals = computeTokenTotals(logsForPR)
  const key = legacyPrKey(pr.owner, pr.repo, pr.number)

  return {
    pr,
    state,
    nextAction,
    verdict,
    lastActive: computeLastActive(pr, comments, logEvents),
    tokenTotals: legacyCloneBucket(totals.byPR[key]),
    progress: legacyCollectProgress(reviewEvents, fixEvents),
  }
}

export function isStale(status: PRStatus, staleAfter: number): boolean {
  return Date.now() - status.lastActive.getTime() > staleAfter
}

function legacyFormatTokens(tokens: number | undefined): string | null {
  if (tokens === undefined || tokens <= 0) return null
  if (tokens < 1000) return String(tokens)
  const rounded = Math.round(tokens / 100) / 10
  return `${Number.isInteger(rounded) ? rounded.toFixed(0) : rounded.toFixed(1)}K`
}

export function buildProgressSummary(status: PRStatus): string {
  const parts = ['PR']
  let fixCount = 0
  let recheckCount = 0
  let sawCR = false
  let skipped = 0

  for (const step of status.progress) {
    if (step.kind === 'cr') {
      if (sawCR || !step.verdict) continue
      parts.push(`CR(${step.verdict})`)
      sawCR = true
      continue
    }
    if (step.kind === 'fix') {
      if (fixCount >= 2) { skipped++; continue }
      fixCount++
      const count = step.appliedCount ?? 0
      const tokens = legacyFormatTokens(step.tokens)
      parts.push(tokens ? `Fix(${count}, ${tokens})` : `Fix(${count})`)
      continue
    }
    if (step.kind === 'recheck') {
      if (recheckCount >= 2) { skipped++; continue }
      if (!step.verdict) continue
      recheckCount++
      parts.push(`Recheck(${step.verdict})`)
    }
  }

  if (skipped > 0) parts.push(`+${skipped} more`)

  return parts.join(' -> ')
}
