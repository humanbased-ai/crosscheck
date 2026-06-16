import chalk from 'chalk'
import type { Config, DisplayTheme } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'
import { selectTip } from './tips.js'

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
  completedAt?: number      // set by completePR — slot stays in workspace until overflow eviction
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
}

interface Stats {
  prsReceived: number
  crsCompleted: number
  fixesApplied: number
  errorsOccurred: number
  crTotalMs: number
  sessionStart: number
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

// Short HH:MM timestamp (no seconds) for the "started" label
function fmtStartTime(epochMs: number): string {
  return new Date(epochMs).toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true })
}

// Format token count as a compact suffix: "(900)", "(1.2K)", "(1.5M)". Returns '' when undefined.
export function fmtTokens(n?: number): string {
  if (n == null) return ''
  if (n < 1_000) return `(${n})`
  if (n < 1_000_000) return `(${(n / 1_000).toFixed(1).replace(/\.0$/, '')}K)`
  return `(${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M)`
}

// Raw token count without surrounding parens: "900", "1.2K", "1.5M". Returns '' when undefined.
function fmtTokensRaw(n?: number): string {
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
const FOLD_THRESHOLD = 3  // when completed count exceeds this, fold all completed PRs to 1 line
const WORKSPACE_MAX = 25  // when total slots exceed this, evict oldest completed to scrollback

export class PRBoard {
  private slots = new Map<string, PRSlot>()
  private frameIdx = 0
  private timer: ReturnType<typeof setInterval> | null = null
  private liveLines = 0
  private liveContent = ''
  private readonly isTTY: boolean = Boolean(process.stdout.isTTY)
  private connLog: string[] = []

  private stats: Stats = {
    prsReceived: 0,
    crsCompleted: 0,
    fixesApplied: 0,
    errorsOccurred: 0,
    crTotalMs: 0,
    sessionStart: Date.now(),
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
    this.timer = setInterval(() => {
      this.frameIdx = (this.frameIdx + 1) % FRAMES.length
      this.redraw()
    }, 80)
  }

  stop(): void {
    if (this.timer) { clearInterval(this.timer); this.timer = null }
    this.eraseLive()
  }

  addPR(key: string, prNumber: number, repo: string, branch: string, round?: number): void {
    // When a new round starts for a PR that already has a completed slot in the
    // workspace, evict the prior-round slot to scrollback so only the current
    // round is shown. Prior-round slots always have a different key (different
    // SHA suffix) but the same prNumber + repo combination.
    if ((round ?? 1) >= 2) {
      for (const [existingKey, slot] of this.slots) {
        if (existingKey !== key && slot.prNumber === prNumber && slot.repo === repo && slot.completedAt !== undefined) {
          this.printStatic(this.renderPRSlotFolded(slot))
          this.slots.delete(existingKey)
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
    slot.label = 'done'

    const verdict = slot.verdict ?? null
    const fixCount = slot.fixCount

    if (verdict !== null || slot.phase === 'reviewed' || slot.phase === 'rechecked' || slot.phase === 'fixed') {
      this.stats.crsCompleted++
      this.stats.crTotalMs += data.elapsedMs
    }
    if (fixCount !== undefined && fixCount > 0) this.stats.fixesApplied++

    // Non-TTY has no live block to re-render — emit the folded line to scrollback and drop the slot.
    if (!this.isTTY) {
      process.stdout.write(this.renderPRSlotFolded(slot) + '\n')
      this.slots.delete(key)
    }
  }

  failPR(key: string, error: string): void {
    const slot = this.slots.get(key)
    this.slots.delete(key)
    this.stats.errorsOccurred++
    if (slot) {
      const ts = fmtTime()
      this.printStatic(`${chalk.dim(ts)}  PR #${slot.prNumber}  ${chalk.red('✗')} ${error}`)
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

  private uptime(): string {
    const totalSec = Math.floor((Date.now() - this.stats.sessionStart) / 1000)
    const h = Math.floor(totalSec / 3600)
    const m = Math.floor((totalSec % 3600) / 60)
    const s = totalSec % 60
    if (h > 0) return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`
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

  private renderPRSlot(slot: PRSlot, frame: string): string {
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
    const timePart = isCompleted
      ? t.dim(eSuffix)
      : `${t.dim('started ' + fmtStartTime(slot.startedAt))}  ${t.dim(eSuffix)}`
    const rightPart = `${timePart}  ${phaseLabel}`
    const identityPlain = `   #${slot.prNumber}  ${slot.repo}  ${branch}`
    const l1Pad = Math.max(2, w - stripAnsi(identityPlain).length - stripAnsi(rightPart).length - 2)
    const prNum = isCompleted ? t.dim(`#${slot.prNumber}`) : chalk.bold(`#${slot.prNumber}`)
    const repoStr = isCompleted ? t.dim(slot.repo) : chalk.white(slot.repo)
    const l1 = `  ${icon} ${prNum}  ${repoStr}  ${t.dim(branch)}` +
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
    if (slot.completedAt !== undefined) return t.dim('done')
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

    // When the workspace overflows, evict oldest completed slots to scrollback.
    this.evictOverflow()

    const t = this.theme
    const w = process.stdout.columns || 80
    // Use w-1 to prevent the exact-terminal-width cursor wrap ambiguity that
    // causes the first char of the next line to appear at the end of the separator.
    const sep = t.separator('─'.repeat(w - 1))

    const configLines = this.renderConfigPanel()
    const statsLines = this.renderStatsPanel()
    const prLines = this.renderPRWorkspace()

    return [
      ...configLines,
      sep,
      ...statsLines,
      sep,
      ...prLines,
      sep,
    ].join('\n')
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

  private renderStatsPanel(): string[] {
    const t = this.theme
    const lines: string[] = []

    lines.push(`  ${this.statsRow()}  ${t.dim('│')}  ${t.dim('↑')} ${this.uptime()}`)

    const { type: tunnelType, url, alive } = this.tunnel
    if (tunnelType !== 'none') {
      const tunnelLabel = tunnelType === 'serve' ? 'endpoint:' : 'tunnel:  '
      const tunnelDisplay = url
        ? `${url.replace(/^https?:\/\//, '')} ${alive ? t.success('✓') : t.warning('⚠')}`
        : t.dim('connecting...')
      lines.push(`  ${t.dim(tunnelLabel)} ${tunnelDisplay}`)
    }

    // Connectivity log: already prefixed with timestamps + indent in logConnectivity()
    const activeConn = this.connLog.filter(l => l.trim())
    lines.push(...activeConn)

    lines.push(this.renderTipLine())

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

  private renderPRWorkspace(): string[] {
    const t = this.theme
    const frame = FRAMES[this.frameIdx]

    if (this.slots.size === 0) {
      return [t.dim('  waiting for PRs...')]
    }

    let completedCount = 0
    for (const slot of this.slots.values()) {
      if (slot.completedAt !== undefined) completedCount++
    }
    const foldCompleted = completedCount > FOLD_THRESHOLD

    const lines: string[] = []
    let prevWasExpanded = false
    let first = true

    for (const slot of this.slots.values()) {
      const isCompleted = slot.completedAt !== undefined
      const useFolded = foldCompleted && isCompleted

      if (useFolded) {
        lines.push(this.renderPRSlotFolded(slot))
        prevWasExpanded = false
      } else {
        if (!first && prevWasExpanded) lines.push('')
        lines.push(this.renderPRSlot(slot, frame))
        prevWasExpanded = true
      }
      first = false
    }

    return lines
  }

  // ── Folded PR slot ─────────────────────────────────────────────────────────

  private renderPRSlotFolded(slot: PRSlot): string {
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

    const urlPart = slot.url ? `  ${t.dim('→')} ${t.accent(slot.url)}` : ''
    const partsStr = parts.length > 0 ? parts.join(t.dim(' · ')) : t.dim('—')

    return `  ${t.success('✓')} ${t.dim(`#${slot.prNumber}`)}  ${t.dim(slot.repo)}  ${t.dim(branch)}  ${partsStr}  ${t.dim(`(${elapsed})`)}${urlPart}`
  }

  // ── Overflow eviction ──────────────────────────────────────────────────────

  private evictOverflow(): void {
    if (this.slots.size <= WORKSPACE_MAX) return
    let toEvict = this.slots.size - WORKSPACE_MAX
    for (const [key, slot] of this.slots) {
      if (toEvict <= 0) break
      if (slot.completedAt === undefined) continue  // never evict active
      this.printStatic(this.renderPRSlotFolded(slot))
      this.slots.delete(key)
      toEvict--
    }
  }

  private redraw(): void {
    const content = this.render()
    if (content) this.writeLive(content)
  }
}
