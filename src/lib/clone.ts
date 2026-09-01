import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, resolve } from 'path'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'

const GIT_RESILIENCE_ARGS = [
  '-c', 'http.postBuffer=524288000',
  '-c', 'http.lowSpeedLimit=1000',
  '-c', 'http.lowSpeedTime=60',
  '-c', 'http.keepAlive=true',
  '-c', 'http.connectTimeout=30',
]

const NULL_DEVICE = process.platform === 'win32' ? 'NUL' : '/dev/null'

// Agents share the operator's HOME, so a full-access run can edit global Git
// config. Preserve only the identity needed for commits, then make every Git
// child in this process ignore global and system config.
export function isolateGitConfig(): void {
  const configValue = (key: string): string | undefined => {
    for (const scope of ['--global', '--system']) {
      try {
        const value = execFileSync('git', ['config', scope, '--get', key], { encoding: 'utf8', stdio: 'pipe' }).trim()
        if (value) return value
      } catch { /* try the next scope */ }
    }
    return undefined
  }
  const name = process.env.GIT_COMMITTER_NAME ?? process.env.GIT_AUTHOR_NAME ?? configValue('user.name')
  const email = process.env.GIT_COMMITTER_EMAIL ?? process.env.GIT_AUTHOR_EMAIL ?? configValue('user.email')
  if (name) {
    process.env.GIT_AUTHOR_NAME ??= name
    process.env.GIT_COMMITTER_NAME ??= name
  }
  if (email) {
    process.env.GIT_AUTHOR_EMAIL ??= email
    process.env.GIT_COMMITTER_EMAIL ??= email
  }
  process.env.GIT_CONFIG_NOSYSTEM = '1'
  process.env.GIT_CONFIG_GLOBAL = NULL_DEVICE
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
  isolateGitConfig()
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

const HOOKS_DISABLED = NULL_DEVICE

export function runGitWithoutHooks(repoDir: string, args: string[], env?: NodeJS.ProcessEnv): void {
  isolateGitConfig()
  execFileSync('git', ['-c', `core.hooksPath=${HOOKS_DISABLED}`, ...args], {
    cwd: repoDir,
    env: { ...process.env, ...env, GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: NULL_DEVICE },
    stdio: 'pipe',
  })
}

export class CompromisedCloneError extends Error {
  constructor() {
    super('Review clone is compromised: its Git configuration could not be restored after the agent exited. This clone must be discarded before another Git operation runs.')
    this.name = 'CompromisedCloneError'
  }
}

function isGitRepository(repoDir: string): boolean {
  try {
    execFileSync('git', ['rev-parse', '--git-dir'], { cwd: repoDir, stdio: 'pipe' })
    return true
  } catch {
    return false
  }
}

function disableHooks(repoDir: string): void {
  execFileSync('git', ['config', 'core.hooksPath', HOOKS_DISABLED], { cwd: repoDir })
}

interface FileSnapshot {
  path: string
  contents?: Buffer
  mode?: number
}

function gitPath(repoDir: string, name: string): string {
  const path = execFileSync('git', ['rev-parse', '--git-path', name], { cwd: repoDir, encoding: 'utf8' }).trim()
  return isAbsolute(path) ? path : resolve(repoDir, path)
}

function snapshotFile(path: string): FileSnapshot {
  if (!existsSync(path)) return { path }
  return { path, contents: readFileSync(path), mode: statSync(path).mode }
}

function restoreFile(snapshot: FileSnapshot): void {
  if (snapshot.contents === undefined) {
    rmSync(snapshot.path, { force: true })
    return
  }

  const tmpPath = `${snapshot.path}.crosscheck-restore-${randomUUID()}`
  try {
    writeFileSync(tmpPath, snapshot.contents, { mode: snapshot.mode })
    renameSync(tmpPath, snapshot.path)
  } finally {
    rmSync(tmpPath, { force: true })
  }
}

function resolvedGitConfig(repoDir: string): Buffer {
  return execFileSync('git', ['config', '--null', '--list', '--show-origin'], { cwd: repoDir, stdio: 'pipe' })
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
// Git config is the second half of the same hole: hooks, fsmonitor, filters, and
// other settings can execute programs during the runner's later Git commands.
// Snapshotting and restoring the trusted config closes those paths together;
// comparing Git's resolved view also detects changes hidden in pre-existing
// includes. The clone is disposable, so a failed restore fails shut.
export async function withCredentialFreeOrigin<T>(repoDir: string, fn: () => Promise<T>): Promise<T> {
  isolateGitConfig()
  if (!isGitRepository(repoDir)) return fn()

  disableHooks(repoDir)

  let original: string | undefined
  try {
    original = execFileSync('git', ['remote', 'get-url', 'origin'], { cwd: repoDir, encoding: 'utf8', stdio: 'pipe' }).trim()
  } catch {
    // No origin — nothing to strip.
  }

  const scrubbed = original?.replace(/^https:\/\/[^@/]*@github\.com\//, 'https://github.com/')
  const stripped = original !== undefined && scrubbed !== original
  if (stripped) execFileSync('git', ['remote', 'set-url', 'origin', scrubbed as string], { cwd: repoDir })
  const configSnapshots = [...new Set(['config', 'config.worktree'].map(name => gitPath(repoDir, name)))]
    .map(snapshotFile)
  const trustedConfig = resolvedGitConfig(repoDir)

  let result: T | undefined
  let bodyError: unknown
  let bodyFailed = false
  try {
    result = await fn()
  } catch (err) {
    bodyError = err
    bodyFailed = true
  }

  try {
    for (const snapshot of configSnapshots) restoreFile(snapshot)
    if (!resolvedGitConfig(repoDir).equals(trustedConfig)) throw new Error('resolved Git config changed')
    if (stripped) execFileSync('git', ['remote', 'set-url', 'origin', original as string], { cwd: repoDir })
  } catch {
    // Deliberately avoids the words the vendor-login classifier keys on.
    throw new CompromisedCloneError()
  }

  if (bodyFailed) throw bodyError
  return result as T
}
