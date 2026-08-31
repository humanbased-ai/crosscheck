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

const HOOKS_DISABLED = '/dev/null'

// git looks for hook scripts under core.hooksPath, so pointing it at /dev/null
// means none is ever found, whatever is sitting in .git/hooks.
function disableHooks(repoDir: string): void {
  try {
    execFileSync('git', ['config', 'core.hooksPath', HOOKS_DISABLED], { cwd: repoDir })
  } catch { /* not a git repo — fn() will fail on its own */ }
}

// Asks git for its fully-resolved value rather than reading .git/config, because
// an agent can append `[include] path = ...` (or an `includeIf`) pointing at a
// file that sets core.hooksPath. Includes are applied in file order and the last
// value wins, so re-setting the key in place does NOT beat an include that comes
// after it — measured, not assumed. Enumerating the include forms would be a
// denylist; asking git what it actually resolved is the check that cannot be
// out-spelled.
function hooksAreDisabled(repoDir: string): boolean {
  try {
    return execFileSync('git', ['config', '--get', 'core.hooksPath'], { cwd: repoDir, encoding: 'utf8' }).trim() === HOOKS_DISABLED
  } catch {
    return false
  }
}

function restoreOrigin(repoDir: string, url: string): void {
  try {
    execFileSync('git', ['remote', 'set-url', 'origin', url], { cwd: repoDir })
  } catch { /* clone is disposable; a failed restore must not mask fn's result */ }
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
// removed for the duration and restored afterwards, whether `fn` returned or
// threw. A crash hard enough to skip that loses only the throwaway clone.
//
// Hooks are the second half of the same hole, and disabling them up front does
// not close it: the agent can re-enable them while it runs, and the hook then
// fires on the runner's own `git commit`/`git push` here — after the credential
// is back, and with crosscheck's environment, which carries GITHUB_TOKEN. So the
// check that matters happens *after* the agent exits: if hooks are not verifiably
// disabled at that point the clone is treated as compromised, the credential is
// left off, and the step fails rather than committing in a booby-trapped clone.
//
// SSH remotes carry no credential and are left untouched.
export async function withCredentialFreeOrigin<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  disableHooks(repoDir)

  let original: string | undefined
  try {
    original = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8' }).trim()
  } catch {
    // No origin (or no repo) — nothing to strip, and nothing to restore.
  }

  const scrubbed = original?.replace(/^https:\/\/[^@/]*@github\.com\//, 'https://github.com/')
  const stripped = original !== undefined && scrubbed !== original
  if (stripped) execFileSync('git', ['remote', 'set-url', 'origin', scrubbed as string], { cwd: repoDir })

  let result: T
  try {
    result = await fn()
  } catch (err) {
    // Re-assert first: putting the token back is only safe if no hook can run.
    disableHooks(repoDir)
    if (stripped && hooksAreDisabled(repoDir)) restoreOrigin(repoDir, original as string)
    throw err
  }

  // Only meaningful when there is a token to put back. With no origin, or an SSH
  // one, .git/config holds nothing worth planting a hook for — and `git config`
  // failing because this is not a repository at all must not read as tampering.
  if (!stripped) return result

  disableHooks(repoDir)
  if (!hooksAreDisabled(repoDir)) {
    // Deliberately free of the words this repo's error classifier keys on
    // ('auth', 'credential', 'not logged in') — a security abort must not be
    // reported to the operator as a vendor login problem.
    throw new Error(
      'Review clone is compromised: core.hooksPath is no longer /dev/null, so the agent re-enabled git hooks. ' +
      'A hook would run on the next commit or push here, with the git token back in .git/config and crosscheck\'s environment. ' +
      'The token has been left off and this clone must be discarded.',
    )
  }
  restoreOrigin(repoDir, original as string)
  return result
}
