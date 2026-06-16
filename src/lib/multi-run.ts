import chalk from 'chalk'
import { classifyError, type ErrorCategory } from './logger.js'
import { hintForError } from './remediation.js'
import type { PRRef } from './pr-spec.js'

// Fans an ad-hoc PR spec out across many PRs. Each PR is executed by an injected
// `dispatch` (in practice, a `crosscheck run`/`review` subprocess), so per-PR
// process.exit, locking, and signal handling stay isolated to the child. This
// module owns only the worker-pool scheduling, output capture, and summary.

export interface MultiPRResult {
  ref: PRRef
  status: 'executed' | 'failed'
  reason?: ErrorCategory
}

export interface MultiRunDeps {
  /** Run one PR. Returning a string surfaces captured subprocess output; void means it streamed live. */
  dispatch: (ref: PRRef) => Promise<string | void>
  /** Route status messages through a custom sink (defaults to console.log). */
  log?: (msg: string) => void
}

export interface ConcurrencyOpts {
  /** Force one-at-a-time execution. */
  sequential?: boolean
  /** Parallel cap: undefined/0 = one agent per PR; N = cap at N. */
  concurrent?: number
  /** ms delay between concurrent worker starts; default 2000 when running in parallel. */
  staggerMs?: number
}

export const DEFAULT_STAGGER_MS = 2_000

// Returns a user-facing error message for invalid concurrency flags, or null when valid.
// Guards against NaN/negative values that would otherwise make the worker pool spawn
// zero workers and leave the results array full of holes.
export function concurrencyError(opts: ConcurrencyOpts): string | null {
  if (opts.concurrent !== undefined && (!Number.isInteger(opts.concurrent) || opts.concurrent < 0)) {
    return '--concurrent must be a non-negative integer (0 = one agent per PR)'
  }
  if (opts.staggerMs !== undefined && (!Number.isInteger(opts.staggerMs) || opts.staggerMs < 0)) {
    return '--stagger must be a non-negative integer (milliseconds)'
  }
  return null
}

export function resolveRunConcurrency(count: number, opts: ConcurrencyOpts): { concurrency: number; staggerMs: number } {
  const concurrency = (opts.sequential || opts.concurrent === 1)
    ? 1
    : (opts.concurrent === undefined || opts.concurrent === 0)
      ? count
      : Math.max(1, opts.concurrent)
  const staggerMs = concurrency > 1 ? (opts.staggerMs ?? DEFAULT_STAGGER_MS) : 0
  return { concurrency, staggerMs }
}

function prSignature(ref: PRRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`
}

function printCapturedOutput(label: string, output: string, log: (msg: string) => void): void {
  const lines = output.trimEnd().split('\n')
  log(chalk.dim(`\n── ${label} ${'─'.repeat(Math.max(0, 48 - label.length))}`))
  for (const line of lines) log(`  ${line}`)
}

// Classify a dispatch failure using execa's structured fields rather than the raw
// message. execa's message embeds the full command string (which contains flags like
// --timeout), so a text match against it would misclassify ordinary failures.
function messageForClassify(err: unknown): string {
  const e = err as Record<string, unknown>
  if (e.timedOut === true) return 'timed out'
  if (typeof e.exitCode === 'number') {
    const stderr = typeof e.stderr === 'string' ? e.stderr.trim() : ''
    return stderr || (err instanceof Error ? err.message.replace(/:\s*\S.*$/, '') : String(err))
  }
  return err instanceof Error ? err.message : String(err)
}

function formatElapsed(ms: number): string {
  return ms >= 1000 ? `${(ms / 1000).toFixed(1)}s` : `${ms}ms`
}

export async function executeMultiPR(
  refs: PRRef[],
  deps: MultiRunDeps,
  concurrency = 1,
  staggerMs = 0,
): Promise<MultiPRResult[]> {
  const results: MultiPRResult[] = new Array(refs.length)
  const log = deps.log ?? console.log

  const executeOne = async (ref: PRRef, index: number): Promise<void> => {
    const sig = prSignature(ref)
    const startedAt = Date.now()
    log(chalk.cyan(`\n→ run  ${sig}`))
    try {
      const output = await deps.dispatch(ref)
      if (typeof output === 'string' && output) printCapturedOutput(sig, output, log)
      results[index] = { ref, status: 'executed' }
      log(chalk.green(`✓ done  ${sig}  ${formatElapsed(Date.now() - startedAt)}`))
    } catch (err: unknown) {
      const msg = messageForClassify(err)
      const category = classifyError(msg)
      const hint = hintForError(category, msg)
      const captured = (err as Record<string, unknown>).all
      if (typeof captured === 'string' && captured.trim()) printCapturedOutput(sig, captured, log)
      log(chalk.red(`✗ failed  ${sig}`) + chalk.dim(` [${category}]`) + (hint ? `\n    ${chalk.yellow('→')} ${hint}` : ''))
      results[index] = { ref, status: 'failed', reason: category }
    }
  }

  if (concurrency <= 1) {
    for (let i = 0; i < refs.length; i++) await executeOne(refs[i], i)
  } else {
    // Worker pool: up to `concurrency` PRs run in parallel. A positive stagger spreads
    // each worker's first start over time so concurrent subprocess startup (each making
    // its own GitHub calls) doesn't hit the API in a single burst.
    let ptr = 0
    const makeWorker = (workerIdx: number) => async (): Promise<void> => {
      if (staggerMs > 0 && workerIdx > 0) {
        await new Promise<void>(resolve => setTimeout(resolve, workerIdx * staggerMs))
      }
      while (ptr < refs.length) {
        const i = ptr++
        await executeOne(refs[i], i)
      }
    }
    await Promise.all(Array.from(
      { length: Math.min(concurrency, refs.length) },
      (_, idx) => makeWorker(idx)(),
    ))
  }

  return results
}

export function summarizeMultiPR(results: MultiPRResult[]): string {
  const executed = results.filter(r => r.status === 'executed').length
  const failed = results.filter(r => r.status === 'failed').length
  return `Multi-PR summary: ${executed} executed, ${failed} failed`
}

export function printMultiPRSummary(results: MultiPRResult[], log: (msg: string) => void = console.log): void {
  log(chalk.dim(`\n${summarizeMultiPR(results)}`))
  const seenHints = new Set<string>()
  for (const r of results.filter(r => r.status === 'failed')) {
    const category = r.reason ?? 'unknown'
    const hint = hintForError(category, category)
    log(chalk.red(`  ✗ ${prSignature(r.ref)}`) + chalk.dim(` [${category}]`))
    if (hint && !seenHints.has(hint)) {
      seenHints.add(hint)
      log(`    ${chalk.yellow('→')} ${hint}`)
    }
  }
}
