import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { PRBoard, fmtTokens } from '../lib/board.js'
import type { Config } from '../config/schema.js'
import type { WorkflowStep } from '../lib/workflow.js'

describe('fmtTokens', () => {
  it('returns empty string for undefined', () => {
    expect(fmtTokens(undefined)).toBe('')
  })

  it('formats sub-1K counts as raw number', () => {
    expect(fmtTokens(0)).toBe('(0)')
    expect(fmtTokens(900)).toBe('(900)')
    expect(fmtTokens(999)).toBe('(999)')
  })

  it('formats exactly 1K with no decimal', () => {
    expect(fmtTokens(1000)).toBe('(1K)')
  })

  it('formats 1.2K correctly', () => {
    expect(fmtTokens(1200)).toBe('(1.2K)')
  })

  it('strips trailing .0 from K values', () => {
    expect(fmtTokens(2000)).toBe('(2K)')
    expect(fmtTokens(10000)).toBe('(10K)')
  })

  it('formats fractional K values', () => {
    expect(fmtTokens(1500)).toBe('(1.5K)')
    expect(fmtTokens(99900)).toBe('(99.9K)')
  })

  it('formats exactly 1M with no decimal', () => {
    expect(fmtTokens(1_000_000)).toBe('(1M)')
  })

  it('formats 1.5M correctly', () => {
    expect(fmtTokens(1_500_000)).toBe('(1.5M)')
  })

  it('strips trailing .0 from M values', () => {
    expect(fmtTokens(2_000_000)).toBe('(2M)')
  })
})

// ── PRBoard rendering + retention ───────────────────────────────────────────

const baseConfig = {
  mode: 'crosscheck',
  quality: { tier: 'balanced' },
  vendors: { claude: { enabled: true }, codex: { enabled: false } },
  display: {
    theme: {
      bar_fill: 'blue',
      bar_empty: 'dim',
      cr_approve: 'green',
      cr_needs_work: 'yellow',
      cr_block: 'red',
      fix_fill: 'cyan',
    },
  },
} as unknown as Config

const stripAnsi = (s: string) => s.replace(/\x1B\[[0-9;]*m/g, '')

const reviewStep: WorkflowStep = {
  type: 'review',
  name: 'review',
  reviewer: 'auto',
  max_rounds: 1,
}

describe('PRBoard — TTY workspace retention', () => {
  let board: PRBoard
  let originalIsTTY: boolean | undefined
  let originalRows: number | undefined
  let originalWrite: typeof process.stdout.write

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY
    originalRows = process.stdout.rows
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    // Tall viewport so height fitting never kicks in — these tests cover
    // count-based retention (WORKSPACE_MAX / FOLD_THRESHOLD) semantics only.
    Object.defineProperty(process.stdout, 'rows', { value: 200, configurable: true })
    originalWrite = process.stdout.write.bind(process.stdout)
    process.stdout.write = (() => true) as typeof process.stdout.write
    board = new PRBoard()
    board.setConfig(baseConfig, [reviewStep])
  })

  afterEach(() => {
    board.stop()
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
  })

  // Tests reach into private state because the relevant invariants live
  // on the slots map and there is no public read API.
  const slots = () => (board as unknown as { slots: Map<string, unknown> }).slots
  const invokeRender = () => (board as unknown as { render: () => string }).render()
  const invokeFolded = (key: string) =>
    (board as unknown as { renderPRSlotFolded: (s: unknown) => string }).renderPRSlotFolded(slots().get(key))

  it('keeps completed slot in the workspace (no auto-clear)', () => {
    board.addPR('k1', 1, 'a/b', 'main')
    board.completePR('k1', { elapsedMs: 1000, url: 'https://github.com/a/b/pull/1' })
    expect(slots().size).toBe(1)
    expect(slots().has('k1')).toBe(true)
  })

  it('evicts oldest completed slots when total exceeds workspace cap', () => {
    for (let i = 0; i < 30; i++) {
      board.addPR(`k${i}`, i, 'a/b', `branch-${i}`)
      board.completePR(`k${i}`, { elapsedMs: 1000, url: `https://github.com/a/b/pull/${i}` })
    }
    invokeRender()
    expect(slots().size).toBe(25)
    // The 5 oldest should be evicted (0..4); 5..29 retained.
    for (let i = 0; i < 5; i++) expect(slots().has(`k${i}`)).toBe(false)
    for (let i = 5; i < 30; i++) expect(slots().has(`k${i}`)).toBe(true)
  })

  it('never evicts active slots even at overflow', () => {
    for (let i = 0; i < 24; i++) {
      board.addPR(`done-${i}`, i, 'a/b', `branch-${i}`)
      board.completePR(`done-${i}`, { elapsedMs: 1000, url: `url-${i}` })
    }
    for (let i = 0; i < 5; i++) {
      board.addPR(`active-${i}`, 100 + i, 'a/b', `active-${i}`)
    }
    expect(slots().size).toBe(29)
    invokeRender()
    expect(slots().size).toBe(25)
    for (let i = 0; i < 5; i++) {
      expect(slots().has(`active-${i}`)).toBe(true)
    }
  })

  it('renders a folded line with verdict, fix count, recheck and url', () => {
    board.addPR('k1', 142, 'acme/api', 'chore/deps')
    board.updatePR('k1', { verdict: 'APPROVE', commentCount: 0, fixCount: 3, recheckVerdict: 'APPROVE' })
    board.completePR('k1', { elapsedMs: 45_000, url: 'https://github.com/acme/api/pull/142' })

    const folded = stripAnsi(invokeFolded('k1'))
    expect(folded).toContain('#142')
    expect(folded).toContain('acme/api')
    expect(folded).toContain('chore/deps')
    expect(folded).toContain('CR: APPROVE')
    expect(folded).toContain('fix 3')
    expect(folded).toContain('recheck APPROVE')
    expect(folded).toMatch(/\(\d+s\)/)
    expect(folded).toContain('https://github.com/acme/api/pull/142')
  })

  it('renders the PR URL in the expanded completed slot (not just folded)', () => {
    board.addPR('k1', 142, 'acme/api', 'chore/deps')
    board.updatePR('k1', { verdict: 'APPROVE', commentCount: 0 })
    board.completePR('k1', { elapsedMs: 45_000, url: 'https://github.com/acme/api/pull/142' })

    const output = stripAnsi(invokeRender())
    // With a single completed PR (below FOLD_THRESHOLD), the slot stays expanded
    // via renderPRSlot. The URL must still surface so operators can click through.
    expect(output).toContain('https://github.com/acme/api/pull/142')
  })

  it('evicts the prior-round completed slot when round 2 starts for the same PR', () => {
    // Round 1 — BLOCK, fix skipped, recheck skipped (the stale slot the user saw)
    board.addPR('k1@sha1', 214, 'owner/repo', 'fix/branch', 1)
    board.updatePR('k1@sha1', { verdict: 'BLOCK', commentCount: 1, fixCount: 0 })
    board.completePR('k1@sha1', { elapsedMs: 344_000, url: 'https://github.com/owner/repo/pull/214' })
    expect(slots().has('k1@sha1')).toBe(true)

    // Round 2 — new SHA push: board must evict round 1 and add round 2
    board.addPR('k1@sha2', 214, 'owner/repo', 'fix/branch', 2)
    expect(slots().has('k1@sha1')).toBe(false)   // prior round evicted
    expect(slots().has('k1@sha2')).toBe(true)    // new round present

    board.updatePR('k1@sha2', { recheckVerdict: 'APPROVE' })
    board.completePR('k1@sha2', { elapsedMs: 362_000, url: 'https://github.com/owner/repo/pull/214' })

    const output = stripAnsi(invokeRender())
    expect(output).not.toContain('BLOCK')
    expect(output).toContain('APPROVE')
  })

  it('does not evict active slots when round 2 starts', () => {
    // Active round 1 for a different PR — must not be touched
    board.addPR('other@sha', 99, 'owner/repo', 'other-branch', 1)
    // Completed round 1 for PR 214
    board.addPR('k1@sha1', 214, 'owner/repo', 'fix/branch', 1)
    board.completePR('k1@sha1', { elapsedMs: 1_000, url: 'u' })

    board.addPR('k1@sha2', 214, 'owner/repo', 'fix/branch', 2)
    expect(slots().has('other@sha')).toBe(true)   // untouched
    expect(slots().has('k1@sha1')).toBe(false)    // evicted
    expect(slots().has('k1@sha2')).toBe(true)
  })

  it('orders sections top-to-bottom: config → stats → PR workspace', () => {
    board.addPR('k1', 1, 'acme/api', 'feat/x')
    const output = stripAnsi(invokeRender())
    const idxBrand = output.indexOf('crosscheck')
    const idxStats = output.indexOf('PRs:')
    const idxPR = output.indexOf('#1')
    expect(idxBrand).toBeGreaterThanOrEqual(0)
    expect(idxStats).toBeGreaterThan(idxBrand)
    expect(idxPR).toBeGreaterThan(idxStats)
  })

  it('surfaces cross-vendor mode, the thoroughness scale, and ⇄ vendors', () => {
    board.setConfig({
      ...baseConfig,
      mode: 'cross-vendor',
      quality: { tier: 'thorough', mode: 'smart' },
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
    } as unknown as Config, [reviewStep])

    const output = stripAnsi(invokeRender())
    expect(output).toContain('mode:')
    expect(output).toContain('cross-vendor (claude ⇄ codex)')
    // Thoroughness rendered as a scale of all three tiers, with smart selection noted.
    expect(output).toContain('quality:')
    expect(output).toMatch(/fast › balanced › thorough/)
    expect(output).toContain('· smart')
    // Cross-vendor vendors reviewed each other → ⇄ separator.
    expect(output).toContain('claude ⇄ codex')
  })

  it('surfaces single-vendor mode without smart or ⇄ markers', () => {
    board.setConfig({
      ...baseConfig,
      mode: 'single-vendor',
      quality: { tier: 'fast' },
      vendors: { claude: { enabled: true }, codex: { enabled: false } },
    } as unknown as Config, [reviewStep])

    const output = stripAnsi(invokeRender())
    expect(output).toContain('single-vendor (single reviewer)')
    expect(output).toMatch(/fast › balanced › thorough/)
    expect(output).not.toContain('· smart')
    expect(output).not.toContain('⇄')
  })

  it('keeps settled slots folded when a recheck round drops the completed count', () => {
    // 4 completed → completedCount (4) > FOLD_THRESHOLD (3) → all fold to one line.
    // Folded form shows "CR: APPROVE"; expanded form shows "N issues (APPROVE…)".
    for (let i = 0; i < 4; i++) {
      board.addPR(`k${i}`, 200 + i, 'a/b', `branch-${i}`, 1)
      board.updatePR(`k${i}`, { verdict: 'APPROVE', commentCount: 2 })
      board.completePR(`k${i}`, { elapsedMs: 1000, url: `https://github.com/a/b/pull/${200 + i}` })
    }
    let output = stripAnsi(invokeRender())
    expect(output).toContain('CR: APPROVE')
    expect(output).not.toContain('issues')

    // One PR enters round 2 → active again → completedCount drops to 3 (≤ threshold).
    // Without sticky fold the other three would reflow to the expanded pipeline.
    board.addPR('k0@r2', 200, 'a/b', 'branch-0', 2)
    output = stripAnsi(invokeRender())
    expect(output).not.toContain('issues')   // settled slots stay folded
    expect(output).toContain('CR: APPROVE')
  })
})

// ── Viewport height fitting ───────────────────────────────────────────────────
//
// The live block is erased each frame with cursor-up + clear-to-end. Cursor-up
// clamps at the viewport top, so any row that scrolls out of the viewport can
// never be erased and leaks into scrollback as a permanent duplicate. These
// tests pin the invariant: rendered live block ≤ rows - 1 (one row reserved
// for the trailing newline writeLive appends).

describe('PRBoard — viewport height fitting', () => {
  let board: PRBoard
  let originalIsTTY: boolean | undefined
  let originalRows: number | undefined
  let originalColumns: number | undefined
  let originalWrite: typeof process.stdout.write
  let captured: string[]

  const setViewport = (rows: number, columns: number) => {
    Object.defineProperty(process.stdout, 'rows', { value: rows, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: columns, configurable: true })
  }

  beforeEach(() => {
    originalIsTTY = process.stdout.isTTY
    originalRows = process.stdout.rows
    originalColumns = process.stdout.columns
    Object.defineProperty(process.stdout, 'isTTY', { value: true, configurable: true })
    originalWrite = process.stdout.write.bind(process.stdout)
    captured = []
    process.stdout.write = ((chunk: unknown) => { captured.push(String(chunk)); return true }) as typeof process.stdout.write
    board = new PRBoard()
    board.setConfig(baseConfig, [reviewStep])
  })

  afterEach(() => {
    board.stop()
    process.stdout.write = originalWrite
    Object.defineProperty(process.stdout, 'isTTY', { value: originalIsTTY, configurable: true })
    Object.defineProperty(process.stdout, 'rows', { value: originalRows, configurable: true })
    Object.defineProperty(process.stdout, 'columns', { value: originalColumns, configurable: true })
  })

  const slots = () => (board as unknown as { slots: Map<string, unknown> }).slots
  const invokeRender = () => (board as unknown as { render: () => string }).render()
  const invokeRedraw = () => (board as unknown as { redraw: () => void }).redraw()

  const countRows = (content: string, w: number): number =>
    content.split('\n').reduce((sum, l) => sum + Math.max(1, Math.ceil(stripAnsi(l).length / w)), 0)

  const addCompleted = (n: number) => {
    for (let i = 0; i < n; i++) {
      board.addPR(`k${i}`, i, 'acme/api', `branch-${i}`)
      board.updatePR(`k${i}`, { verdict: 'APPROVE', commentCount: 2 })
      board.completePR(`k${i}`, { elapsedMs: 60_000, url: `https://github.com/acme/api/pull/${i}` })
    }
  }

  it('keeps the live block within rows - 1 when many PRs complete', () => {
    setViewport(20, 100)
    addCompleted(12)
    for (let i = 0; i < 6; i++) board.logConnectivity(`conn event ${i}`)
    expect(countRows(invokeRender(), 100)).toBeLessThanOrEqual(19)
  })

  it('folds completed slots below FOLD_THRESHOLD when the normal layout overflows', () => {
    setViewport(12, 100)
    addCompleted(2)
    const output = stripAnsi(invokeRender())
    // Folded form shows "CR: APPROVE"; expanded form shows "N issues (APPROVE...)"
    expect(output).toContain('CR: APPROVE')
    expect(output).not.toContain('issues')
    expect(countRows(invokeRender(), 100)).toBeLessThanOrEqual(11)
  })

  it('evicts completed slots to scrollback when the compact layout still overflows', () => {
    setViewport(12, 100)
    addCompleted(15)
    const output = invokeRender()
    expect(countRows(output, 100)).toBeLessThanOrEqual(11)
    expect(slots().size).toBeLessThan(15)
  })

  it('truncates from the top as a last resort when active slots alone overflow', () => {
    setViewport(8, 100)
    for (let i = 0; i < 6; i++) {
      board.addPR(`a${i}`, 100 + i, 'acme/api', `active-${i}`)
      board.updatePR(`a${i}`, { prLoc: 500, phase: 'reviewing' })
    }
    const output = invokeRender()
    expect(countRows(output, 100)).toBeLessThanOrEqual(7)
    expect(stripAnsi(output)).toMatch(/^\s*…/)
    expect(slots().size).toBe(6)  // active slots are never evicted
  })

  it('leaves no live-block residue in scrollback when redrawing (VT regression)', () => {
    const ROWS = 30, COLS = 100
    setViewport(ROWS, COLS)
    board.setTunnel('smee', 'https://smee.io/test', true)
    for (let i = 0; i < 5; i++) board.logConnectivity(`conn event ${i}`)
    invokeRedraw()
    for (let i = 0; i < 8; i++) {
      board.addPR(`k${i}`, 150 + i, 'humanbased-ai/codatta-onchain-protocol', `kayl/in-78x-t${i}-branch`)
      invokeRedraw()
      board.updatePR(`k${i}`, { prLoc: 1200, phase: 'reviewing' })
      invokeRedraw()
      board.updatePR(`k${i}`, { phase: 'reviewed', verdict: 'APPROVE', commentCount: 4, crTokens: 16400 })
      board.completePR(`k${i}`, { elapsedMs: 100_000, url: `https://github.com/humanbased-ai/codatta-onchain-protocol/pull/${150 + i}` })
      invokeRedraw()
    }
    board.log('PR #160 synchronize', 'origin=claude via=author_routes reviewer=claude')
    invokeRedraw()
    invokeRedraw()

    const { scrollback } = emulateVT(captured.join(''), ROWS, COLS)
    const liveOnlyMarkers = ['crosscheck', 'workflow:', 'vendors:', 'PRs:', 'tunnel:']
    const residue = scrollback.filter(l => liveOnlyMarkers.some(m => l.includes(m)))
    expect(residue).toEqual([])
  })
})

// Minimal VT emulator: LF scrolls at the bottom row, CUU clamps at the viewport
// top, ED-0J clears cursor→end-of-screen, autowrap is deferred at the last
// column. Rows pushed off the top are collected as scrollback.
function emulateVT(data: string, rows: number, cols: number): { scrollback: string[]; screen: string[] } {
  const screen: string[][] = Array.from({ length: rows }, () => [])
  let r = 0, c = 0, pendingWrap = false
  const scrollback: string[] = []
  const flush = (row: string[]) => row.map(ch => ch ?? ' ').join('').replace(/\s+$/, '')
  const lineFeed = (): void => {
    if (r === rows - 1) { scrollback.push(flush(screen[0])); screen.shift(); screen.push([]) }
    else r++
  }
  let i = 0
  while (i < data.length) {
    const ch = data[i]
    if (ch === '\x1B') {
      const m = /^\x1B\[([0-9;]*)([A-Za-z])/.exec(data.slice(i))
      if (m) {
        const [full, params, cmd] = m
        if (cmd === 'A') { r = Math.max(0, r - (parseInt(params || '1', 10) || 1)); pendingWrap = false }
        else if (cmd === 'J') {
          screen[r] = screen[r].slice(0, c)
          for (let k = r + 1; k < rows; k++) screen[k] = []
          pendingWrap = false
        }
        i += full.length
        continue
      }
      i++
      continue
    }
    if (ch === '\n') { c = 0; pendingWrap = false; lineFeed(); i++; continue }
    if (ch === '\r') { c = 0; pendingWrap = false; i++; continue }
    if (pendingWrap) { c = 0; pendingWrap = false; lineFeed() }
    screen[r][c] = ch
    if (c === cols - 1) pendingWrap = true
    else c++
    i++
  }
  return { scrollback, screen: screen.map(flush) }
}
