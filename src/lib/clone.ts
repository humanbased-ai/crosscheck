import { setTimeout as sleep } from 'node:timers/promises'
import { execFileSync } from 'child_process'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'

const GIT_RESILIENCE_ARGS = [
  '-c', 'http.postBuffer=524288000',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=60',
  '-c', 'http.keepAlive=true',
  '-c', 'http.connectTimeout=30',
]

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

// Detect transient git clone errors that should be retried:
// - curl 16: Error in the HTTP2 framing layer
// - curl 18: Transferred a partial file / early EOF
// - RPC failed, fetch-pack: unexpected disconnect
function isTransientGitError(message: string): boolean {
  const m = message.toLowerCase()
  return /curl 16|http2 framing|curl 18|partial file|early eof|rpc failed|unexpected disconnect|fetch-pack: invalid|bytes of body.*expected/.test(m)
}

const MAX_GIT_RETRIES = 3
const GIT_RETRY_DELAY_MS = 2000

async function runGit(args: string[], cwd?: string, retryable = false, onProgress?: (line: string) => void): Promise<void> {
  let lastErr: Error | undefined
  for (let attempt = 1; attempt <= (retryable ? MAX_GIT_RETRIES : 1); attempt++) {
    try {
      const subprocess = execa('git', args, { cwd })
      if (onProgress && subprocess.stderr) {
        // git emits progress on stderr as \r-terminated updates ("Receiving
        // objects: 42% ..."); flush on both \r and \n so each update surfaces.
        let pending = ''
        subprocess.stderr.on('data', (chunk: Buffer) => {
          pending += chunk.toString()
          const lines = pending.split(/[\r\n]/)
          pending = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (trimmed) onProgress(redactCloneSecrets(trimmed))
          }
        })
      }
      await subprocess
      return
    } catch (err) {
      if (!(err instanceof Error)) throw err
      const redacted = redactCloneSecrets(err.message)

      if (retryable && isTransientGitError(redacted) && attempt < MAX_GIT_RETRIES) {
        // Transient error — wait and retry
        const delay = GIT_RETRY_DELAY_MS * attempt // exponential backoff: 2s, 4s, 6s
        console.error(`git: transient error (attempt ${attempt}/${MAX_GIT_RETRIES}), retrying in ${delay / 1000}s...`)
        await sleep(delay)
        lastErr = new Error(redacted)
        lastErr.stack = err.stack ? redactCloneSecrets(err.stack) : undefined
        continue
      }

      const wrapped = new Error(redacted)
      wrapped.stack = err.stack ? redactCloneSecrets(err.stack) : undefined
      throw wrapped
    }
  }
  if (lastErr) throw lastErr
}

/**
 * How `refs/remotes/origin/<base>` came to exist — or that it does not.
 *
 * `unavailable` is the one that matters: without the base ref there is no PR diff,
 * and every downstream step degrades silently rather than failing. The review
 * vendor answers "could not be performed", the commit counter falls back to whole
 * history and skips the fix step, and `git diff origin/<base>...HEAD` in the fixer
 * falls through to `HEAD~1` — a diff of the wrong thing.
 */
export type BaseRefStatus = 'fetched' | 'recovered_by_sha' | 'recovered_by_merge_ref' | 'unavailable'

export interface CloneResult {
  baseRefStatus: BaseRefStatus
}

export class BaseRefUnavailableError extends Error {
  constructor(public readonly baseRef: string) {
    super(
      `base ref origin/${baseRef} could not be resolved — the branch is deleted or renamed, `
      + 'so the PR diff cannot be computed. Retarget the PR to a live base branch and re-run.',
    )
    this.name = 'BaseRefUnavailableError'
  }
}

export function isBaseRefUnavailableError(err: unknown): err is BaseRefUnavailableError {
  return err instanceof BaseRefUnavailableError
}

function refExists(tmpDir: string, ref: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--verify', '--quiet', `${ref}^{commit}`], { cwd: tmpDir, stdio: ['ignore', 'pipe', 'ignore'] })
    return true
  } catch {
    return false
  }
}

// Clone the repo, fetch & checkout the PR head, and fetch the base ref into
// refs/remotes/origin/<base>. onBaseFetchFailed lets callers log a warning;
// other failures bubble up.
export async function clonePRForReview(params: {
  owner: string
  repo: string
  prNumber: number
  baseRef: string
  /**
   * The base commit from the PR payload. A branch that was deleted or renamed after
   * the PR opened no longer resolves by name, but GitHub still serves the commit
   * itself — so this is what turns an unreviewable PR back into a reviewable one.
   */
  baseSha?: string
  tmpDir: string
  token: string
  protocol: Config['clone_protocol']
  onBaseFetchFailed?: () => void
  onBaseRefRecovered?: (status: BaseRefStatus) => void
  onProgress?: (line: string) => void
}): Promise<CloneResult> {
  const { owner, repo, prNumber, baseRef, baseSha, tmpDir, token, protocol, onBaseFetchFailed, onBaseRefRecovered, onProgress } = params
  const cloneUrl = buildCloneUrl(owner, repo, token, protocol)
  // Clone is retryable — transient network issues (curl 16/18, framing errors) are common.
  // GIT_RESILIENCE_ARGS inline (-c flags) apply HTTP buffer/timeout settings without
  // requiring a local repo to already exist.
  // --progress forces git to emit stderr progress even when piped; without a
  // progress consumer, stay --quiet so error output remains clean.
  await runGit([...GIT_RESILIENCE_ARGS, 'clone', '--depth=50', onProgress ? '--progress' : '--quiet', cloneUrl, tmpDir], undefined, true, onProgress)
  await runGit([...GIT_RESILIENCE_ARGS, 'fetch', ...(onProgress ? ['--progress'] : []), 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir, true, onProgress)
  await runGit(['checkout', `pr-${prNumber}`], tmpDir)

  // Fetch base after PR checkout so we are never on the base branch during the fetch
  // (git refuses to update a checked-out ref). Explicit refs/remotes/origin/<base>
  // target so the remote-tracking ref is always created — `git fetch origin <branch>`
  // alone only writes FETCH_HEAD in shallow clones when the branch is absent from
  // the default refspec mapping.
  // Retryable like the clone: a transient failure here is not cosmetic. Without
  // origin/<base>, countCrosscheckCommitsForPR cannot scope its range and falls
  // back to counting the whole history — which trips the auto-fix commit cap on
  // any repo with prior [crosscheck] commits and silently disables fixing.
  const baseRefStatus = await resolveBaseRef({
    tmpDir, baseRef, prNumber,
    ...(baseSha !== undefined && { baseSha }),
    ...(onBaseFetchFailed !== undefined && { onBaseFetchFailed }),
    ...(onBaseRefRecovered !== undefined && { onBaseRefRecovered }),
  })
  return { baseRefStatus }
}

/**
 * Puts `refs/remotes/origin/<baseRef>` in place, or reports that it cannot be.
 *
 * Split out of clonePRForReview so it is testable against a local origin: the
 * clone itself is hard-wired to github.com, and the part worth testing is the
 * recovery chain, not the URL building.
 *
 * Assumes `tmpDir` is a git repo with an `origin` remote and the PR head checked
 * out — never the base branch, since git refuses to update a checked-out ref.
 */
export async function resolveBaseRef(params: {
  tmpDir: string
  baseRef: string
  prNumber: number
  baseSha?: string
  onBaseFetchFailed?: () => void
  onBaseRefRecovered?: (status: BaseRefStatus) => void
}): Promise<BaseRefStatus> {
  const { tmpDir, baseRef, prNumber, baseSha, onBaseFetchFailed, onBaseRefRecovered } = params
  let baseRefStatus: BaseRefStatus = 'fetched'
  try {
    await runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir, true)
  } catch {
    onBaseFetchFailed?.()
    baseRefStatus = 'unavailable'
  }

  // Fetching by name reports success in cases where the ref did not actually land,
  // so trust the ref, not the exit code.
  if (baseRefStatus === 'fetched' && !refExists(tmpDir, `refs/remotes/origin/${baseRef}`)) {
    onBaseFetchFailed?.()
    baseRefStatus = 'unavailable'
  }

  // Recovery 1 — by commit. A deleted or renamed base branch has no name to fetch,
  // but the commit stays reachable and GitHub still serves it. Depth matches the
  // clone so the recovered ref carries the same history a by-name fetch would.
  if (baseRefStatus === 'unavailable' && baseSha) {
    try {
      await runGit([...GIT_RESILIENCE_ARGS, 'fetch', '--depth=50', 'origin', baseSha], tmpDir, true)
      execFileSync('git', ['update-ref', `refs/remotes/origin/${baseRef}`, 'FETCH_HEAD'], { cwd: tmpDir, stdio: 'ignore' })
      if (refExists(tmpDir, `refs/remotes/origin/${baseRef}`)) baseRefStatus = 'recovered_by_sha'
    } catch { /* fall through to the merge-ref recovery */ }
  }

  // Recovery 2 — via the PR's merge ref. GitHub keeps refs/pull/<n>/merge for an
  // open, mergeable PR; its first parent is the base tip. This survives even when
  // the base commit itself is no longer directly fetchable.
  if (baseRefStatus === 'unavailable') {
    try {
      await runGit([...GIT_RESILIENCE_ARGS, 'fetch', '--depth=50', 'origin', `pull/${prNumber}/merge:refs/crosscheck/pr-${prNumber}-merge`], tmpDir, true)
      const parent = execFileSync('git', ['rev-parse', `refs/crosscheck/pr-${prNumber}-merge^1`], { cwd: tmpDir, encoding: 'utf8' }).trim()
      execFileSync('git', ['update-ref', `refs/remotes/origin/${baseRef}`, parent], { cwd: tmpDir, stdio: 'ignore' })
      if (refExists(tmpDir, `refs/remotes/origin/${baseRef}`)) baseRefStatus = 'recovered_by_merge_ref'
    } catch { /* base ref is genuinely unavailable */ }
  }

  if (baseRefStatus === 'recovered_by_sha' || baseRefStatus === 'recovered_by_merge_ref') {
    onBaseRefRecovered?.(baseRefStatus)
  }
  return baseRefStatus
}

// Runs `fn` with the clone's `origin` URL stripped of its embedded credentials.
//
// An HTTPS clone stores `https://x-access-token:<token>@github.com/...` in
// .git/config, so the checkout carries a writable GitHub token as a plain file.
// That is fine while only crosscheck runs there, and not fine once a vendor
// agent executes shell commands in it — reading .git/config or simply running
// `git push` is then enough to act on the repository as the token's owner.
//
// The token is not needed while an agent runs: reviews only read, and the fix
// step's push happens back in the runner after the agent has exited. So it is
// removed for the duration and restored in `finally`, whether `fn` returned or
// threw. A crash hard enough to skip the finally loses only the throwaway clone.
//
// SSH remotes carry no credential and are left untouched.
export async function withCredentialFreeOrigin<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  let original: string | undefined
  try {
    original = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim()
  } catch {
    // No origin (or no repo) — nothing to strip, and nothing to restore.
    return fn()
  }

  const scrubbed = original.replace(/^https:\/\/[^@/]*@github\.com\//, 'https://github.com/')
  if (scrubbed === original) return fn()

  execFileSync('git', ['remote', 'set-url', 'origin', scrubbed], { cwd: repoDir })
  try {
    return await fn()
  } finally {
    try {
      execFileSync('git', ['remote', 'set-url', 'origin', original], { cwd: repoDir })
    } catch { /* clone is disposable; a failed restore must not mask fn's result */ }
  }
}
