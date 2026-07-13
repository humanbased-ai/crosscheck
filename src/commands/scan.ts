import chalk from 'chalk'
import { createHash } from 'crypto'
import { getGithubToken, loadConfig } from '../config/loader.js'
import type { Config } from '../config/schema.js'
import { formatDuration, parseDuration } from '../lib/durations.js'
import { initLogger, logError } from '../lib/logger.js'
import { UserInputError } from '../lib/pr-picker.js'
import { scanOpenPRStatuses, type ScanPRStatus as PRStatus, type ScanResult } from '../lib/pr-status.js'
import { readRepoWorkflowStepTypes } from '../lib/repo-workflow.js'
import { readScanCache, writeScanCache, type ScanCachePayload } from '../lib/scan-cache.js'

export interface ScanOpts {
  tidy?: boolean
  force?: boolean
  staleAfter?: string
  json?: boolean
}

interface LoadScanOptions {
  force?: boolean
  staleAfterMs: number
}

export async function loadScanResult(options: LoadScanOptions): Promise<ScanResult> {
  const config = loadConfig()
  initLogger(config.logs)
  const token = getGithubToken()
  const now = new Date()
  const scopeHash = buildScanScopeHash(config)

  if (!options.force) {
    const cached = readScanCache({
      nowMs: now.getTime(),
      staleAfterMs: options.staleAfterMs,
      scopeHash,
    })
    if (cached) return { ...cached, cached: true }
  }

  const scan = await scanOpenPRStatuses(config, token, {
    now,
    staleAfterMs: options.staleAfterMs,
  })
  const result = { ...scan, scopeHash }
  writeScanCache(toCachePayload(result))
  return result
}

export async function runScan(opts: ScanOpts = {}): Promise<void> {
  let staleAfterMs: number
  try {
    staleAfterMs = parseDuration(opts.staleAfter ?? '24h')
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  try {
    const result = await loadScanResult({ force: opts.force, staleAfterMs })
    if (opts.json) {
      console.log(JSON.stringify(result, null, 2))
      return
    }
    printScanResult(result, opts.tidy === true)
  } catch (err: unknown) {
    handleScanError('scan', err)
  }
}

export function printScanResult(result: ScanResult, tidy: boolean): void {
  const visible = tidy
    ? result.prs.filter(pr => pr.freshness === 'stale' && pr.nextAction !== null)
    : result.prs

  const cacheNote = result.cached ? chalk.dim(' cached') : ''
  console.log(`crosscheck scan${cacheNote}`)
  console.log(chalk.dim(`  scanned     ${result.scannedAt}`))
  console.log(chalk.dim(`  stale after ${formatDuration(result.staleAfterMs)}`))
  console.log(`  total       ${result.summary.total}`)
  console.log(`  stale       ${chalk.yellow(result.summary.stale)}`)
  console.log(`  actionable  ${chalk.cyan(result.summary.actionable)}`)
  console.log()

  if (visible.length === 0) {
    console.log(tidy ? chalk.dim('No stale PRs need attention.') : chalk.dim('No open PRs found in the configured monitor scope.'))
    return
  }

  for (const pr of visible) {
    console.log(formatPRLine(pr))
  }
}

function formatPRLine(pr: PRStatus): string {
  const freshness = pr.freshness === 'stale' ? chalk.yellow('stale') : chalk.dim('not_stale')
  const next = pr.nextAction ? `next=${pr.nextAction}` : 'terminal'
  const age = formatAge(pr.ageMs)
  return [
    `  ${freshness}`,
    chalk.cyan(`#${pr.number}`),
    `${pr.owner}/${pr.repo}`,
    chalk.bold(pr.reviewState),
    chalk.dim(`last=${age}`),
    chalk.dim(next),
    pr.title,
  ].join('  ')
}

function formatAge(ms: number): string {
  const minuteMs = 60 * 1000
  const hourMs = 60 * minuteMs
  const dayMs = 24 * hourMs
  if (ms >= dayMs) return `${Math.floor(ms / dayMs)}d`
  if (ms >= hourMs) return `${Math.floor(ms / hourMs)}h`
  return `${Math.floor(ms / minuteMs)}m`
}

function toCachePayload(result: ScanResult): ScanCachePayload {
  return {
    scannedAt: result.scannedAt,
    staleAfterMs: result.staleAfterMs,
    ...(result.scopeHash && { scopeHash: result.scopeHash }),
    summary: result.summary,
    prs: result.prs,
  }
}

export function handleScanError(command: string, err: unknown): never {
  logError({ command }, err)
  const message = err instanceof Error ? err.message : String(err)
  console.error(chalk.red(`✗ ${message}`))
  process.exit(isUserError(err, message) ? 1 : 2)
}

function isUserError(err: unknown, message: string): boolean {
  return err instanceof UserInputError
    || message.startsWith('No GitHub token found')
    || message.includes('Invalid configuration')
}

function buildScanScopeHash(config: Config): string {
  const scope = {
    orgs: [...config.orgs].sort(),
    repos: config.repos.map(repo => `${repo.owner}/${repo.name}:${readRepoWorkflowStepTypes(repo.owner, repo.name)?.join(',') ?? 'default'}`).sort(),
    users: [...config.users].sort(),
    allowedAuthors: [...config.routing.allowed_authors].sort(),
  }
  return createHash('sha256').update(JSON.stringify(scope)).digest('hex')
}

type ReviewState = 'PR' | 'APPROVE' | 'NEEDS_WORK' | 'BLOCK'
type StepType = 'review' | 'fix' | 'recheck'

export interface ScanTokens {
  review: number
  fix: number
  recheck: number
  total: number
}

export interface ScanAnnotationMetadata {
  commentId: number
  commentCreatedAt: string
  raw: string
  origin?: string
  reviewer?: string
  verdict?: ReviewState
  type?: string
  isRecheck?: boolean
}

export interface ScanRow {
  repo: string
  pr: number
  title: string
  author: string
  branch: string
  headSha: string
  headShaShort: string
  url: string
  createdAt: string
  lastActiveAt: string
  isStale: boolean
  reviewState: ReviewState
  latestVerdict: ReviewState | null
  progressSummary: string
  tokens: ScanTokens
  latestAnnotation: ScanAnnotationMetadata | null
  nextAction: string | null
}

export interface LogEntry {
  ts: string
  event: string
  repo?: string
  pr?: number
  step_type?: string
  verdict?: string | null
  tokens_used?: number
  applied_count?: number
  conflicts_resolved?: number
  reason?: string
}

export interface PRLogSummary {
  reviewVerdict: ReviewState | null
  recheckVerdict: ReviewState | null
  latestVerdict: ReviewState | null
  latestVerdictAt: string | null
  latestStep: StepType | null
  latestLogAt: string | null
  fixAppliedCount: number | null
  fixCompletedAt: string | null
  tokens: ScanTokens
}

export function filterScanRowsForOutput(rows: ScanRow[], tidy: boolean): ScanRow[] {
  if (!tidy) return rows
  return rows.filter(row => row.isStale && row.nextAction !== null)
}

export function chooseLatestVerdict(
  annotationVerdict: ReviewState,
  annotationAt: string,
  logSummary: PRLogSummary,
): ReviewState | null {
  if (!logSummary.latestVerdictAt) return annotationVerdict
  return new Date(annotationAt).getTime() >= new Date(logSummary.latestVerdictAt).getTime()
    ? annotationVerdict
    : logSummary.latestVerdict
}

export function selectNextAction(latestVerdict: ReviewState | null, logSummary: PRLogSummary): string | null {
  if (!latestVerdict || latestVerdict === 'PR') return 'next CR'
  if (latestVerdict === 'APPROVE') return 'next merge'
  if (latestVerdict === 'NEEDS_WORK' || latestVerdict === 'BLOCK') {
    if (logSummary.latestStep === 'fix') return 'next recheck'
    return 'next fix'
  }
  return null
}

export function buildProgressSummary(annotation: ScanAnnotationMetadata | null, logSummary: PRLogSummary): string {
  const parts = ['PR']
  if (logSummary.reviewVerdict) {
    parts.push(`CR(${logSummary.reviewVerdict})`)
  } else if (annotation?.verdict) {
    parts.push(`${annotation.isRecheck ? 'recheck' : 'CR'}(${annotation.verdict})`)
  }
  if (logSummary.fixAppliedCount !== null) parts.push(`fix(${logSummary.fixAppliedCount})`)
  const recheckVerdict = logSummary.recheckVerdict
  if (recheckVerdict) parts.push(`recheck(${recheckVerdict})`)
  return parts.join(' -> ')
}

interface ScanAnnotations {
  latestAnnotation: ScanAnnotationMetadata | null
  latestVerdictAnnotation: ScanAnnotationMetadata | null
}

export function findLatestAnnotation(comments: Array<{
  id: number
  body: string
  createdAt: string
  author?: string
  updatedAt?: string
}>): ScanAnnotations {
  let latestAnnotation: ScanAnnotationMetadata | null = null
  let latestVerdictAnnotation: ScanAnnotationMetadata | null = null
  const orderedComments = [...comments].sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  )
  for (const comment of orderedComments) {
    const matches = [...comment.body.matchAll(/<!-- crosscheck: ([^>]+) -->/g)]
    const match = matches.at(-1)
    if (!match) continue

    const attrs = parseAttrs(match[1])
    const annotation: ScanAnnotationMetadata = {
      commentId: comment.id,
      commentCreatedAt: comment.createdAt,
      raw: match[1],
      origin: attrs.origin,
      reviewer: attrs.reviewer,
      verdict: normalizeReviewState(attrs.verdict) ?? undefined,
      type: attrs.type,
      isRecheck: attrs.type === 'recheck' || comment.body.startsWith('> Recheck of'),
    }
    latestAnnotation = annotation
    if (annotation.verdict) latestVerdictAnnotation = annotation
  }
  return { latestAnnotation, latestVerdictAnnotation }
}

export function applyLogEntry(summary: PRLogSummary, entry: LogEntry): void {
  if (entry.ts) summary.latestLogAt = maxTimestamp([summary.latestLogAt, entry.ts])

  if (entry.event === 'review_complete') {
    const verdict = normalizeReviewState(entry.verdict ?? undefined)
    const stepType: 'review' | 'recheck' = entry.step_type === 'recheck' ? 'recheck' : 'review'
    if (stepType === 'recheck') summary.recheckVerdict = verdict
    else summary.reviewVerdict = verdict
    if (verdict) {
      summary.latestVerdict = verdict
      summary.latestVerdictAt = entry.ts
      summary.latestStep = stepType
    }
    addTokens(summary.tokens, stepType, entry.tokens_used)
  } else if (entry.event === 'fix_complete') {
    if (entry.applied_count !== undefined) summary.fixAppliedCount = entry.applied_count
    summary.fixCompletedAt = entry.ts
    summary.latestStep = 'fix'
    addTokens(summary.tokens, 'fix', entry.tokens_used)
  } else if (entry.event === 'conflict_resolve_complete') {
    if (entry.conflicts_resolved !== undefined) summary.fixAppliedCount = entry.conflicts_resolved
    summary.fixCompletedAt = entry.ts
    summary.latestStep = 'fix'
    addTokens(summary.tokens, 'fix', entry.tokens_used)
  }
}

export function emptyLogSummary(): PRLogSummary {
  return {
    reviewVerdict: null,
    recheckVerdict: null,
    latestVerdict: null,
    latestVerdictAt: null,
    latestStep: null,
    latestLogAt: null,
    fixAppliedCount: null,
    fixCompletedAt: null,
    tokens: { review: 0, fix: 0, recheck: 0, total: 0 },
  }
}

function parseAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {}
  for (const part of raw.trim().split(/\s+/)) {
    const eq = part.indexOf('=')
    if (eq <= 0) continue
    attrs[part.slice(0, eq)] = part.slice(eq + 1)
  }
  return attrs
}

function normalizeReviewState(value: string | undefined | null): ReviewState | null {
  if (!value) return null
  const normalized = value.toUpperCase().replace(/\s+/g, '_')
  if (normalized === 'APPROVE') return 'APPROVE'
  if (normalized === 'NEEDS_WORK') return 'NEEDS_WORK'
  if (normalized === 'BLOCK') return 'BLOCK'
  return null
}

function maxTimestamp(values: Array<string | null | undefined>): string | null {
  let latest: string | null = null
  for (const value of values) {
    if (!value) continue
    if (Number.isNaN(new Date(value).getTime())) continue
    if (!latest || new Date(value).getTime() > new Date(latest).getTime()) latest = value
  }
  return latest
}

function addTokens(tokens: ScanTokens, step: StepType, value: number | undefined): void {
  if (value === undefined) return
  tokens[step] += value
  tokens.total += value
}
