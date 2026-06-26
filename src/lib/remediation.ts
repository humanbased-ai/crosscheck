import type { ErrorCategory } from './logger.js'

// Returns a short one-line remediation hint for the operator given an error
// category and the raw error message. Returns empty string when no specific
// action can be suggested (subprocess / unknown — too varied to generalise).
export function hintForError(category: ErrorCategory, message: string): string {
  const m = message.toLowerCase()
  switch (category) {
    case 'auth':
      if (/codex/.test(m)) return 'run: codex login'
      if (/claude/.test(m)) return 'run: claude auth login'
      if (/github_token|bad credentials/.test(m)) return 'check env: GITHUB_TOKEN'
      return 'run: claude auth login  (or codex login, or check GITHUB_TOKEN)'
    case 'network':
      if (/ssl_error_syscall|libressl|ssl_connect/.test(m))
        return 'transient macOS/LibreSSL SSL error — retry in a moment; or set clone_protocol: ssh in crosscheck.config.yml'
      return 'check network connectivity to github.com'
    case 'timeout':
      return 'raise vendor.<reviewer>.timeout_sec in config, or pass --timeout 600s'
    case 'rate_limit':
      return 'GitHub or model API rate limit — wait a few minutes and retry'
    case 'overloaded':
      return 'model API temporarily overloaded — retry in ~1 minute'
    case 'budget':
      return 'raise per_review_budget_usd in config, or run with --no-timeout for uncapped mode'
    case 'permission':
      return 'check GITHUB_TOKEN scopes — requires: repo, read:org'
    case 'subprocess':
    case 'unknown':
      return ''
  }
  return ''
}
