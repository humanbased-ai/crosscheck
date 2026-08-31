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
        // eslint-disable-next-line no-console
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
  onProgress?: (line: string) => void
}): Promise<void> {
  const { owner, repo, prNumber, baseRef, tmpDir, token, protocol, onBaseFetchFailed, onProgress } = params
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
  try {
    await runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir, true)
  } catch {
    onBaseFetchFailed?.()
  }
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
  // Disable hooks before the agent runs, and leave them disabled. Otherwise an
  // agent with full filesystem access can drop a `.git/hooks/pre-commit` (or
  // repoint `core.hooksPath`) while the origin is scrubbed, and that hook fires
  // later when the runner commits/pushes — after this function has restored
  // the credential-bearing origin — letting it exfiltrate the token from
  // `.git/config`. The clone is disposable, so hooks are never re-enabled.
  try {
    execFileSync('git', ['config', 'core.hooksPath', '/dev/null'], { cwd: repoDir })
  } catch { /* not a git repo — fn() will fail on its own */ }

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
