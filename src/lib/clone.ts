import { execFileSync } from 'child_process'
import { mkdirSync, rmSync } from 'fs'
import type { Config } from '../config/schema.js'
import { log } from './logger.js'

// Retry configuration for transient network failures
const MAX_RETRIES = 3
const INITIAL_RETRY_DELAY_MS = 1000
const MAX_RETRY_DELAY_MS = 8000

const GIT_RESILIENCE_ARGS = [
  '-c', 'http.postBuffer=524288000',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=60',
  '-c', 'http.keepAlive=true',
  '-c', 'http.connectTimeout=30',
]

// Error patterns that indicate transient network issues suitable for retry
const TRANSIENT_ERROR_PATTERNS = [
  /RPC failed|curl \d+|HTTP2 framing layer/i,
  /Failed to connect to github\.com|Couldn't connect to server/i,
  /Connection timed out|Connection reset by peer/i,
  /early EOF|protocol error/i,
  /TLS handshake|SSL_ERROR/i,
  /fatal: unable to access.*Failed to connect/i,
]

function isTransientError(message: string): boolean {
  return TRANSIENT_ERROR_PATTERNS.some(pattern => pattern.test(message))
}

// Bypass `gh repo clone` so gh's keyring auth (which may bridge to VS Code's
// GitHub extension) is never invoked. HTTPS embeds the token in the URL.
function buildCloneUrl(owner: string, repo: string, token: string, protocol: Config['clone_protocol']): string {
  return protocol === 'https'
    ? `https://x-access-token:${token}@github.com/${owner}/${repo}.git`
    : `git@github.com:${owner}/${repo}.git`
}

export function redactCloneSecrets(value: string): string {
  return value.replace(/https:\/\/x-access-token:[^@\s]+@github\.com\//g, 'https://x-access-token:[REDACTED]@github.com/')
}

function runGit(args: string[], cwd?: string): void {
  try {
    execFileSync('git', args, { cwd, stdio: 'pipe' })
  } catch (err) {
    if (!(err instanceof Error)) throw err
    const redacted = redactCloneSecrets(err.message)
    const wrapped = new Error(redacted)
    wrapped.stack = err.stack ? redactCloneSecrets(err.stack) : undefined
    throw wrapped
  }
}

function resetCloneDestination(tmpDir: string): void {
  rmSync(tmpDir, { recursive: true, force: true })
  mkdirSync(tmpDir, { recursive: true })
}

// Sleep for a given number of milliseconds
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms))
}

// Calculate retry delay with exponential backoff and jitter
function calculateRetryDelay(attempt: number): number {
  const baseDelay = Math.min(INITIAL_RETRY_DELAY_MS * Math.pow(2, attempt), MAX_RETRY_DELAY_MS)
  const jitter = Math.random() * 0.3 * baseDelay // 30% jitter
  return Math.floor(baseDelay + jitter)
}

// Clone the repo, fetch & checkout the PR head, and fetch the base ref into
// refs/remotes/origin/<base>. onBaseFetchFailed lets callers log a warning;
// other failures bubble up.
export async function clonePRForReview(params: {
  owner: string
  repo: string
  prNumber: number
  baseRef: string
  tmpDir: string
  token: string
  protocol: Config['clone_protocol']
  onBaseFetchFailed?: () => void
}): Promise<void> {
  const { owner, repo, prNumber, baseRef, tmpDir, token, protocol, onBaseFetchFailed } = params
  const cloneUrl = buildCloneUrl(owner, repo, token, protocol)

  // Clone with retry logic for transient network failures
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      runGit([...GIT_RESILIENCE_ARGS, 'clone', '--depth=50', '--quiet', cloneUrl, tmpDir])
      break // Success
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const redactedMessage = redactCloneSecrets(message)

      if (attempt < MAX_RETRIES && isTransientError(message)) {
        const delay = calculateRetryDelay(attempt)
        log({
          level: 'warn',
          event: 'git_clone_retry',
          attempt: attempt + 1,
          max_retries: MAX_RETRIES,
          delay_ms: delay,
          error: redactedMessage,
          repo: `${owner}/${repo}`,
          pr: prNumber,
        })
        resetCloneDestination(tmpDir)
        await sleep(delay)
      } else {
        // Non-transient error or max retries reached
        const wrapped = err instanceof Error ? err : new Error(message)
        wrapped.stack = err instanceof Error ? err.stack : undefined
        throw wrapped
      }
    }
  }

  // Fetch PR head with retry logic
  for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
    try {
      runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir)
      break // Success
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      const redactedMessage = redactCloneSecrets(message)

      if (attempt < MAX_RETRIES && isTransientError(message)) {
        const delay = calculateRetryDelay(attempt)
        log({
          level: 'warn',
          event: 'git_fetch_pr_retry',
          attempt: attempt + 1,
          max_retries: MAX_RETRIES,
          delay_ms: delay,
          error: redactedMessage,
          repo: `${owner}/${repo}`,
          pr: prNumber,
        })
        await sleep(delay)
      } else {
        const wrapped = err instanceof Error ? err : new Error(message)
        wrapped.stack = err instanceof Error ? err.stack : undefined
        throw wrapped
      }
    }
  }

  runGit(['checkout', `pr-${prNumber}`], tmpDir)

  // Fetch base after PR checkout so we are never on the base branch during the fetch
  // (git refuses to update a checked-out ref). Explicit refs/remotes/origin/<base>
  // target so the remote-tracking ref is always created — `git fetch origin <branch>`
  // alone only writes FETCH_HEAD in shallow clones when the branch is absent from
  // the default refspec mapping.
  try {
    runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir)
  } catch {
    onBaseFetchFailed?.()
  }
}
