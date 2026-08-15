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
