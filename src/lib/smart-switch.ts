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

export type VendorFailureKind = 'usage_limit' | 'authentication' | 'unavailable' | 'timeout'

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

interface ErrorLike {
  message?: unknown
  stderr?: unknown
  stdout?: unknown
  code?: unknown
  timedOut?: unknown
}

function errorText(err: unknown): string {
  if (typeof err === 'string') return err.toLowerCase()
  if (err instanceof Error) {
    const value = err as Error & ErrorLike
    return typeof value.message === 'string' ? value.message.toLowerCase() : String(err).toLowerCase()
  }
  if (err && typeof err === 'object') {
    const value = err as ErrorLike
    return typeof value.message === 'string' ? value.message.toLowerCase() : String(err).toLowerCase()
  }
  return String(err).toLowerCase()
}

function hasVendorPrefix(msg: string): boolean {
  return /^(?:claude|codex)(?::|\s)/i.test(msg)
}

function isMissingVendorExecutable(err: unknown, msg: string): boolean {
  const code = err && typeof err === 'object' ? (err as ErrorLike).code : undefined
  return code === 'ENOENT' || /^(?:claude|codex):\s*(?:command not found|not found)\b/i.test(msg)
}

function errorTimedOut(err: unknown): boolean {
  return Boolean(err && typeof err === 'object' && (err as ErrorLike).timedOut === true)
    || /\btimed?\s*out\b|timeout|deadline exceeded/i.test(errorText(err))
}

/**
 * Returns true when a vendor has exhausted a budget or hit a provider-enforced
 * request limit. These failures are safe to handle by using the other vendor.
 */
export function isSubscriptionLimitError(err: unknown): boolean {
  const msg = errorText(err)
  return /\b(?:402|429)\b|rate[\s_-]?limit|too many requests|usage\s+limit|quota(?:\s+(?:exceeded|reached|exhausted))?|credits?\s+(?:exhausted|depleted|exceeded)|plan\s+limit|subscription\s+limit|resource\s+exhausted/.test(msg)
}

/**
 * Returns true when this vendor cannot run the requested step right now for a
 * reason the other vendor can work around. This includes authentication and
 * organization access, unsupported models/versions, missing CLIs, provider
 * outages, and transport failures. It deliberately does not match generic
 * "permission denied" or arbitrary subprocess errors, which may be local
 * checkout or Crosscheck bugs rather than a vendor outage.
 */
export function isVendorUnavailableError(err: unknown): boolean {
  const msg = errorText(err)
  const providerStatus = /\b(?:api|http)\s+(?:error\s+)?(?:401|403|408|500|502|503|504|529)\b/.test(msg)
  const providerFailure = providerStatus || /requires a newer version|unsupported\s+(?:model|version|feature)|model\s+(?:not found|unavailable|unsupported|does not exist)|not logged in|auth(?:entication)?\s+(?:failure|required|expired)|unauthori[sz]ed|access denied|bad credentials|organization[^\n]*(?:disabled|not enabled)|subscription access[^\n]*(?:disabled|forbidden|not enabled)|internal server error|bad gateway|gateway timeout|service unavailable|temporarily unavailable|provider\s+(?:unavailable|overloaded)|overloaded|capacity exceeded/.test(msg)
  const vendorTransportFailure = /connection\s+(?:reset|refused|closed)|socket.*(?:hang|closed)|econn(?:reset|refused)|etimedout|eai_again|network\s+(?:unreachable|timeout|error)/.test(msg)
  return providerFailure || isMissingVendorExecutable(err, msg) || (hasVendorPrefix(msg) && vendorTransportFailure)
}

/**
 * Returns true for transient provider failures that should get the existing
 * short retry before the workflow switches vendors.
 */
export function isTransientVendorError(err: unknown): boolean {
  const msg = errorText(err)
  return /\b(?:408|429|500|502|503|504|529)\b|rate[\s_-]?limit|too many requests|overloaded|temporarily unavailable|internal server error|bad gateway|gateway timeout|service unavailable|connection\s+(?:reset|refused|closed)|socket.*(?:hang|closed)|econn(?:reset|refused)|etimedout|eai_again|network\s+(?:unreachable|timeout|error)/.test(msg)
}

/**
 * The single failover predicate used by review, recheck, fix, and watch. A
 * timeout is included only after the vendor runner has exhausted its own
 * retry, so an oversized PR still gets one chance with the other vendor.
 */
export function isVendorFailoverError(err: unknown): boolean {
  const msg = errorText(err)
  return isSubscriptionLimitError(err) || isVendorUnavailableError(err) || (hasVendorPrefix(msg) && errorTimedOut(err))
}

/** Classify a failure for logs and user-facing status messages. */
export function classifyVendorFailure(err: unknown): VendorFailureKind | null {
  if (isSubscriptionLimitError(err)) return 'usage_limit'
  if (hasVendorPrefix(errorText(err)) && errorTimedOut(err)) return 'timeout'
  if (isVendorUnavailableError(err)) {
    const msg = errorText(err)
    if (/\b(?:401|403)\b|not logged in|auth(?:entication)?\s+(?:failure|required|expired)|unauthori[sz]ed|access denied|bad credentials|organization[^\n]*(?:disabled|not enabled)|subscription access[^\n]*(?:disabled|forbidden|not enabled)/.test(msg)) {
      return 'authentication'
    }
    return 'unavailable'
  }
  return null
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

  const failureKind = classifyVendorFailure(reason)
  const failureLabel = failureKind === 'usage_limit'
    ? 'hit a usage limit'
    : failureKind === 'authentication'
      ? 'is not available with the current credentials or organization access'
      : failureKind === 'timeout'
        ? 'timed out after its retries'
        : 'is unavailable'
  announce(
    `⚡ SMART-SWITCH  ${degradedVendor} ${failureLabel}`,
    `  Switched to single-vendor mode — ${fallbackVendor} will review all PRs. Restore attempt in 30 min.`,
  )
  fileLog({
    level: 'warn',
    event: 'smart_switch_triggered',
    degraded_vendor: degradedVendor,
    fallback_vendor: fallbackVendor,
    failure_kind: failureKind ?? 'unknown',
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
