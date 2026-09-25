import chalk from 'chalk'
import type { Config, DisplayTheme } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'
import { selectTip } from './tips.js'
import { oneLine } from './vendor-error-summary.js'

// ── Phase state ───────────────────────────────────────────────────────────────

export type PRPhase =
  | 'queued'      // waiting for review to start
  | 'reviewing'   // review CLI running
  | 'reviewed'    // review done, comment posted
  | 'fixing'      // fix CLI running
  | 'fixed'       // fix done (or skipped)
  | 'rechecking'  // recheck CLI running
  | 'rechecked'   // recheck done (or skipped)

// ── Types ────────────────────────────────────────────────────────────────────

type ChalkFn = (s: string) => string

interface Theme {
  spinner: ChalkFn
  success: ChalkFn
  warning: ChalkFn
  error: ChalkFn
  dim: ChalkFn
  muted: ChalkFn  // fainter than dim: controls that do nothing in the current state
  accent: ChalkFn
  barPRFill: ChalkFn
  barEmpty: ChalkFn
  barCRApprove: ChalkFn
  barCRNeedsWork: ChalkFn
  barCRBlock: ChalkFn
  barFixFill: ChalkFn
  separator: ChalkFn
}

interface PRSlot {
  prNumber: number
  repo: string
  branch: string
  label: string
  startedAt: number
  completedAt?: number      // set by completePR — the slot stays in the session history
  url?: string              // PR URL, set on completion
  prLoc?: number
  phase?: PRPhase
  verdict?: string | null   // review step verdict (undefined = not yet reviewed)
  commentCount?: number
  fixCount?: number         // undefined = hasn't run, 0 = skipped, N = applied
  recheckVerdict?: string | null  // recheck step verdict
  crTokens?: number
  recheckTokens?: number
  fixTokens?: number
  round?: number            // 1 = first review, 2+ = subsequent recheck run
  crReviewer?: string       // vendor that ran the CR step (claude | codex)
  recheckReviewer?: string  // vendor that ran the recheck step
  qualityTier?: string      // quality tier used for this run
  stickyFolded?: boolean    // once folded on the count threshold, stays folded (see renderPRWorkspace)
  superseded?: boolean      // a later round replaced this slot: kept in history, hidden from the live page
  error?: string            // set by failPR — the slot settles in the workspace instead of being deleted
}

export interface PRUpdate {
  label?: string
  prLoc?: number
  phase?: PRPhase
  verdict?: string | null
  commentCount?: number
  fixCount?: number
  recheckVerdict?: string | null
  crTokens?: number
  recheckTokens?: number
  fixTokens?: number
  round?: number
  crReviewer?: string
  recheckReviewer?: string
  qualityTier?: string
}

export interface PRCompletionData {
  elapsedMs: number
  url: string
  /** Replaces the `done` label — for a PR that closed without a review having
   *  run, such as one the review strategy short-circuited. */
  label?: string
}

/**
 * The terminal state of one settled slot, for the session outcome distribution.
 * `skipped` is a PR that settled without any verdict at all — the review
 * strategy short-circuited it (lockfile-only, doc-only) — as distinct from
 * `no verdict`, where a reviewer ran and returned nothing parseable.
 */
export type Outcome = 'APPROVE' | 'NEEDS WORK' | 'BLOCK' | 'no verdict' | 'skipped' | 'error'

const OUTCOME_ORDER: readonly Outcome[] = ['APPROVE', 'NEEDS WORK', 'BLOCK', 'no verdict', 'skipped', 'error']

interface Stats {
  prsReceived: number
  crsCompleted: number
  fixesApplied: number
  errorsOccurred: number
  crTotalMs: number
  sessionStart: number
  /** Cumulative over the session: survives the HISTORY_MAX slot cap. */
  outcomes: Record<Outcome, number>
}

// ── Constants ─────────────────────────────────────────────────────────────────

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏']
const BAR_FILLED = '█'
const BAR_EMPTY = '░'

// ── Helpers ───────────────────────────────────────────────────────────────────

// Fixed-width timestamp: always "HH:MM:SS AM/PM" (zero-padded hour) so columns stay aligned
export function fmtTime(d = new Date()): string {
  return d.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: true })
}

// Width of a fmtTime() result — constant regardless of time of day ("01:00:00 AM".length = 11)
export const FMT_TIME_WIDTH = 11

// Format milliseconds as human duration: "45s", "4m05s", "1h02m"
function fmtDuration(ms: number): string {
  const totalSec = Math.floor(ms / 1000)
  const h = Math.floor(totalSec / 3600)
  const m = Math.floor((totalSec % 3600) / 60)
  const s = totalSec % 60
  if (h > 0) return `${h}h${String(m).padStart(2, '0')}m`
  if (m > 0) return `${m}m${String(s).padStart(2, '0')}s`
  return `${s}s`
}

// When a PR entered the board, in the operator's locale: "09/22, 03:50 PM" in
// en-US. Every part is 2-digit so the column keeps one width within a session.
export function fmtEnteredAt(epochMs: number): string {
  return new Date(epochMs).toLocaleString(undefined, {
    month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit',
  })
}

// Short HH:MM timestamp (no seconds) for the "started" label
function fmtStartTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Session age in hours and minutes: "3h32m", or "12m" under the hour. Deliberately
// not fmtDuration: that renders MM:SS shaped output under an hour, which reads as
// hours:minutes on a long-running watch and understates the session by 60x.
export function fmtUptime(ms: number): string {
  const totalMin = Math.max(0, Math.floor(ms / 60_000))
  const h = Math.floor(totalMin / 60)
  const m = totalMin % 60
  return h > 0 ? `${h}h${String(m).padStart(2, '0')}m` : `${m}m`
}

/**
 * Whole percentages summing to exactly 100, by the largest-remainder method.
 * Plain rounding drifts — three equal shares render as 33/33/33 — and a
 * distribution that visibly fails to add up reads as a bug in the numbers.
 *
 * A non-zero count too small to earn a point comes back as 0; the caller
 * renders those as "<1%" rather than claiming the outcome never happened.
 */
export function distribute(counts: readonly number[]): number[] {
  const total = counts.reduce((a, b) => a + b, 0)
  if (total === 0) return counts.map(() => 0)

  const exact = counts.map(c => (c * 100) / total)
  const out = exact.map(Math.floor)
  // Exact shares sum to 100, so the floors leave fewer whole points than there
  // are entries: one pass in remainder order always places every last one.
  let remaining = 100 - out.reduce((a, b) => a + b, 0)

  const byRemainder = exact
    .map((e, i) => ({ i, rem: e - Math.floor(e) }))
    .filter(({ i }) => counts[i] > 0)
    .sort((a, b) => b.rem - a.rem)

  for (const { i } of byRemainder) {
    if (remaining <= 0) break
    out[i]++
    remaining--
  }

  return out
}

// Format token count as a compact suffix: "(900)", "(1.2K)", "(1.5M)". Returns '' when undefined.
export function fmtTokens(n?: number): string {
  if (n == null) return ''
  if (n < 1_000) return `(${n})`
  if (n < 1_000_000) return `(${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K)`
  return `(${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M)`
}

// Raw token count without surrounding parens: "900", "1.2K", "1.5M". Returns '' when undefined.
export function fmtTokensRaw(n?: number): string {
  if (n == null) return ''
  if (n < 1_000) return `${n}`
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K`
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`
}

// Strip ANSI escape codes for visible-width calculations
function stripAnsi(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/\x1B\[[0-9;]*m/g, '')
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.slice(0, max - 1) + '…'
}

// Cut a rendered line to `max` visible columns, keeping the ANSI sequences it
// passes over (they have no width) and closing with a reset so a cut mid-colour
// cannot bleed into the next line. Folded rows are clamped with this so they
// always occupy exactly one terminal row — history pagination counts on it.
function truncateVisible(s: string, max: number): string {
  if (max <= 0) return ''
  if (stripAnsi(s).length <= max) return s
  let out = ''
  let width = 0
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]
    if (ch === '\x1B') {
      const end = s.indexOf('m', i)
      if (end === -1) break
      out += s.slice(i, end + 1)
      i = end
      continue
    }
    if (width >= max - 1) break
    out += ch
    width++
  }
  return out + '…\x1B[0m'
}

// Lines the runner hands to its log callback are prefixed ⚠ or ✗ when they
// report something an operator must act on. Everything else is progress
// narration that the board's own PR rows already carry, and a multi-line
// message is a dump (an unposted review, a dry-run comment) that always
// follows one of those notices. Only these earn a line of terminal scrollback
// beside the board; the rest goes to the file log.
// eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
const NOTICE_PREFIX = /^(?:\x1B\[[0-9;]*m)*\s*[⚠✗]/

export function isNoticeLine(msg: string): boolean {
  return NOTICE_PREFIX.test(msg) || msg.includes('\n')
}

// ── Page keys ─────────────────────────────────────────────────────────────────

export type PageKey = 'older' | 'newer' | null

// ← / → are the only page keys, on Windows, Linux and macOS alike: every
// terminal forwards a bare arrow, where modifier and punctuation combinations
// arrive inconsistently or not at all (macOS never forwards cmd). Each arrow has
// two encodings: normal cursor mode (`ESC [ D`) and application cursor mode
// (`ESC O D`), which Terminal.app emits while an alternate-screen app owns the tty.
// ← moves toward newer PRs (the live page), → toward older history.
const PAGE_NEWER_KEYS = new Set(['\u001b[D', '\u001bOD'])
const PAGE_OLDER_KEYS = new Set(['\u001b[C', '\u001bOC'])

/** Map a raw stdin key sequence to a page direction, or null when it is not a page key. */
export function pageKeyAction(seq: string): PageKey {
  if (PAGE_OLDER_KEYS.has(seq)) return 'older'
  if (PAGE_NEWER_KEYS.has(seq)) return 'newer'
  return null
}

// Keep every active slot plus the newest `budget` settled ones. Anything older
// cannot fit the live page (one row minimum per slot), so the fitting loop need
// never consider it.
function trimToBudget(pool: PRSlot[], budget: number): PRSlot[] {
  const settled = pool.filter(s => s.completedAt !== undefined)
  if (settled.length <= budget) return pool.slice()
  const keep = new Set(settled.slice(settled.length - budget))
  return pool.filter(s => s.completedAt === undefined || keep.has(s))
}

/**
 * The one outcome a settled slot counts toward. A recheck verdict supersedes
 * the review verdict — it is the later word on the same PR — and `null` from
 * either step means a reviewer ran but returned nothing parseable, which is a
 * different event from never having run at all.
 */
function outcomeOf(slot: PRSlot): Outcome {
  if (slot.error !== undefined) return 'error'
  const final = typeof slot.recheckVerdict === 'string'
    ? slot.recheckVerdict
    : typeof slot.verdict === 'string' ? slot.verdict : null
  if (final === 'APPROVE' || final === 'NEEDS WORK' || final === 'BLOCK') return final
  if (slot.recheckVerdict === null || slot.verdict === null) return 'no verdict'
  return 'skipped'
}

function makeBar(filled: number, total: number, fillFn: ChalkFn, emptyFn: ChalkFn): string {
  const f = Math.max(0, Math.min(total, Math.round(filled)))
  return fillFn(BAR_FILLED.repeat(f)) + emptyFn(BAR_EMPTY.repeat(total - f))
}

// Format "codex · thorough" tag; returns '' when neither field is set.
function fmtReviewerTag(reviewer?: string, tier?: string): string {
  if (!reviewer && !tier) return ''
  if (reviewer && tier) return `${reviewer} · ${tier}`
  return reviewer ?? tier ?? ''
}

function locToFilled(loc: number): number {
  if (loc <= 0) return 0
  if (loc <= 10) return 1
  if (loc <= 50) return 2
  if (loc <= 150) return 3
  if (loc <= 300) return 5
  if (loc <= 600) return 6
  if (loc <= 1000) return 7
  if (loc <= 2000) return 8
  if (loc <= 4000) return 9
  return 10
}

function commentCountToFilled(n: number): number {
  if (n === 0) return 0
  if (n <= 2) return 2
  if (n <= 5) return 3
  if (n <= 9) return 4
  if (n <= 14) return 5
  if (n <= 20) return 6
  if (n <= 30) return 7
  return 8
}

function fixCountToFilled(n: number): number {
  if (n === 0) return 0
  if (n === 1) return 1
  if (n <= 3) return 2
  if (n <= 6) return 3
  if (n <= 10) return 4
  if (n <= 20) return 5
  return 6
}

function resolveColor(spec: string): ChalkFn {
  if (spec === 'dim') return chalk.dim
  if (spec === 'bold') return chalk.bold
  if (spec.startsWith('#')) return chalk.hex(spec)
  const method = (chalk as unknown as Record<string, unknown>)[spec]
  if (typeof method === 'function') return method as ChalkFn
  return chalk.white
}

function buildTheme(cfg: DisplayTheme): Theme {
  const empty = resolveColor(cfg.bar_empty)
  return {
    spinner: chalk.greenBright,
    success: chalk.green,
    warning: chalk.yellow,
    error: chalk.red,
    dim: chalk.dim,
    muted: chalk.gray.dim,
    accent: chalk.cyan,
    barPRFill: resolveColor(cfg.bar_fill),
    barEmpty: empty,
    barCRApprove: resolveColor(cfg.cr_approve),
    barCRNeedsWork: resolveColor(cfg.cr_needs_work),
    barCRBlock: resolveColor(cfg.cr_block),
    barFixFill: resolveColor(cfg.fix_fill),
    separator: chalk.dim,
  }
}

// ── PRBoard ───────────────────────────────────────────────────────────────────

const CONN_LOG_MAX = 6  // max connectivity log lines kept in memory
const COMPACT_CONN_LOG_LINES = 2  // conn log lines shown when the live block must shrink to fit the viewport
const FOLD_THRESHOLD = 3  // when completed count exceeds this, fold all completed PRs to 1 line
const HISTORY_MAX = 2000  // hard cap on retained slots — oldest settled rows drop out beyond it

interface LayoutOpts {
  foldAll: boolean        // fold every completed slot regardless of FOLD_THRESHOLD
  connLogLines: number    // how many connectivity log lines to show
  showTip: boolean
}

const LAYOUT_NORMAL: LayoutOpts = { foldAll: false, connLogLines: CONN_LOG_MAX, showTip: true }
const LAYOUT_COMPACT: LayoutOpts = { foldAll: true, connLogLines: COMPACT_CONN_LOG_LINES, showTip: false }

export class PRBoard {
  private slots = new Map<string, PRSlot>()
  private frameIdx = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private liveLines = 0
  private liveContent = ''
  private readonly isTTY: boolean = Boolean(process.stdout.isTTY)
  private connLog: string[] = []
  private page = 0        // 0 = live page (newest); higher = further back in history
  private pageCount = 1   // recomputed every render; page keys clamp against it
  private keyHandler: ((data: Buffer) => void) | null = null
  private stdinWasRaw = false

  private stats: Stats = {
    prsReceived: 0,
    crsCompleted: 0,
    fixesApplied: 0,
    errorsOccurred: 0,
    crTotalMs: 0,
    sessionStart: Date.now(),
    outcomes: { 'APPROVE': 0, 'NEEDS WORK': 0, 'BLOCK': 0, 'no verdict': 0, 'skipped': 0, 'error': 0 },
  }

  private tunnel: { type: string; url: string | null; alive: boolean } = {
    type: 'none', url: null, alive: false,
  }

  private config: Config | null = null
  private steps: WorkflowStep[] = []
  private theme: Theme = buildTheme({
    bar_fill: 'blue', bar_empty: 'dim',
    cr_approve: 'green', cr_needs_work: 'yellow', cr_block: 'red',
    fix_fill: 'cyan',
  })

  // ── Public API ─────────────────────────────────────────────────────────────

  setConfig(config: Config, steps: WorkflowStep[]): void {
    this.config = config
    this.steps = steps
    this.theme = buildTheme(config.display.theme)
  }

  setTunnel(type: string, url: string | null, alive: boolean): void {
    this.tunnel = { type, url, alive }
  }

  start(): void {
    if (!this.isTTY) return
    this.attachKeys()
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length
      this.redraw()
    }, 80)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.detachKeys()
    this.eraseLive()
  }

  /** Flip one page toward older history. No-op when already at the oldest page. */
  pageOlder(): void {
    const next = Math.min(this.page + 1, Math.max(0, this.pageCount - 1))
    if (next === this.page) return
    this.page = next
    this.redraw()
  }

  /** Flip one page toward the live page. No-op when already on it. */
  pageNewer(): void {
    if (this.page === 0) return
    this.page--
    this.redraw()
  }

  addPR(key: string, prNumber: number, repo: string, branch: string, round?: number): void {
    // When a new round starts for a PR that already has a completed slot in the
    // workspace, mark the prior-round slot superseded so only the current round
    // shows on the live page. It stays in the map: history pages still carry it.
    // Prior-round slots always have a different key (different SHA suffix) but
    // the same prNumber + repo combination.
    if ((round ?? 1) >= 2) {
      for (const [existingKey, slot] of this.slots) {
        if (existingKey !== key && slot.prNumber === prNumber && slot.repo === repo && slot.completedAt !== undefined) {
          slot.superseded = true
        }
      }
    }
    this.slots.set(key, { prNumber, repo, branch, label: 'cloning...', startedAt: Date.now(), phase: 'queued', round: round ?? 1 })
    this.stats.prsReceived++
  }

  updatePR(key: string, updates: PRUpdate): void {
    const slot = this.slots.get(key)
    if (!slot) return
    if (updates.label !== undefined) slot.label = updates.label
    if (updates.prLoc !== undefined) slot.prLoc = updates.prLoc
    if (updates.phase !== undefined) slot.phase = updates.phase
    if (updates.verdict !== undefined) slot.verdict = updates.verdict
    if (updates.commentCount !== undefined) slot.commentCount = updates.commentCount
    if (updates.fixCount !== undefined) slot.fixCount = updates.fixCount
    if (updates.recheckVerdict !== undefined) slot.recheckVerdict = updates.recheckVerdict
    if (updates.crTokens !== undefined) slot.crTokens = updates.crTokens
    if (updates.recheckTokens !== undefined) slot.recheckTokens = updates.recheckTokens
    if (updates.fixTokens !== undefined) slot.fixTokens = updates.fixTokens
    if (updates.round !== undefined) slot.round = updates.round
    if (updates.crReviewer !== undefined) slot.crReviewer = updates.crReviewer
    if (updates.recheckReviewer !== undefined) slot.recheckReviewer = updates.recheckReviewer
    if (updates.qualityTier !== undefined) slot.qualityTier = updates.qualityTier
  }

  completePR(key: string, data: PRCompletionData): void {
    const slot = this.slots.get(key)
    if (!slot) return

    slot.completedAt = Date.now()
    slot.url = data.url
    slot.label = data.label ?? 'done'

    const verdict = slot.verdict ?? null
    const fixCount = slot.fixCount

    if (verdict !== null || slot.phase === 'reviewed' || slot.phase === 'rechecked' || slot.phase === 'fixed') {
      this.stats.crsCompleted++
      this.stats.crTotalMs += data.elapsedMs
    }
    if (fixCount !== undefined && fixCount > 0) this.stats.fixesApplied++
    this.stats.outcomes[outcomeOf(slot)]++

    // Non-TTY has no live block to re-render — emit the folded line to scrollback and drop the slot.
    if (!this.isTTY) {
      process.stdout.write(this.renderPRSlotFolded(slot) + '\n')
      this.slots.delete(key)
    }
  }

  /**
   * Settle a slot that ended in an error. The slot stays in the workspace as a
   * settled row, the same as a completed one: a failed run is a session record,
   * and deleting it here was what pushed reviewer timeouts out of the table and
   * into raw scrollback, where a long watch session showed 43 errors above an
   * empty workspace reading "no PRs yet".
   */
  failPR(key: string, error: string): void {
    const slot = this.slots.get(key)
    this.stats.errorsOccurred++
    if (!slot || slot.completedAt !== undefined) return

    slot.completedAt = Date.now()
    // A failure message is whatever the thrower had — a subprocess dump can
    // arrive with embedded newlines and hundreds of columns. The folded row is
    // clamped to one terminal row and history pagination counts on that, so the
    // text is flattened here rather than at render time. The untouched error is
    // in the file log.
    slot.error = oneLine(error, 160)
    slot.label = 'failed'
    this.stats.outcomes.error++

    if (!this.isTTY) {
      process.stdout.write(this.renderPRSlotFolded(slot) + '\n')
      this.slots.delete(key)
    }
  }

  /** Print 1–2 static lines to scrollback (above the live block). */
  log(line1: string, line2?: string): void {
    // Prepend a blank line for 2-line events so consecutive entries don't blur together
    this.printStatic(line2 ? `\n${line1}\n${line2}` : line1)
  }

  /** Record a connectivity event in the live section (tunnel/webhook events). */
  logConnectivity(line: string): void {
    const ts = chalk.dim(fmtTime())
    this.connLog.push(`  ${ts}  ${line}`)
    if (this.connLog.length > CONN_LOG_MAX) this.connLog.shift()
  }

  // ── Private: display ───────────────────────────────────────────────────────

  private printStatic(content: string): void {
    this.eraseLive()
    process.stdout.write(content + '\n')
  }

  private countRenderedLines(content: string, columns: number): number {
    const w = columns || 80
    return content.split('\n').reduce((sum, line) => {
      return sum + Math.max(1, Math.ceil(stripAnsi(line).length / w))
    }, 0)
  }

  private eraseLive(): void {
    if (this.liveLines > 0 && this.isTTY) {
      // Recompute against current width in case terminal was resized since last write
      const lines = this.countRenderedLines(this.liveContent, process.stdout.columns || 80)
      process.stdout.write(`\x1B[${lines}A\x1B[0J`)
      this.liveLines = 0
      this.liveContent = ''
    }
  }

  private writeLive(content: string): void {
    this.eraseLive()
    process.stdout.write(content + '\n')
    const w = process.stdout.columns || 80
    this.liveContent = content
    this.liveLines = this.countRenderedLines(content, w)
  }

  // ── Private: theme helpers ─────────────────────────────────────────────────

  private verdictBadge(v: string | null): string {
    const t = this.theme
    if (v === 'APPROVE') return t.success('✅ APPROVE')
    if (v === 'NEEDS WORK') return t.warning('⚠  NEEDS WORK')
    if (v === 'BLOCK') return t.error('🚫 BLOCK')
    return t.dim('—')
  }

  private crFillFn(verdict: string | null): ChalkFn {
    const t = this.theme
    if (verdict === 'APPROVE') return t.barCRApprove
    if (verdict === 'BLOCK') return t.barCRBlock
    return t.barCRNeedsWork
  }

  private crLabelFn(verdict: string | null): ChalkFn {
    const t = this.theme
    if (verdict === 'APPROVE') return t.barCRApprove
    if (verdict === 'BLOCK') return t.barCRBlock
    return t.barCRNeedsWork
  }

  // ── Private: render ────────────────────────────────────────────────────────

  /** "since 08:25 PM · up 3h32m" — when watch started, and how long it has run. */
  private sessionRow(): string {
    const t = this.theme
    const started = fmtStartTime(this.stats.sessionStart)
    const age = fmtUptime(Date.now() - this.stats.sessionStart)
    return `${t.dim('since')} ${started}  ${t.dim('·')}  ${t.dim('up')} ${age}`
  }

  /**
   * Outcome shares across every PR that settled this session, e.g.
   * "APPROVE 45% · BLOCK 30% · error 25%". Empty when nothing has settled yet.
   */
  private outcomeRow(): string {
    const t = this.theme
    const counts = OUTCOME_ORDER.map(o => this.stats.outcomes[o])
    const total = counts.reduce((a, b) => a + b, 0)
    if (total === 0) return ''

    const pcts = distribute(counts)
    const mixed = counts.filter(c => c > 0).length > 1
    const parts = OUTCOME_ORDER.map((outcome, i) => {
      if (counts[i] === 0) return null
      // A share too small to earn a whole point still happened; "<1%" says so
      // where "0%" would read as never. Its complement is then not a whole 100
      // either — "error 100%" beside "APPROVE <1%" contradicts itself — so the
      // rounded-up bucket reads ">99%" whenever some other outcome is non-zero.
      const pct = pcts[i] === 0 ? '<1%'
        : pcts[i] === 100 && mixed ? '>99%'
        : `${pcts[i]}%`
      const paint = outcome === 'APPROVE' ? t.barCRApprove
        : outcome === 'BLOCK' ? t.barCRBlock
        : outcome === 'NEEDS WORK' ? t.barCRNeedsWork
        : outcome === 'error' ? t.error
        : t.dim
      return `${paint(outcome)} ${t.dim(pct)}`
    }).filter((p): p is string => p !== null)

    return parts.join(t.dim(' · '))
  }

  private statsRow(): string {
    const { prsReceived, crsCompleted, fixesApplied, errorsOccurred, crTotalMs } = this.stats
    const avgCr = crsCompleted > 0
      ? `  │  avg CR: ${fmtDuration(Math.round(crTotalMs / crsCompleted))}`
      : ''
    const errorPart = errorsOccurred > 0
      ? ` · ${chalk.red(`errors: ${errorsOccurred}`)}`
      : ''
    return `PRs: ${prsReceived} · CRs: ${crsCompleted}${errorPart} · fixes: ${fixesApplied}${avgCr}`
  }

  private renderPRSlot(slot: PRSlot, frame: string, numWidth = 0): string {
    const t = this.theme
    const w = process.stdout.columns || 80
    const isCompleted = slot.completedAt !== undefined
    const totalElapsedMs = isCompleted
      ? slot.completedAt! - slot.startedAt
      : Date.now() - slot.startedAt
    const eSuffix = fmtDuration(totalElapsedMs)

    // ── Line 1: identity  <pad>  started·elapsed  phase-label ────────────────
    const branch = truncate(slot.branch, 22)
    const icon = isCompleted ? t.success('✓') : t.spinner(frame)
    const phaseLabel = this.phaseLine1Label(slot, frame)
    // The entered-at column after the PR number already says when it started.
    const rightPart = `${t.dim(eSuffix)}  ${phaseLabel}`
    const numText = `#${slot.prNumber}`.padEnd(numWidth)
    const entered = fmtEnteredAt(slot.startedAt)
    const identityPlain = `   ${numText}  ${entered}  ${slot.repo}  ${branch}`
    const l1Pad = Math.max(2, w - stripAnsi(identityPlain).length - stripAnsi(rightPart).length - 2)
    const prNum = isCompleted ? t.dim(numText) : chalk.bold(numText)
    const repoStr = isCompleted ? t.dim(slot.repo) : chalk.white(slot.repo)
    const l1 = `  ${icon} ${prNum}  ${t.dim(entered)}  ${repoStr}  ${t.dim(branch)}` +
      ' '.repeat(l1Pad) + rightPart

    // ── Line 2: PR | CR | Fix | Recheck pipeline ────────────────────────────────
    const pipe = t.dim(' | ')

    const prSection = slot.prLoc !== undefined
      ? `PR ${makeBar(locToFilled(slot.prLoc), 10, t.barPRFill, t.barEmpty)} ${t.dim(String(slot.prLoc) + 'loc')}`
      : `PR ${makeBar(0, 10, t.barPRFill, t.barEmpty)} ${t.dim('—')}`

    const crSection = this.renderCRSection(slot, frame)

    // URL line — only shown for completed slots that have a URL. Without this,
    // expanded completions (≤ FOLD_THRESHOLD) never surface the PR link in the
    // live block; the URL is otherwise only rendered in the folded form.
    const urlLine = isCompleted && slot.url
      ? `\n    ${t.dim('→')} ${t.accent(slot.url)}`
      : ''

    // Round 2+: skip Fix, collapse into compact recheck display
    const round = slot.round ?? 1
    if (round >= 2) {
      const recheckSection = this.renderRecheckSection(slot, frame)
      const parts = [prSection, crSection]
      if (recheckSection !== null) parts.push(recheckSection)
      return `${l1}\n${parts.join(pipe)}${urlLine}`
    }

    const fixSection = this.renderFixSection(slot, frame)
    const recheckSection = this.renderRecheckSection(slot, frame)

    const parts = [prSection, crSection, fixSection]
    if (recheckSection !== null) parts.push(recheckSection)

    return `${l1}\n${parts.join(pipe)}${urlLine}`
  }

  private phaseLine1Label(slot: PRSlot, frame: string): string {
    const t = this.theme
    // completePR always sets the label; it is 'done' unless the PR closed
    // without a review running, in which case it says why.
    if (slot.completedAt !== undefined) return t.dim(slot.label)
    switch (slot.phase) {
      case 'reviewing':
      case 'rechecking':
      case 'fixing':
        return `${t.spinner(frame)} ${t.dim(slot.label)}`
      default:
        return t.dim(slot.label)
    }
  }

  private renderCRSection(slot: PRSlot, frame: string): string {
    const t = this.theme
    if (slot.phase === 'reviewing') {
      return `CR ${makeBar(0, 8, t.barPRFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('reviewing…')}`
    }
    // Round 2+: CR ran in a prior round — show as static completed, not as queued/error
    if ((slot.round ?? 1) >= 2 && slot.verdict === undefined) {
      return `CR ${makeBar(8, 8, t.dim, t.dim)} ${t.dim('·')}`
    }
    if (slot.verdict === undefined) {
      return `CR ${makeBar(0, 8, t.barPRFill, t.barEmpty)} ${t.dim('queued')}`
    }
    if (slot.verdict === null) {
      return `CR ${makeBar(0, 8, t.barEmpty, t.barEmpty)} ${t.warning('⚠ no verdict')}`
    }
    const crFill = this.crFillFn(slot.verdict)
    const crLabel = this.crLabelFn(slot.verdict)
    const count = slot.commentCount ?? 0
    const tokRaw = fmtTokensRaw(slot.crTokens)
    const label = tokRaw
      ? `${count} issues (${slot.verdict}, ${tokRaw})`
      : `${count} issues (${slot.verdict})`
    const reviewerTag = fmtReviewerTag(slot.crReviewer, slot.qualityTier)
    return `CR ${makeBar(commentCountToFilled(count), 8, crFill, t.barEmpty)} ${crLabel(label)}${reviewerTag ? ' ' + t.dim(reviewerTag) : ''}`
  }

  private renderFixSection(slot: PRSlot, frame: string): string {
    const t = this.theme
    const hasFixStep = this.steps.some(s => s.type === 'fix' || s.type === 'conflict-resolve')
    if (!hasFixStep) return `Fix ${t.dim('—')}`
    if (slot.phase === 'fixing') {
      return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('applying…')}`
    }
    if (slot.fixCount !== undefined) {
      if (slot.fixCount === 0) return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.dim('— skipped')}`
      const tokRaw = fmtTokensRaw(slot.fixTokens)
      return `Fix ${makeBar(fixCountToFilled(slot.fixCount), 6, t.barFixFill, t.barEmpty)} ${t.success('✓')} ${t.accent(String(slot.fixCount) + ' applied')}${tokRaw ? ' ' + t.dim(`(${tokRaw})`) : ''}`
    }
    return `Fix ${makeBar(0, 6, t.barFixFill, t.barEmpty)} ${t.dim('queued')}`
  }

  private renderRecheckSection(slot: PRSlot, frame: string): string | null {
    const t = this.theme
    const round = slot.round ?? 1

    // Round 2+: compact "N ROUNDS" display regardless of workflow steps
    if (round >= 2) {
      const roundsLabel = `${round} ROUNDS`
      if (slot.phase === 'rechecking' || slot.phase === 'reviewing') {
        return `${roundsLabel} ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim(`round ${round}…`)}`
      }
      if (slot.recheckVerdict !== undefined && slot.recheckVerdict !== null) {
        const fill = this.crFillFn(slot.recheckVerdict)
        const label = this.crLabelFn(slot.recheckVerdict)
        const tokRaw = fmtTokensRaw(slot.recheckTokens)
        const roundLabel = tokRaw ? `${slot.recheckVerdict}, ${tokRaw}` : slot.recheckVerdict
        // Fill bar fully on APPROVE (clean pass), partially on NEEDS WORK, empty on BLOCK.
        const barFilled = slot.recheckVerdict === 'APPROVE' ? 5 : slot.recheckVerdict === 'NEEDS WORK' ? 3 : 0
        return `${roundsLabel} ${makeBar(barFilled, 5, fill, t.barEmpty)} ${label(roundLabel)}`
      }
      return `${roundsLabel} ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.dim('queued')}`
    }

    const hasRecheckStep = this.steps.some(s => s.type === 'recheck')
    if (!hasRecheckStep) return null
    if (slot.phase === 'rechecking') {
      return `Recheck ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.spinner(frame)} ${t.dim('reviewing…')}`
    }
    if (slot.phase === 'rechecked') {
      if (slot.recheckVerdict === undefined) {
        return `Recheck ${makeBar(0, 5, t.barFixFill, t.barEmpty)} ${t.dim('— skipped')}`
      }
      if (slot.recheckVerdict === null) {
        return `Recheck ${makeBar(0, 5, t.barEmpty, t.barEmpty)} ${t.warning('⚠ no verdict')}`
      }
      const fill = this.crFillFn(slot.recheckVerdict)
      const label = this.crLabelFn(slot.recheckVerdict)
      const tokRaw = fmtTokensRaw(slot.recheckTokens)
      const recheckLabel = tokRaw ? `${slot.recheckVerdict}, ${tokRaw}` : slot.recheckVerdict
      const reviewerTag = fmtReviewerTag(slot.recheckReviewer, slot.qualityTier)
      return `Recheck ${makeBar(0, 5, fill, t.barEmpty)} ${label(recheckLabel)}${reviewerTag ? ' ' + t.dim(reviewerTag) : ''}`
    }
    return `Recheck ${makeBar(0, 5, t.barPRFill, t.barEmpty)} ${t.dim('queued')}`
  }

  private render(): string {
    if (!this.config) return ''

    this.trimHistory()

    const w = process.stdout.columns || 80
    // The live block must never be taller than the viewport: lines that scroll
    // out the top cannot be erased on the next frame (cursor-up clamps at the
    // viewport top), leaving permanent duplicates in scrollback. Reserve one
    // row for the trailing newline writeLive appends.
    const budget = (process.stdout.rows || 24) - 1
    const entries = [...this.slots.values()]

    // The live page carries every active slot plus the newest settled ones that
    // fit. What it cannot show is not dropped — it moves into the history pages.
    const live = this.fitLivePage(entries.filter(s => s.superseded !== true), w, budget)
    const onLivePage = new Set(live.visible)
    const history = entries.filter(s => !onLivePage.has(s))  // oldest → newest

    // History rows are always folded, and a folded row is clamped to one
    // terminal row, so a history page holds exactly the rows the panels leave.
    const perPage = Math.max(1, budget - this.chromeRows(w, LAYOUT_COMPACT))
    this.pageCount = 1 + Math.ceil(history.length / perPage)
    this.page = Math.max(0, Math.min(this.page, this.pageCount - 1))

    if (this.page === 0) return this.fitToBudget(this.renderLayout(w, live.opts, live.visible, entries.length), w, budget)

    // Page 1 is the newest history page, so it ends where the live page begins.
    const end = history.length - (this.page - 1) * perPage
    const slice = history.slice(Math.max(0, end - perPage), end)
    return this.fitToBudget(this.renderLayout(w, LAYOUT_COMPACT, slice, entries.length), w, budget)
  }

  /**
   * Pick the slots the live page shows: the expanded layout when it fits, then
   * the compact one, then compact with the oldest settled slots handed over to
   * history until the block fits the viewport. Active slots are never handed
   * over — a running review must stay on screen.
   */
  private fitLivePage(pool: PRSlot[], w: number, budget: number): { visible: PRSlot[]; opts: LayoutOpts } {
    // Bound the work: a slot costs at least one row, so a settled slot older
    // than the last `budget` of them can never fit on the live page anyway.
    const visible = trimToBudget(pool, budget)

    const fits = (opts: LayoutOpts): boolean =>
      this.countRenderedLines(this.renderLayout(w, opts, visible, pool.length), w) <= budget

    if (fits(LAYOUT_NORMAL)) return { visible, opts: LAYOUT_NORMAL }

    while (!fits(LAYOUT_COMPACT)) {
      const oldestSettled = visible.findIndex(s => s.completedAt !== undefined)
      if (oldestSettled === -1) break  // only active slots left — truncateTop takes it from here
      visible.splice(oldestSettled, 1)
    }
    return { visible, opts: LAYOUT_COMPACT }
  }

  /** Rows the panels and footer cost, i.e. everything but the PR rows. */
  private chromeRows(w: number, opts: LayoutOpts): number {
    return this.countRenderedLines(this.renderLayout(w, opts, [], this.slots.size), w)
  }

  private fitToBudget(content: string, w: number, budget: number): string {
    return this.countRenderedLines(content, w) <= budget
      ? content
      : this.truncateTop(content, w, budget)
  }

  private renderLayout(w: number, opts: LayoutOpts, visible: PRSlot[], total: number): string {
    const t = this.theme
    // Use w-1 to prevent the exact-terminal-width cursor wrap ambiguity that
    // causes the first char of the next line to appear at the end of the separator.
    const sep = t.separator('─'.repeat(w - 1))

    return [
      ...this.renderConfigPanel(),
      sep,
      ...this.renderStatsPanel(opts.connLogLines, opts.showTip),
      sep,
      ...this.renderPRWorkspace(visible, opts.foldAll, w),
      sep,
      // Clamped: the footer is counted as exactly one row when sizing a page.
      truncateVisible(this.renderFooter(visible.length, total), w - 1),
    ].join('\n')
  }

  /** Drop the oldest settled slots once the session history outgrows the cap. */
  private trimHistory(): void {
    if (this.slots.size <= HISTORY_MAX) return
    let excess = this.slots.size - HISTORY_MAX
    for (const [key, slot] of this.slots) {
      if (excess <= 0) break
      if (slot.completedAt === undefined) continue  // never drop an active slot
      this.slots.delete(key)
      excess--
    }
  }

  /** Drop rows from the top until the content (plus an indicator line) fits the budget. */
  private truncateTop(content: string, w: number, budget: number): string {
    const lines = content.split('\n')
    const rowsPer = lines.map(l => Math.max(1, Math.ceil(stripAnsi(l).length / w)))
    let total = rowsPer.reduce((a, b) => a + b, 0)
    let start = 0
    while (start < lines.length - 1 && total > budget - 1) {
      total -= rowsPer[start]
      start++
    }
    return [this.theme.dim('  …'), ...lines.slice(start)].join('\n')
  }

  // ── Panels ─────────────────────────────────────────────────────────────────

  private renderConfigPanel(): string[] {
    const t = this.theme
    const cfg = this.config!
    const lines: string[] = []

    lines.push(`  ${chalk.greenBright('●')} ${chalk.bold('crosscheck')}  ${t.dim(`${cfg.mode} · ${cfg.quality.tier}`)}`)

    const stepFlow = this.steps.map(s => s.name).join(t.dim(' → '))
    lines.push(`  ${t.dim('workflow:')} ${stepFlow}`)

    const vendors: string[] = []
    if (cfg.vendors.claude.enabled) vendors.push('claude')
    if (cfg.vendors.codex.enabled) vendors.push('codex')
    lines.push(`  ${t.dim('vendors: ')} ${vendors.join(t.dim(' · '))}`)

    return lines
  }

  private renderStatsPanel(connLogLines: number, showTip: boolean): string[] {
    const t = this.theme
    const lines: string[] = []

    lines.push(`  ${this.statsRow()}`)

    // Session line: start time + age, and the outcome split when anything has
    // settled. One row, because every row here costs a PR row on the live page.
    const outcomes = this.outcomeRow()
    lines.push(`  ${this.sessionRow()}${outcomes ? `  ${t.dim('│')}  ${outcomes}` : ''}`)

    const { type: tunnelType, url, alive } = this.tunnel
    if (tunnelType !== 'none') {
      const tunnelLabel = tunnelType === 'serve' ? 'endpoint:' : 'tunnel:  '
      const tunnelDisplay = url
        ? `${url.replace(/^https?:\/\//, '')} ${alive ? t.success('✓') : t.warning('⚠')}`
        : t.dim('connecting...')
      lines.push(`  ${t.dim(tunnelLabel)} ${tunnelDisplay}`)
    }

    // Connectivity log: already prefixed with timestamps + indent in logConnectivity()
    const activeConn = this.connLog.filter(l => l.trim()).slice(-connLogLines)
    lines.push(...activeConn)

    if (showTip) lines.push(this.renderTipLine())

    return lines
  }

  private renderTipLine(): string {
    const t = this.theme
    const tip = selectTip(this.stats.sessionStart)

    const badge = tip.badge === 'fire'
      ? chalk.bold.yellow('🔥 NEW') + chalk.dim('  ')
      : tip.badge === 'new'
        ? chalk.bold.cyanBright('new') + chalk.dim('  ')
        : chalk.dim('tip  ')

    // Backtick-enclosed spans in accent colour; surrounding prose in dim
    const parts = tip.text.split(/(`[^`]+`)/)
    const formatted = parts.map(p => p.startsWith('`') ? t.accent(p) : t.dim(p)).join('')

    return `  ${badge}${formatted}`
  }

  private renderPRWorkspace(visible: PRSlot[], foldAll: boolean, w: number): string[] {
    const t = this.theme
    const frame = FRAMES[this.frameIdx]

    if (visible.length === 0) {
      return this.slots.size === 0 ? [t.dim('  waiting for PRs...')] : []
    }

    let completedCount = 0
    for (const slot of visible) {
      if (slot.completedAt !== undefined) completedCount++
    }
    const foldByCount = completedCount > FOLD_THRESHOLD

    // Pad the PR number to the page's widest so the entered-at column lines up.
    const numWidth = Math.max(...visible.map(s => `#${s.prNumber}`.length))

    const lines: string[] = []
    let prevWasExpanded = false
    let first = true

    for (const slot of visible) {
      const isCompleted = slot.completedAt !== undefined
      // Sticky fold: once a completed slot folds because the count crossed
      // FOLD_THRESHOLD, keep it folded. Otherwise a later recheck round drops
      // completedCount back under the threshold and reflows the whole history
      // (a settled PR jumping from one line back to the full pipeline). The
      // height-driven foldAll is deliberately NOT sticky — a taller terminal
      // should re-expand.
      if (isCompleted && foldByCount) slot.stickyFolded = true
      // A failed slot is always folded: its pipeline bars are frozen wherever the
      // run died ("CR queued", "Fix queued"), which describes work that will
      // never happen. The folded row carries the error instead.
      const useFolded = isCompleted && (foldAll || slot.stickyFolded === true || slot.error !== undefined)

      if (useFolded) {
        // Clamped so the row never wraps: history pagination sizes a page by
        // counting one terminal row per folded slot.
        lines.push(truncateVisible(this.renderPRSlotFolded(slot, numWidth), w - 1))
        prevWasExpanded = false
      } else {
        if (!first && prevWasExpanded) lines.push('')
        lines.push(this.renderPRSlot(slot, frame, numWidth))
        prevWasExpanded = true
      }
      first = false
    }

    return lines
  }

  /** Footer: where in the retained history this page sits, and how to move. */
  private renderFooter(shown: number, total: number): string {
    const t = this.theme
    if (total === 0) return t.dim('  no PRs yet')

    const position = this.page === 0
      ? `${t.success('live')}${this.pageCount > 1 ? t.dim(` · page 1/${this.pageCount}`) : ''}`
      : t.dim(`history · page ${this.page + 1}/${this.pageCount}`)
    // "shown of retained", not of stats.prsReceived: rounds add rows, and the
    // history cap eventually drops the oldest, so the two counts diverge.
    const counts = t.dim(`showing ${shown} of ${total}`)
    // A key with nowhere to go fades to the muted colour: ← on the live page,
    // → on the oldest history page.
    const key = (arrow: string, label: string, live: boolean): string =>
      live ? `${t.accent(arrow)} ${t.dim(label)}` : t.muted(`${arrow} ${label}`)
    const keys = this.pageCount > 1
      ? `  ${t.dim('│')}  ${key('←', 'newer', this.page > 0)}  ${key('→', 'older', this.page < this.pageCount - 1)}`
      : ''

    return `  ${position}  ${t.dim('│')}  ${counts}${keys}`
  }

  // ── Folded PR slot ─────────────────────────────────────────────────────────

  private renderPRSlotFolded(slot: PRSlot, numWidth = 0): string {
    const t = this.theme
    const elapsedMs = (slot.completedAt ?? Date.now()) - slot.startedAt
    const elapsed = fmtDuration(elapsedMs)
    const branch = truncate(slot.branch, 22)

    const parts: string[] = []

    // CR verdict
    if (slot.verdict !== undefined && slot.verdict !== null) {
      const crFn = this.crLabelFn(slot.verdict)
      parts.push(`CR: ${crFn(slot.verdict)}`)
    } else if (slot.verdict === null) {
      parts.push(t.warning('CR: ⚠'))
    } else if ((slot.round ?? 1) >= 2) {
      parts.push(t.dim('CR: prior-round'))
    }

    // Fix count (when fixes were applied)
    if (slot.fixCount !== undefined && slot.fixCount > 0) {
      parts.push(t.accent(`fix ${slot.fixCount}`))
    }

    // Recheck verdict
    if (slot.recheckVerdict !== undefined && slot.recheckVerdict !== null) {
      const rFn = this.crLabelFn(slot.recheckVerdict)
      parts.push(`recheck ${rFn(slot.recheckVerdict)}`)
    }

    // A failed run reports the error in place of the verdict trail: whatever the
    // pipeline had reached is what it never got to finish, and the reason it
    // stopped is the only thing worth the row.
    if (slot.error !== undefined) {
      parts.push(t.error(slot.error))
    }

    const urlPart = slot.url ? `  ${t.dim('→')} ${t.accent(slot.url)}` : ''
    const partsStr = parts.length > 0 ? parts.join(t.dim(' · ')) : t.dim('—')
    const icon = slot.error !== undefined ? t.error('✗') : t.success('✓')

    const numText = `#${slot.prNumber}`.padEnd(numWidth)
    return `  ${icon} ${t.dim(numText)}  ${t.dim(fmtEnteredAt(slot.startedAt))}  ${t.dim(slot.repo)}  ${t.dim(branch)}  ${partsStr}  ${t.dim(`(${elapsed})`)}${urlPart}`
  }

  private redraw(): void {
    const content = this.render()
    if (content) this.writeLive(content)
  }

  // ── Private: key input ─────────────────────────────────────────────────────

  private attachKeys(): void {
    const stdin = process.stdin
    if (this.keyHandler || !stdin.isTTY) return

    this.stdinWasRaw = stdin.isRaw === true
    stdin.setRawMode(true)
    stdin.resume()

    const handler = (data: Buffer): void => {
      const seq = data.toString('utf8')
      // Raw mode suppresses the terminal's own ctrl-c → SIGINT translation, so
      // the board has to raise it itself or the daemon becomes unkillable.
      if (seq === '\u0003') { process.kill(process.pid, 'SIGINT'); return }
      const action = pageKeyAction(seq)
      if (action === 'older') this.pageOlder()
      else if (action === 'newer') this.pageNewer()
    }

    stdin.on('data', handler)
    this.keyHandler = handler
  }

  private detachKeys(): void {
    if (!this.keyHandler) return
    process.stdin.off('data', this.keyHandler)
    this.keyHandler = null
    // Hand the terminal back the way it was found: the idle-issue flow and the
    // interactive prompts read stdin themselves while the board is stopped.
    if (process.stdin.isTTY && !this.stdinWasRaw) process.stdin.setRawMode(false)
    process.stdin.pause()
  }
}
