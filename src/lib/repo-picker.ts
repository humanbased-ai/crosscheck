// Interactive arrow-key picker for CLI prompts.
// Uses raw-mode TTY input — degrades gracefully when stdin is not a TTY.

const HIDE_CURSOR = '\x1b[?25l'
const SHOW_CURSOR = '\x1b[?25h'
const ERASE_LINE = '\x1b[2K\r'
// Clears from the cursor to the bottom of the screen. Used before re-rendering
// so leftover content from a taller previous render doesn't linger when the new
// render is shorter (e.g. after a filter narrows the list).
const ERASE_DOWN = '\x1b[0J'
const BOLD = '\x1b[1m'
const DIM = '\x1b[2m'
const CYAN = '\x1b[36m'
const YELLOW = '\x1b[33m'
const RESET = '\x1b[0m'

const DEFAULT_PAGE_SIZE = 12
// Chrome rows beyond the item viewport: title (≤1) + filter (1) + status (1) + footer (1) + safety (1).
const VIEWPORT_OVERHEAD = 6

// ── Pure helpers (unit-tested) ───────────────────────────────────────────────

// Indices into `items` whose lowercase label includes the lowercased query.
// Empty query returns every index in order.
export function filterIndices(items: string[], query: string): number[] {
  if (!query) return items.map((_, i) => i)
  const q = query.toLowerCase()
  const out: number[] = []
  for (let i = 0; i < items.length; i++) {
    if (items[i].toLowerCase().includes(q)) out.push(i)
  }
  return out
}

// Shift the viewport so the cursor is inside [windowStart, windowStart + viewport).
// Pure: returns the new windowStart. Clamps so the viewport never extends past the list.
export function adjustWindowStart(
  windowStart: number,
  cursorPos: number,
  viewport: number,
  total: number,
): number {
  let ws = windowStart
  if (cursorPos < ws) ws = cursorPos
  else if (cursorPos >= ws + viewport) ws = cursorPos - viewport + 1
  if (ws + viewport > total) ws = Math.max(0, total - viewport)
  if (ws < 0) ws = 0
  return ws
}

// Resolve the actual viewport row count given a caller hint and the live terminal height.
export function resolveViewport(hint: number | undefined, termRows: number | undefined): number {
  const rows = termRows && termRows > 0 ? termRows : 24
  const ceiling = Math.max(3, rows - VIEWPORT_OVERHEAD)
  const requested = hint && hint > 0 ? hint : DEFAULT_PAGE_SIZE
  return Math.max(3, Math.min(requested, ceiling))
}

// Truncate a string so its visible width fits within `maxWidth` columns. Appends
// `…` when truncation happens. ANSI-aware callers must pass plain text — this
// helper does not parse escape sequences.
export function truncate(s: string, maxWidth: number): string {
  if (maxWidth <= 0) return ''
  if (s.length <= maxWidth) return s
  if (maxWidth === 1) return '…'
  return s.slice(0, maxWidth - 1) + '…'
}

// New windowStart after a PageDown / PageUp jump. The viewport advances by
// exactly one page so the visible window changes, not just the cursor — without
// this, PgDn would set cursorPos one viewport ahead but `adjustWindowStart`
// would only scroll far enough to make it visible (one row), so the picker
// behaves like a slow ↓ instead of a real page jump.
export function advancePageStart(
  windowStart: number,
  viewport: number,
  total: number,
  direction: 1 | -1,
): number {
  const next = windowStart + direction * viewport
  const maxStart = Math.max(0, total - viewport)
  return Math.max(0, Math.min(maxStart, next))
}

// ── Single-select picker ─────────────────────────────────────────────────────

export interface PickerItem {
  label: string
  description?: string  // shown dim next to label
  hint?: string         // tip shown at the bottom when this item is focused
}

// Arrow-key single-select. Returns the index of the chosen item.
// Returns defaultIndex when stdin is not a TTY.
export async function promptSinglePicker(
  items: PickerItem[],
  opts: { title?: string; defaultIndex?: number; pageSize?: number } = {},
): Promise<number> {
  if (!process.stdin.isTTY || items.length === 0) return opts.defaultIndex ?? 0

  return new Promise<number>((resolve, reject) => {
    let cursor = opts.defaultIndex ?? 0
    let windowStart = 0
    let lastLineCount = 0

    const viewport = () => Math.min(resolveViewport(opts.pageSize, process.stdout.rows), items.length)

    function render(firstRender = false) {
      const vp = viewport()
      windowStart = adjustWindowStart(windowStart, cursor, vp, items.length)

      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
      }

      const hint = items[cursor]?.hint ?? ''
      const showStatus = items.length > vp
      // title + items + hint + status (only when overflow) + footer
      lastLineCount = (opts.title ? 1 : 0) + vp + 1 + (showStatus ? 1 : 0) + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      for (let i = 0; i < vp; i++) {
        const idx = windowStart + i
        if (idx >= items.length) {
          process.stdout.write(`${ERASE_LINE}\n`)
          continue
        }
        const item = items[idx]
        const isFocused = cursor === idx
        const arrow = isFocused ? `${CYAN}❯${RESET}` : ' '
        const descStr = item.description ? `  ${DIM}${item.description}${RESET}` : ''
        const labelStr = isFocused ? `${BOLD}${item.label}${RESET}` : `${DIM}${item.label}${RESET}`
        process.stdout.write(`${ERASE_LINE}  ${arrow} ${labelStr}${descStr}\n`)
      }

      process.stdout.write(`${ERASE_LINE}${hint ? `${DIM}  💡 ${hint}${RESET}` : ''}\n`)
      if (showStatus) {
        process.stdout.write(`${ERASE_LINE}${DIM}  ${cursor + 1}/${items.length}${RESET}\n`)
      }
      const navHint = showStatus ? '↑↓ PgUp/PgDn move' : '↑↓ move'
      process.stdout.write(`${ERASE_LINE}${DIM}  ${navHint} · enter confirm${RESET}\n`)
    }

    function cleanup(index: number) {
      try { process.stdin.setRawMode(false) } catch { /* not raw */ }
      process.stdin.removeAllListeners('data')
      process.stdout.write(SHOW_CURSOR)
      resolve(index)
    }

    function handleSigint() {
      cleanup(opts.defaultIndex ?? 0)
      process.exit(130)
    }

    process.stdout.write(HIDE_CURSOR)
    render(true)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.once('SIGINT', handleSigint)

    process.stdin.on('data', (key: string) => {
      if (key === '\x03') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(opts.defaultIndex ?? 0)
        process.exit(130)
      }
      if (key === '\x1b[A') {
        cursor = cursor > 0 ? cursor - 1 : items.length - 1
        render()
      } else if (key === '\x1b[B') {
        cursor = cursor < items.length - 1 ? cursor + 1 : 0
        render()
      } else if (key === '\x1b[5~') {
        // PageUp — advance window AND cursor by one viewport so the page
        // actually flips. Without the windowStart bump, adjustWindowStart would
        // only scroll far enough to keep the cursor visible (one row).
        const vp = viewport()
        cursor = Math.max(0, cursor - vp)
        windowStart = advancePageStart(windowStart, vp, items.length, -1)
        render()
      } else if (key === '\x1b[6~') {
        // PageDown — see PageUp comment.
        const vp = viewport()
        cursor = Math.min(items.length - 1, cursor + vp)
        windowStart = advancePageStart(windowStart, vp, items.length, 1)
        render()
      } else if (key === '\r' || key === '\n') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(cursor)
      }
    })

    process.stdin.on('error', (err) => {
      process.removeListener('SIGINT', handleSigint)
      process.stdout.write(SHOW_CURSOR)
      reject(err)
    })
  })
}

// ── Multi-select picker ──────────────────────────────────────────────────────

export interface PickerOptions {
  title?: string
  initialSelected?: string[]
  pageSize?: number
  selectAllLabel?: string
  // Optional: return dim metadata shown after each item label
  getDescription?: (item: string) => string
  // Optional: show guidance for the focused item below the list.
  getHint?: (item: string, selectedItems: string[]) => string
  // Optional: prevent an incompatible item from being selected.
  getSelectionWarning?: (item: string, selectedItems: string[]) => string | undefined
}

// Arrow-key + space multi-select with a fixed-height viewport and `/` filter.
// Returns selected items. Returns [] when stdin is not a TTY.
//
// The viewport is capped by `pageSize` *and* the terminal height — we never emit
// more rows than fit on screen, so cursor-up offsets stay accurate. Press `/` to
// enter filter mode; typing narrows the visible list, Esc clears the filter,
// Enter exits filter mode and returns to selection.
export async function promptRepoPicker(
  items: string[],
  opts: PickerOptions = {},
): Promise<string[]> {
  if (!process.stdin.isTTY) return []
  if (items.length === 0) return []

  return new Promise<string[]>((resolve, reject) => {
    const allRow = -1
    const selected = new Set<number>(
      opts.initialSelected
        ? opts.initialSelected.map(s => items.indexOf(s)).filter(i => i !== -1)
        : [],
    )

    let filterText = ''
    let filterMode = false
    let filtered: number[] = filterIndices(items, '')
    let cursorPos = opts.selectAllLabel && items.length > 0 ? 1 : 0       // index into `filtered`
    let windowStart = 0     // index into `filtered`
    let lastLineCount = 0
    let selectionWarning = ''

    const viewport = () => resolveViewport(opts.pageSize, process.stdout.rows)
    const displayIndices = () => (opts.selectAllLabel && filtered.length > 0 ? [allRow, ...filtered] : filtered)
    const selectedItems = () => Array.from(selected).sort((a, b) => a - b).map(i => items[i])
    const selectableVisible = () => filtered.filter(i => !opts.getSelectionWarning?.(items[i], selectedItems()))
    const allVisibleSelected = () => {
      const selectable = selectableVisible()
      return selectable.length > 0 && selectable.every(i => selected.has(i))
    }
    const toggleAllVisible = () => {
      const allOn = allVisibleSelected()
      if (allOn) for (const i of selectableVisible()) selected.delete(i)
      else for (const i of filtered) {
        const warning = opts.getSelectionWarning?.(items[i], selectedItems())
        if (warning) selectionWarning ||= warning
        else selected.add(i)
      }
    }

    function recomputeFiltered() {
      filtered = filterIndices(items, filterText)
      const displayed = displayIndices()
      if (cursorPos >= displayed.length) cursorPos = Math.max(0, displayed.length - 1)
      windowStart = adjustWindowStart(windowStart, cursorPos, viewport(), displayed.length)
    }

    function render(firstRender = false) {
      const vp = viewport()
      const displayed = displayIndices()
      windowStart = adjustWindowStart(windowStart, cursorPos, vp, displayed.length)

      if (!firstRender) {
        process.stdout.write(`\x1b[${lastLineCount}A`)
        // Erase leftover content from the previous (possibly taller) render so a
        // shrinking filter doesn't leave stale rows hanging below the new output.
        process.stdout.write(ERASE_DOWN)
      }

      // Render exactly as many item rows as we have items, capped at the
      // viewport. Empty filter result → one "(no matches)" hint row instead.
      const visibleRows = Math.min(vp, displayed.length)
      const emptyHint = displayed.length === 0
      const itemRows = emptyHint ? 1 : visibleRows

      const showHint = Boolean(opts.getHint || opts.getSelectionWarning)
      lastLineCount = (opts.title ? 1 : 0) + 1 + itemRows + (showHint ? 1 : 0) + 1 + 1

      if (opts.title) {
        process.stdout.write(`${ERASE_LINE}${BOLD}${opts.title}${RESET}\n`)
      }

      // All user-controlled / variable-width text is clipped to the live
      // terminal width before rendering. If a line wrapped, the terminal would
      // consume an extra row that lastLineCount doesn't know about, and the
      // next cursor-up would land on the wrong line (re-introducing the
      // overflow bug this PR set out to fix, just triggered by a wide filter
      // string instead of a tall list).
      const cols = process.stdout.columns && process.stdout.columns > 0 ? process.stdout.columns : 80
      const innerWidth = Math.max(1, cols - 2)  // leading "  "

      if (filterMode || filterText) {
        const caret = filterMode ? '█' : ''
        // Visible prefix on this line: "  / " (4 cols). Caret is 1 col when present.
        const filterMax = Math.max(0, cols - 4 - (caret ? 1 : 0))
        const filterDisplay = truncate(filterText, filterMax)
        process.stdout.write(`${ERASE_LINE}  ${CYAN}/${RESET} ${filterDisplay}${caret}\n`)
      } else {
        process.stdout.write(`${ERASE_LINE}\n`)
      }

      if (emptyHint) {
        process.stdout.write(`${ERASE_LINE}  ${DIM}(no matches)${RESET}\n`)
      } else {
        for (let row = 0; row < visibleRows; row++) {
          const fi = windowStart + row
          const origIdx = displayed[fi]
          const isAllRow = origIdx === allRow
          const item = isAllRow ? opts.selectAllLabel ?? 'all' : items[origIdx]
          const isSelected = isAllRow ? allVisibleSelected() : selected.has(origIdx)
          const isFocused = cursorPos === fi
          const checkStr = isSelected ? `${CYAN}[x]${RESET}` : '[ ]'
          const desc = isAllRow ? `${filtered.length} PRs` : opts.getDescription ? opts.getDescription(item) : ''
          // Budget: cols - 2 (indent) - 4 ("[x] ") - (desc.length + 2 spaces if desc).
          const descBudget = desc ? desc.length + 2 : 0
          const labelMax = Math.max(1, cols - 6 - descBudget)
          const itemDisplay = truncate(item, labelMax)
          const descStr = desc ? `  ${DIM}${desc}${RESET}` : ''
          const labelStr = isFocused ? `${BOLD}${itemDisplay}${RESET}` : `${DIM}${itemDisplay}${RESET}`
          process.stdout.write(`${ERASE_LINE}  ${checkStr} ${labelStr}${descStr}\n`)
        }
      }

      if (showHint) {
        const focusedIndex = displayed[cursorPos]
        const focusedItem = focusedIndex === undefined || focusedIndex === allRow ? '' : items[focusedIndex]
        const hint = selectionWarning || (focusedItem ? opts.getHint?.(focusedItem, selectedItems()) ?? '' : '')
        const prefix = selectionWarning ? `${YELLOW}  ⚠ ` : `${DIM}  💡 `
        process.stdout.write(`${ERASE_LINE}${hint ? `${prefix}${truncate(hint, Math.max(1, cols - 4))}${RESET}` : ''}\n`)
      }

      const total = filtered.length
      const displayedTotal = displayed.length
      const pos = displayedTotal === 0 ? 0 : cursorPos + 1
      const selCount = selected.size
      const filterNote = filterText ? ` · filter: "${filterText}"` : ''
      const selNote = selCount > 0 ? ` · ${selCount} selected` : ''
      const statusLine = truncate(`${pos}/${displayedTotal}${filterNote}${selNote}`, innerWidth)
      process.stdout.write(`${ERASE_LINE}${DIM}  ${statusLine}${RESET}\n`)

      // PgUp/PgDn only when the *current* visible list overflows the viewport.
      // After a filter narrows the list, the hint shrinks accordingly.
      const navHint = displayed.length > vp ? '↑↓ PgUp/PgDn move' : '↑↓ move'
      const footerLine = filterMode
        ? `${navHint} · type to filter · backspace · esc clear · enter done`
        : `${navHint} · space select · a all · / filter · enter confirm`
      process.stdout.write(`${ERASE_LINE}${DIM}  ${truncate(footerLine, innerWidth)}${RESET}\n`)
    }

    function cleanup(result: string[]) {
      try {
        process.stdin.setRawMode(false)
      } catch { /* not a raw TTY */ }
      process.stdin.removeAllListeners('data')
      process.stdout.write(SHOW_CURSOR)
      resolve(result)
    }

    function handleSigint() {
      cleanup([])
      process.exit(130)
    }

    process.stdout.write(HIDE_CURSOR)
    render(true)

    process.stdin.setRawMode(true)
    process.stdin.resume()
    process.stdin.setEncoding('utf8')
    process.once('SIGINT', handleSigint)

    process.stdin.on('data', (key: string) => {
      if (key === '\x03') {
        process.removeListener('SIGINT', handleSigint)
        cleanup([])
        process.exit(130)
      }
      if (key !== ' ') selectionWarning = ''

      // Navigation keys work in both modes — let the user scroll while filtering.
      if (key === '\x1b[A') {
        const displayed = displayIndices()
        if (displayed.length === 0) return
        cursorPos = cursorPos > 0 ? cursorPos - 1 : displayed.length - 1
        render()
        return
      }
      if (key === '\x1b[B') {
        const displayed = displayIndices()
        if (displayed.length === 0) return
        cursorPos = cursorPos < displayed.length - 1 ? cursorPos + 1 : 0
        render()
        return
      }
      if (key === '\x1b[5~') {
        // PageUp — advance window AND cursor by one viewport so the page
        // actually flips. Without the windowStart bump, adjustWindowStart would
        // only scroll far enough to keep the cursor visible (one row).
        const displayed = displayIndices()
        if (displayed.length === 0) return
        const vp = viewport()
        cursorPos = Math.max(0, cursorPos - vp)
        windowStart = advancePageStart(windowStart, vp, displayed.length, -1)
        render()
        return
      }
      if (key === '\x1b[6~') {
        // PageDown — see PageUp comment.
        const displayed = displayIndices()
        if (displayed.length === 0) return
        const vp = viewport()
        cursorPos = Math.min(displayed.length - 1, cursorPos + vp)
        windowStart = advancePageStart(windowStart, vp, displayed.length, 1)
        render()
        return
      }

      if (filterMode) {
        if (key === '\x1b') {
          // Esc — clear filter and exit filter mode
          filterMode = false
          filterText = ''
          recomputeFiltered()
          render()
          return
        }
        if (key === '\r' || key === '\n') {
          // Enter — exit filter mode, keep filter applied
          filterMode = false
          render()
          return
        }
        if (key === '\x7f' || key === '\b') {
          // Backspace
          filterText = filterText.slice(0, -1)
          recomputeFiltered()
          render()
          return
        }
        // Printable characters extend the filter. Reject control sequences and
        // anything multi-byte we don't recognize.
        if (key.length === 1 && key >= ' ' && key <= '~') {
          filterText += key
          recomputeFiltered()
          render()
          return
        }
        return
      }

      // Non-filter mode
      if (key === '/') {
        filterMode = true
        render()
      } else if (key === ' ') {
        const displayed = displayIndices()
        if (displayed.length === 0) return
        const origIdx = displayed[cursorPos]
        if (origIdx === allRow) toggleAllVisible()
        else if (selected.has(origIdx)) {
          selected.delete(origIdx)
          selectionWarning = ''
        } else {
          const warning = opts.getSelectionWarning?.(items[origIdx], selectedItems())
          if (warning) selectionWarning = warning
          else {
            selected.add(origIdx)
            selectionWarning = ''
          }
        }
        render()
      } else if (key === 'a') {
        // Toggle every item in the current filtered view.
        toggleAllVisible()
        render()
      } else if (key === '\r' || key === '\n') {
        process.removeListener('SIGINT', handleSigint)
        cleanup(Array.from(selected).sort((a, b) => a - b).map(i => items[i]))
      }
    })

    process.stdin.on('error', (err) => {
      process.removeListener('SIGINT', handleSigint)
      process.stdout.write(SHOW_CURSOR)
      reject(err)
    })
  })
}
