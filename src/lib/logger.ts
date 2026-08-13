import { appendFileSync, mkdirSync, readdirSync, rmSync, statSync, existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import type { LogsConfig } from '../config/schema.js'

export interface LogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

export type ErrorCategory =
  | 'auth'        // bad credentials, token missing, not logged in
  | 'permission'  // insufficient scope, forbidden
  | 'rate_limit'  // 429 — GitHub or model API rate limit
  | 'overloaded'  // 529 — upstream model API temporarily overloaded
  | 'budget'      // per-review budget cap reached (claude --max-budget-usd)
  | 'timeout'     // subprocess or network timeout
  | 'network'     // connection refused, DNS failure, git framing errors
  | 'git'         // git-specific errors (non-fast-forward, clone failures)
  | 'subprocess'  // CLI exited non-zero
  | 'unknown'

const LOG_DIR = join(homedir(), '.crosscheck', 'logs')

let _enabled = false
let _extendedEnabled = false
let _logFile = ''

export function initLogger(config: LogsConfig): void {
  _enabled = config.enabled
  // Extended logging requires both logs.enabled AND logs.extended.enabled.
  // Not exposed via CLI — consent agreement must be in place before activation.
  _extendedEnabled = _enabled && (config.extended?.enabled ?? false)
  if (!_enabled) return

  mkdirSync(LOG_DIR, { recursive: true })

  // Retention cleanup — delete files older than retention_days
  const cutoffMs = Date.now() - config.retention_days * 24 * 60 * 60 * 1000
  try {
    for (const name of readdirSync(LOG_DIR)) {
      if (!name.endsWith('.ndjson')) continue
      const filePath = join(LOG_DIR, name)
      const mtime = statSync(filePath).mtimeMs
      if (mtime < cutoffMs) rmSync(filePath)
    }
  } catch { /* best-effort */ }

  const today = new Date().toISOString().slice(0, 10)
  _logFile = join(LOG_DIR, `${today}.ndjson`)
}

export function log(entry: LogEntry): void {
  if (!_enabled || !_logFile) return
  try {
    appendFileSync(_logFile, JSON.stringify({ ts: new Date().toISOString(), ...entry }) + '\n')
  } catch { /* best-effort — never crash the main process */ }
}

// logExtended emits richer PR context fields (title, body, file paths, review text,
// author) that are deliberately excluded from standard logs for privacy reasons.
//
// Only fires when logs.extended.enabled = true in config. All entries carry
// "_extended": true so they can be filtered or scrubbed independently.
//
// DO NOT call this function without user consent on file. The activation path
// (consent prompt + config write) has not been implemented yet — this function
// exists so call sites can be wired up ahead of the consent agreement being drafted.
export function logExtended(entry: LogEntry): void {
  if (!_extendedEnabled || !_logFile) return
  try {
    appendFileSync(_logFile, JSON.stringify({ ts: new Date().toISOString(), _extended: true, ...entry }) + '\n')
  } catch { /* best-effort */ }
}

export function isExtendedLoggingEnabled(): boolean {
  return _extendedEnabled
}

// Strips the userinfo out of any https URL in the message before classification.
// A clone URL carries `x-access-token` as its literal username, which the auth
// pattern's bare `token` matched — so a clone that failed for any reason (SSL,
// timeout, 403) was filed as an auth failure, and the same SSL error read
// `network` on a push and `auth` on a clone. Only the copy used for matching is
// rewritten; log redaction is redactCloneSecrets' job and happens elsewhere.
function withoutUrlCredentials(message: string): string {
  return message.replace(/https:\/\/[^\s/@]+(?::[^\s/@]*)?@/g, 'https://')
}

export function classifyError(message: string): ErrorCategory {
  const m = withoutUrlCredentials(message.toLowerCase())
  // Specific, transient model-API conditions are matched BEFORE the broad auth
  // check below. Their error bodies routinely contain generic words like "token"
  // (token usage, max_tokens) that the auth match would otherwise swallow, which
  // mislabeled retryable 429/529/budget failures as `auth` and derailed triage (#191).
  // Word-boundary the numeric codes so they don't match digits embedded in
  // durations/counts/ports (e.g. "timed out after 5290ms" must not read as 529).
  if (/rate limit|secondary rate|\b429\b/.test(m)) return 'rate_limit'
  if (/\b529\b|overloaded/.test(m)) return 'overloaded'
  if (/maximum budget|budget (?:exhausted|exceeded)|error_max_budget|reached maximum budget/.test(m)) return 'budget'
  // Git-specific errors (non-fast-forward, clone failures) — checked before auth
  // since git errors may contain "token" in the URL but aren't auth issues.
  if (/rejected.*fetch first|updates were rejected.*remote contains work|non-fast-forward|curl 16|curl 18|http2 framing|early eof|rpc failed|fetch-pack: invalid/.test(m)) return 'git'
  // Git's own credential rejections. Without these, removing the URL-embedded
  // `token` above would leave a genuinely unauthenticated clone falling through to
  // `subprocess` — the accidental match was masking the fact that these were never
  // detected on their own. `permission denied (publickey)` is an SSH key failure,
  // i.e. auth, and does not collide with the scope-based `permission` check below.
  if (/authentication failed|could not read (?:username|password)|invalid username or password|permission denied \(publickey\)/.test(m)) return 'auth'
  if (/bad credentials|401|not logged in|not authenticated|github_token|authentication required|token|auth failure/.test(m)) return 'auth'
  if (/admin:org|admin:repo|forbidden|403|insufficient scope|requires.*scope|write:org/.test(m)) return 'permission'
  // Network check must precede timeout: subprocess stderr containing 'fetch failed'
  // would otherwise be shadowed by '--no-timeout' in the CLI command string.
  // ssl_error_syscall / libressl covers macOS LibreSSL errors on git clone/fetch.
  if (/fetch failed|econnrefused|enotfound|network error|socket hang|socket timeout|ssl_error_syscall|libressl/.test(m)) return 'network'
  if (/timeout|timed out|etimedout|deadline/.test(m)) return 'timeout'
  if (/exited with code|exit code [^0]|subprocess|command failed/.test(m)) return 'subprocess'
  return 'unknown'
}

// Extracts structured fields from an unknown thrown value, including execa subprocess errors.
function extractErrorFields(err: unknown): Record<string, unknown> {
  if (err == null) return { message: String(err) }

  const rawMessage = err instanceof Error ? err.message : String(err)
  const message = rawMessage.length > 2000 ? rawMessage.slice(0, 2000) + ' …[truncated]' : rawMessage
  const stack = err instanceof Error ? err.stack?.slice(0, 1000) : undefined
  const category = classifyError(rawMessage)

  // Duck-type execa errors — they carry exitCode, timedOut, stderr, command
  const maybeExeca = err as Record<string, unknown>
  const exitCode = typeof maybeExeca.exitCode === 'number' ? maybeExeca.exitCode : undefined
  const timedOut = maybeExeca.timedOut === true ? true : undefined
  const stderr = typeof maybeExeca.stderr === 'string' && maybeExeca.stderr.trim()
    ? maybeExeca.stderr.trim().slice(0, 500)  // cap to avoid bloat
    : undefined
  const command = typeof maybeExeca.command === 'string' ? maybeExeca.command : undefined

  return { message, stack, category, exitCode, timedOut, stderr, command }
}

export function logError(context: Record<string, unknown>, err: unknown): void {
  log({ level: 'error', event: 'error', ...extractErrorFields(err), ...context })
}

export function getLogDir(): string {
  return LOG_DIR
}

export function getTodayLogPath(): string {
  const today = new Date().toISOString().slice(0, 10)
  return join(LOG_DIR, `${today}.ndjson`)
}

// Exported so commands can register it with process error events
export function logUncaught(source: 'uncaughtException' | 'unhandledRejection', err: unknown): void {
  log({ level: 'error', event: 'process_error', source, ...extractErrorFields(err) })
}
