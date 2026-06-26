import { log as fileLog } from './logger.js'

export interface SmartSwitchState {
  /** true = cross-vendor degraded; all PRs route to fallbackVendor */
  active: boolean
  degradedVendor: 'claude' | 'codex' | null
  fallbackVendor: 'claude' | 'codex' | null
  reason: string
  since: Date | null
  restoreAttemptCount: number
  /**
   * Set after _attemptRestore fires. Tracks which vendor needs to succeed at
   * a real review before we announce confirmed restoration.
   */
  pendingRecoveryVendor: 'claude' | 'codex' | null
}

export type SmartSwitchAnnounce = (line1: string, line2?: string) => void

const RESTORE_INTERVAL_MS = 30 * 60 * 1000

let _state: SmartSwitchState = {
  active: false,
  degradedVendor: null,
  fallbackVendor: null,
  reason: '',
  since: null,
  restoreAttemptCount: 0,
  pendingRecoveryVendor: null,
}
let _restoreTimer: ReturnType<typeof setTimeout> | null = null
let _storedAnnounce: SmartSwitchAnnounce | null = null

export function getSmartSwitch(): Readonly<SmartSwitchState> {
  return _state
}

/**
 * Returns true when the error message pattern matches known subscription / rate-limit
 * errors from either the claude or codex CLIs.
 */
export function isSubscriptionLimitError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /rate.?limit|subscription.?limit|usage.?limit|quota|429|too many requests|credits? exhausted|plan limit/.test(msg)
}

/**
 * Returns true when the error means this vendor cannot review right now for a
 * reason that a retry won't fix but the *other* vendor can work around — e.g.
 * the CLI is too old for its default model ("requires a newer version"), the
 * vendor isn't authenticated, or its credentials are rejected. These are
 * treated like a usage limit: degrade to the healthy vendor instead of failing
 * the whole review.
 */
export function isVendorUnavailableError(err: unknown): boolean {
  const msg = (err instanceof Error ? err.message : String(err)).toLowerCase()
  return /requires a newer version|not logged in|auth(?:entication)? (?:failure|required|expired)|unauthorized|bad credentials/.test(msg)
}

/**
 * Inspects the error message prefix emitted by runClaudeReview / runCodexReview
 * to determine which vendor threw.
 */
export function detectFailedVendor(err: unknown): 'claude' | 'codex' | null {
  const msg = err instanceof Error ? err.message : String(err)
  if (/^claude:/i.test(msg)) return 'claude'
  if (/^codex:/i.test(msg)) return 'codex'
  return null
}

/**
 * Activates smart-switch: demotes cross-vendor to single-vendor mode using the
 * healthy vendor, announces loudly, and arms the 30-minute restore timer.
 *
 * Idempotent — calling again for the same degraded vendor re-arms the timer without
 * double-announcing.
 */
export function triggerSwitch(
  degradedVendor: 'claude' | 'codex',
  reason: string,
  announce: SmartSwitchAnnounce,
): void {
  if (_state.active && _state.degradedVendor === degradedVendor) {
    // Vendor is still down — reset the restore clock
    _scheduleRestore()
    return
  }

  const fallbackVendor: 'claude' | 'codex' = degradedVendor === 'claude' ? 'codex' : 'claude'
  // Carry over attempt count if this is a re-trigger after a failed restore attempt
  const prevAttempts =
    _state.degradedVendor === degradedVendor || _state.pendingRecoveryVendor === degradedVendor
      ? _state.restoreAttemptCount
      : 0

  if (_restoreTimer) { clearTimeout(_restoreTimer); _restoreTimer = null }

  _state = {
    active: true,
    degradedVendor,
    fallbackVendor,
    reason,
    since: new Date(),
    restoreAttemptCount: prevAttempts,
    pendingRecoveryVendor: null,
  }
  _storedAnnounce = announce

  announce(
    `⚡ SMART-SWITCH  ${degradedVendor} hit a subscription limit`,
    `  Switched to single-vendor mode — ${fallbackVendor} will review all PRs. Restore attempt in 30 min.`,
  )
  fileLog({
    level: 'warn',
    event: 'smart_switch_triggered',
    degraded_vendor: degradedVendor,
    fallback_vendor: fallbackVendor,
    reason: reason.slice(0, 300),
    restore_attempt_count: prevAttempts,
  })

  _scheduleRestore()
}

/**
 * Call after every successful review. When a restore attempt is pending and this
 * reviewer matches the recovering vendor, announces confirmed restoration.
 */
export function notifyReviewSuccess(reviewer: 'claude' | 'codex', announce: SmartSwitchAnnounce): void {
  if (_state.pendingRecoveryVendor !== reviewer) return
  const recovered = _state.pendingRecoveryVendor
  _state = { ..._state, pendingRecoveryVendor: null, restoreAttemptCount: 0 }
  announce(
    `✓  SMART-SWITCH  cross-vendor mode confirmed restored`,
    `  ${recovered} completed a review — back to full cross-vendor routing.`,
  )
  fileLog({ level: 'info', event: 'smart_switch_restored', vendor: recovered })
}

/** Call on process exit to clear the restore timer without firing it. */
export function stopSmartSwitch(): void {
  if (_restoreTimer) { clearTimeout(_restoreTimer); _restoreTimer = null }
}

/** Resets all state — intended for testing only. */
export function _resetSmartSwitch(): void {
  if (_restoreTimer) { clearTimeout(_restoreTimer); _restoreTimer = null }
  _state = {
    active: false,
    degradedVendor: null,
    fallbackVendor: null,
    reason: '',
    since: null,
    restoreAttemptCount: 0,
    pendingRecoveryVendor: null,
  }
  _storedAnnounce = null
}

function _scheduleRestore(): void {
  if (_restoreTimer) clearTimeout(_restoreTimer)
  _restoreTimer = setTimeout(_attemptRestore, RESTORE_INTERVAL_MS)
}

function _attemptRestore(): void {
  if (!_state.active) return
  _restoreTimer = null

  const was = _state.degradedVendor!
  const count = _state.restoreAttemptCount + 1
  const minutesSince = _state.since ? Math.round((Date.now() - _state.since.getTime()) / 60_000) : 30

  _state = {
    ..._state,
    active: false,
    degradedVendor: null,
    fallbackVendor: null,
    restoreAttemptCount: count,
    pendingRecoveryVendor: was,
  }

  _storedAnnounce?.(
    `↺  SMART-SWITCH  restore attempt #${count} — trying ${was} again`,
    `  ${was} was degraded for ~${minutesSince} min. Next PR routed to ${was} will confirm.`,
  )
  fileLog({
    level: 'info',
    event: 'smart_switch_restore_attempt',
    vendor: was,
    attempt: count,
    minutes_since_switch: minutesSince,
  })
}
