import { setTimeout as sleep } from 'node:timers/promises'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { existsSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { isAbsolute, join, resolve } from 'path'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'
import { getGitIdentityFromEnv } from '../config/loader.js'
import { getMergeBase } from '../github/client.js'
import { claimFreshClone, cloneFromCache, RepositoryCacheBusyError, tryClaimFreshClone, type ReleaseFreshClone } from './repository-cache.js'

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
  const envIdentity = getGitIdentityFromEnv()
  const name = envIdentity.name ?? configValue('user.name')
  const email = envIdentity.email ?? configValue('user.email')
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
// GitHub extension) is never invoked.
function buildCloneUrl(owner: string, repo: string, protocol: Config['clone_protocol']): string {
  return protocol === 'https'
    ? `https://github.com/${owner}/${repo}.git`
    : `git@github.com:${owner}/${repo}.git`
}

const GIT_TOKEN_VAR = 'CROSSCHECK_GIT_TOKEN'

/**
 * Authenticates a git child without putting the token in a URL. Git hands a remote's
 * URL to git-remote-https on its command line, so a token in the clone URL, or in
 * `origin` for every later fetch and push, is readable by anyone who can run `ps`.
 *
 * The helper reads the token from the environment, so the shell running it shows only
 * the variable's name, and it is set through GIT_CONFIG_* because `-c` is argv again.
 * Scoping it to github.com keeps the token from a redirect to another host, and the
 * empty value first drops any helper already configured, such as one an agent planted
 * in .git/config.
 *
 * Spread this into a git child's environment, never into process.env: vendor agents
 * inherit process.env, and an agent must not be able to push as the operator.
 */
export function gitCredentialEnv(token: string): NodeJS.ProcessEnv {
  const next = Number(process.env.GIT_CONFIG_COUNT ?? 0)
  return {
    [GIT_TOKEN_VAR]: token,
    // A helper that did not answer must fail the command, not wait on a terminal.
    GIT_TERMINAL_PROMPT: '0',
    GIT_CONFIG_COUNT: String(next + 2),
    [`GIT_CONFIG_KEY_${next}`]: 'credential.helper',
    [`GIT_CONFIG_VALUE_${next}`]: '',
    [`GIT_CONFIG_KEY_${next + 1}`]: 'credential.https://github.com.helper',
    [`GIT_CONFIG_VALUE_${next + 1}`]: `!f() { test "$1" = get && printf 'username=x-access-token\\npassword=%s\\n' "$${GIT_TOKEN_VAR}"; }; f`,
  }
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

// How long a review already queued for a busy cache holds out for it before checking
// whether a fresh clone slot has opened. The first wait is the cache's own, and longer.
const CACHE_REQUEUE_WAIT_MS = 5_000

const MAX_GIT_RETRIES = 3
const GIT_RETRY_DELAY_MS = 2000

async function runGit(args: string[], cwd?: string, retryable = false, onProgress?: (line: string) => void, env?: NodeJS.ProcessEnv): Promise<void> {
  isolateGitConfig()
  let lastErr: Error | undefined
  for (let attempt = 1; attempt <= (retryable ? MAX_GIT_RETRIES : 1); attempt++) {
    try {
      const subprocess = execa('git', args, { cwd, ...(env !== undefined && { env }) })
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

/**
 * `origin/<base>...HEAD` in the review checkout is not the PR's diff. Everything
 * downstream reads that range — the vendor's own `git diff`, classification, the
 * diff hash, the fixer — so carrying on reviews a different change and posts the
 * result as this PR's.
 */
export class ReviewRangeMismatchError extends Error {
  constructor(
    public readonly baseRef: string,
    public readonly expectedMergeBase: string,
    public readonly localMergeBases: readonly string[],
  ) {
    const short = (sha: string): string => sha.slice(0, 10)
    const local = localMergeBases.length === 0
      ? 'finds no merge base'
      : `finds merge base${localMergeBases.length > 1 ? 's' : ''} ${localMergeBases.map(short).join(' and ')}`
    super(
      `origin/${baseRef}...HEAD is not this PR's diff: the review checkout ${local}, but GitHub's is `
      + `${short(expectedMergeBase)}, so a review would read a different change than the PR's — refusing to review it.`,
    )
    this.name = 'ReviewRangeMismatchError'
  }
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
// refs/remotes/origin/<base>, then prove `origin/<base>...HEAD` is the PR's diff.
// onBaseFetchFailed lets callers log a warning; other failures bubble up, including
// ReviewRangeMismatchError when no checkout reproduces the PR's diff.
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
  repositoryCache?: boolean
  tmpDir: string
  token: string
  protocol: Config['clone_protocol']
  onBaseFetchFailed?: () => void
  onBaseRefRecovered?: (status: BaseRefStatus) => void
  onProgress?: (line: string) => void
  /** The repository cache failed and a fresh clone is being used instead. */
  onCacheFailed?: (message: string) => void
  /** What this review is queued behind, then null once it moves on. */
  onCloneWaiting?: (status: string | null) => void
}): Promise<CloneResult> {
  // Isolation is scoped here, not globally in cli.ts, so commands like `skill install`
  // that don't execute agents keep using the operator's normal Git config (credential
  // helpers, url.*.insteadOf, CA/proxy settings).
  isolateGitConfig()
  const { owner, repo, prNumber, baseRef, baseSha, tmpDir, token, protocol, onBaseFetchFailed, onBaseRefRecovered, onProgress } = params
  const cloneUrl = buildCloneUrl(owner, repo, protocol)
  const gitEnv = gitCredentialEnv(token)
  const checkout = (deepenOnMismatch: boolean): Promise<CloneResult> => checkoutPRAgainstBase({
    tmpDir, baseRef, prNumber, deepenOnMismatch, gitEnv,
    githubMergeBase: (base, head) => getMergeBase(owner, repo, base, head, token),
    ...(baseSha !== undefined && { baseSha }),
    ...(onBaseFetchFailed !== undefined && { onBaseFetchFailed }),
    ...(onBaseRefRecovered !== undefined && { onBaseRefRecovered }),
    ...(onProgress !== undefined && { onProgress }),
  })

  let waitingFor: string | null = null
  const reportWaiting = (status: string): void => {
    if (status !== waitingFor) params.onCloneWaiting?.(status)
    waitingFor = status
  }
  const reportWaitOver = (): void => {
    if (waitingFor !== null) params.onCloneWaiting?.(null)
    waitingFor = null
  }

  let releaseFreshClone: ReleaseFreshClone | null = null
  if (params.repositoryCache) {
    let cached = false
    // A busy cache is not a broken one, so this keeps queueing for it unless a fresh
    // clone can start right now. Sequential because cloneFromCache is what waits: it
    // only reports busy after holding out for the lock.
    while (!cached && releaseFreshClone === null) {
      try {
        await cloneFromCache({
          source: cloneUrl, repository: `${owner}/${repo}`, prNumber, destination: tmpDir,
          ...(waitingFor !== null && { lockWaitMs: CACHE_REQUEUE_WAIT_MS }),
          // Same hardening as the fresh clone: resilience flags, transient retries,
          // progress, and redacted errors for the one step that hits the network.
          git: (subcommand, args, { cwd, network }) => network
            ? runGit([...GIT_RESILIENCE_ARGS, subcommand, ...(onProgress ? ['--progress'] : []), ...args], cwd, true, onProgress, gitEnv)
            : runGit([subcommand, ...args], cwd),
        })
        cached = true
      } catch (err) {
        const message = redactCloneSecrets(err instanceof Error ? err.message : String(err))
        if (!(err instanceof RepositoryCacheBusyError)) {
          params.onCacheFailed?.(message)
          break
        }
        releaseFreshClone = await tryClaimFreshClone()
        if (releaseFreshClone === null) reportWaiting('waiting for the repository cache')
        else params.onCacheFailed?.(message)
      }
    }
    reportWaitOver()
    if (cached) {
      try {
        return await checkout(false)
      } catch (err) {
        // The cached checkout holds the PR's last 50 commits; a PR whose merge base
        // lies deeper cannot be diffed from it. A fresh clone fetches the PR's whole
        // history, so a wrong range earns it one retry. Any other failure is not the
        // cache's and would fail the same way again.
        if (!(err instanceof ReviewRangeMismatchError)) throw err
        params.onCacheFailed?.(err.message)
        // Emptied rather than removed: the caller's mkdtemp gave it owner-only access.
        for (const entry of readdirSync(tmpDir)) rmSync(join(tmpDir, entry), { recursive: true, force: true })
      }
    }
  }

  releaseFreshClone ??= await claimFreshClone(() => reportWaiting('waiting for a fresh clone slot'))
  reportWaitOver()
  try {
    // Clone is retryable — transient network issues (curl 16/18, framing errors) are common.
    // GIT_RESILIENCE_ARGS inline (-c flags) apply HTTP buffer/timeout settings without
    // requiring a local repo to already exist.
    // --progress forces git to emit stderr progress even when piped; without a
    // progress consumer, stay --quiet so error output remains clean.
    await runGit([...GIT_RESILIENCE_ARGS, 'clone', '--depth=50', onProgress ? '--progress' : '--quiet', cloneUrl, tmpDir], undefined, true, onProgress, gitEnv)
    // Held through the checkout: its fetches, and deepening the base, cost more than the clone.
    return await checkout(true)
  } finally {
    await releaseFreshClone()
  }
}

async function checkoutPRAgainstBase(params: {
  tmpDir: string
  baseRef: string
  prNumber: number
  baseSha?: string
  /** Fetch the base's whole history when its range proves wrong. Only a fresh clone is worth that. */
  deepenOnMismatch: boolean
  gitEnv: NodeJS.ProcessEnv
  githubMergeBase: (base: string, head: string) => Promise<string>
  onBaseFetchFailed?: () => void
  onBaseRefRecovered?: (status: BaseRefStatus) => void
  onProgress?: (line: string) => void
}): Promise<CloneResult> {
  const { tmpDir, baseRef, prNumber, baseSha, deepenOnMismatch, gitEnv, githubMergeBase, onBaseFetchFailed, onBaseRefRecovered, onProgress } = params
  await runGit([...GIT_RESILIENCE_ARGS, 'fetch', ...(onProgress ? ['--progress'] : []), 'origin', `pull/${prNumber}/head:pr-${prNumber}`], tmpDir, true, onProgress, gitEnv)
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
    tmpDir, baseRef, prNumber, gitEnv,
    ...(baseSha !== undefined && { baseSha }),
    ...(onBaseFetchFailed !== undefined && { onBaseFetchFailed }),
    ...(onBaseRefRecovered !== undefined && { onBaseRefRecovered }),
  })
  // An unavailable base has no range to check, and every caller refuses it.
  if (baseRefStatus !== 'unavailable') {
    try {
      await verifyReviewRange({ tmpDir, baseRef, githubMergeBase })
    } catch (err) {
      // A fresh clone is depth-50 of the default branch. When that is also this PR's
      // base, fetching the PR head and the base ref adds nothing below the base's
      // shallow boundary — the commits between it and the merge base were never
      // fetched, and a ref that is already present is not deepened by fetching it
      // again. A PR branched more than 50 commits back then has no path to its merge
      // base. Deepening the base is the only fix, and it costs history, so it is
      // reserved for a range that was just proven wrong, in a clone that has no
      // cheaper fallback — the cached checkout falls back to this clone instead.
      if (!deepenOnMismatch || !(err instanceof ReviewRangeMismatchError) || !isShallowRepository(tmpDir)) throw err
      await deepenBaseRef({ tmpDir, baseRef, gitEnv, onProgress })
      await verifyReviewRange({ tmpDir, baseRef, githubMergeBase })
    }
  }
  return { baseRefStatus }
}

function isShallowRepository(tmpDir: string): boolean {
  return execFileSync('git', ['rev-parse', '--is-shallow-repository'], { cwd: tmpDir, encoding: 'utf8' }).trim() === 'true'
}

// Fetched by commit, not name: the base ref may have been recovered from a sha or a
// merge ref and exist only locally, and `--unshallow` lifts the depth limit on
// everything the fetch reaches, which is the base's whole history.
async function deepenBaseRef(params: { tmpDir: string; baseRef: string; gitEnv: NodeJS.ProcessEnv; onProgress?: (line: string) => void }): Promise<void> {
  const { tmpDir, baseRef, gitEnv, onProgress } = params
  const tip = execFileSync('git', ['rev-parse', '--verify', `refs/remotes/origin/${baseRef}^{commit}`], { cwd: tmpDir, encoding: 'utf8' }).trim()
  await runGit([...GIT_RESILIENCE_ARGS, 'fetch', ...(onProgress ? ['--progress'] : []), '--unshallow', 'origin', tip], tmpDir, true, onProgress, gitEnv)
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
  gitEnv?: NodeJS.ProcessEnv
  onBaseFetchFailed?: () => void
  onBaseRefRecovered?: (status: BaseRefStatus) => void
}): Promise<BaseRefStatus> {
  // Called at this entry point too, not just in clonePRForReview: this is exported
  // and reachable on its own, and every public git entry point in this module
  // isolates for itself rather than trusting its caller to have done it.
  isolateGitConfig()
  const { tmpDir, baseRef, prNumber, baseSha, gitEnv, onBaseFetchFailed, onBaseRefRecovered } = params
  let baseRefStatus: BaseRefStatus = 'fetched'
  try {
    await runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `${baseRef}:refs/remotes/origin/${baseRef}`], tmpDir, true, undefined, gitEnv)
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
  // but the commit stays reachable and GitHub still serves it. No --depth, so the
  // recovered ref carries the same history a by-name fetch would: an unbounded fetch
  // stops at commits the checkout already has, while --depth=50 draws a new shallow
  // boundary 50 commits below the base tip — above the PR's branch point whenever
  // the PR is further behind than that, which cuts the base off from the merge base.
  if (baseRefStatus === 'unavailable' && baseSha) {
    try {
      await runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', baseSha], tmpDir, true, undefined, gitEnv)
      execFileSync('git', ['update-ref', `refs/remotes/origin/${baseRef}`, 'FETCH_HEAD'], { cwd: tmpDir, stdio: 'ignore' })
      if (refExists(tmpDir, `refs/remotes/origin/${baseRef}`)) baseRefStatus = 'recovered_by_sha'
    } catch { /* fall through to the merge-ref recovery */ }
  }

  // Recovery 2 — via the PR's merge ref. GitHub keeps refs/pull/<n>/merge for an
  // open, mergeable PR; its first parent is the base tip. This survives even when
  // the base commit itself is no longer directly fetchable. Unbounded for the same
  // reason as recovery 1.
  if (baseRefStatus === 'unavailable') {
    try {
      await runGit([...GIT_RESILIENCE_ARGS, 'fetch', 'origin', `pull/${prNumber}/merge:refs/crosscheck/pr-${prNumber}-merge`], tmpDir, true, undefined, gitEnv)
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

/**
 * Proves `origin/<baseRef>...HEAD` is the PR's diff, or throws ReviewRangeMismatchError.
 *
 * A shallow checkout's graph is only as good as its shallow boundaries, each a commit
 * git treats as having no parents. One on the base branch's path to the merge base
 * leaves git to answer with an older common ancestor reached some other way — or with
 * none — and nothing downstream notices, because a diff of the wrong range is still a
 * diff. GitHub holds the whole graph, so its merge base for the same two commits is
 * the reference: matching it means the range is exactly the PR's.
 *
 * Compared against the merge base `git diff A...B` actually uses, the first of git's,
 * so a history with several legitimate merge bases passes when git picks GitHub's.
 */
export async function verifyReviewRange(params: {
  tmpDir: string
  baseRef: string
  /** GitHub's merge base for two exact commits. */
  githubMergeBase: (base: string, head: string) => Promise<string>
}): Promise<void> {
  isolateGitConfig()
  const { tmpDir, baseRef, githubMergeBase } = params
  const git = (...args: string[]): string =>
    execFileSync('git', args, { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()
  const base = git('rev-parse', '--verify', `refs/remotes/origin/${baseRef}^{commit}`)
  const head = git('rev-parse', '--verify', 'HEAD^{commit}')
  const expected = await githubMergeBase(base, head)
  const mergeBases = (...flags: string[]): string[] => {
    // Exits 1, printing nothing, when the two commits share no history.
    try { return git('merge-base', ...flags, base, head).split('\n').filter(Boolean) } catch { return [] }
  }
  if (mergeBases()[0] === expected) return
  throw new ReviewRangeMismatchError(baseRef, expected, mergeBases('--all'))
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

export interface ChangedFiles {
  files: string[]
  additions: number
  deletions: number
}

/**
 * The PR's own changes, read from the clone rather than the API.
 *
 * The API's file list paginates and truncates on large PRs, and a truncated list
 * can turn a mixed PR into an apparently doc-only one — which now caps a verdict,
 * so a wrong answer suppresses a real BLOCK. The clone has the whole diff.
 *
 * Returns null when the diff cannot be read (no base ref, empty diff), so callers
 * fall back rather than treating "unknown" as "no files".
 */
export function changedFilesVsBase(tmpDir: string, baseRef: string): ChangedFiles | null {
  try {
    // execFileSync, not execSync: a git ref may legally contain `;`, `$( )` and
    // backticks, and this value drives routing rather than best-effort logging.
    const raw = execFileSync(
      'git',
      ['diff', '--numstat', `origin/${baseRef}...HEAD`],
      { cwd: tmpDir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] },
    ).trim()
    if (!raw) return null

    const files: string[] = []
    let additions = 0
    let deletions = 0
    for (const line of raw.split('\n')) {
      // numstat: <added>\t<deleted>\t<path>. Binary files report '-' for both.
      const [add, del, ...rest] = line.split('\t')
      const path = rest.join('\t').trim()
      if (!path) continue
      files.push(path)
      additions += parseInt(add, 10) || 0
      deletions += parseInt(del, 10) || 0
    }
    return files.length === 0 ? null : { files, additions, deletions }
  } catch {
    return null
  }
}

// Runs `fn` with the clone's `origin` URL stripped of any embedded credentials.
//
// clonePRForReview no longer writes a token into .git/config, but a checkout that
// carries one anyway must not reach a vendor agent: reading .git/config or simply
// running `git push` would then be enough to act on the repository as the token's
// owner. It is removed for the duration and restored afterwards, whether `fn`
// returned or threw. A crash hard enough to skip that loses only the throwaway clone.
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
