import type { Octokit } from 'octokit'
import type { PRMergeSummary } from '../lib/pr-status.js'

export async function getPRMergeSummary(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  baseRef: string,
): Promise<PRMergeSummary> {
  const [{ data: pull }, protectedBase] = await Promise.all([
    octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber }),
    getProtectedBase(octokit, owner, repo, baseRef),
  ])

  const mergeStateStatus = typeof pull.mergeable_state === 'string'
    ? pull.mergeable_state
    : undefined

  return {
    mergeable: pull.mergeable,
    ...(mergeStateStatus && { mergeStateStatus }),
    protectedBase,
  }
}

async function getProtectedBase(
  octokit: Octokit,
  owner: string,
  repo: string,
  branch: string,
): Promise<boolean | null> {
  try {
    const { data } = await octokit.rest.repos.getBranch({ owner, repo, branch })
    return data.protected
  } catch {
    return null
  }
}

export type MergeMethod = 'merge' | 'squash' | 'rebase'

export interface RepoMergeConfig {
  allowed: MergeMethod[]
  /** The repo's own preference, when it expresses one. */
  preferred: MergeMethod
}

/**
 * Which merge methods the repository permits, and which to default to.
 *
 * Read rather than assumed: imposing squash on a repo that keeps merge commits
 * (or vice versa) rewrites its history convention on the operator's behalf.
 * `merge` is the last resort because it is GitHub's own default for a new repo.
 */
export async function getRepoMergeConfig(
  octokit: Octokit,
  owner: string,
  repo: string,
): Promise<RepoMergeConfig> {
  const { data } = await octokit.rest.repos.get({ owner, repo })
  const allowed: MergeMethod[] = []
  if (data.allow_merge_commit !== false) allowed.push('merge')
  if (data.allow_squash_merge !== false) allowed.push('squash')
  if (data.allow_rebase_merge !== false) allowed.push('rebase')

  // GitHub exposes no "default method" field, so preference follows the repo's
  // own narrowing: a repo that allows exactly one method has stated its
  // convention by disabling the others.
  const preferred: MergeMethod = allowed.length === 1 ? allowed[0]
    : allowed.includes('merge') ? 'merge'
    : allowed[0] ?? 'merge'

  return { allowed: allowed.length > 0 ? allowed : ['merge'], preferred }
}

/**
 * Merges the pull request.
 *
 * `expectedHeadSha` is not optional in practice and callers must pass it: GitHub
 * rejects the merge if the head moved, which is the only thing standing between
 * "merge the commit a reviewer approved" and "merge whatever landed since".
 */
export async function mergePullRequest(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  options: { method: MergeMethod; expectedHeadSha: string },
): Promise<{ sha: string; merged: boolean }> {
  const { data } = await octokit.rest.pulls.merge({
    owner,
    repo,
    pull_number: pullNumber,
    merge_method: options.method,
    sha: options.expectedHeadSha,
  })
  return { sha: data.sha, merged: data.merged }
}
