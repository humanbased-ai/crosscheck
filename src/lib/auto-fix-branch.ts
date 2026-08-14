// The separate-fix-PR path is the fallback taken when a fix cannot be pushed onto the
// PR's own branch. Two things about it were broken in practice, and both are visible in
// real logs: 43 fix PRs opened, 19 `base: invalid` API failures, 12 push rejections.
//
// 1. It opened the PR against the source PR's head branch — which is missing in exactly
//    the case that sends us down this path (PR merged, branch auto-deleted). The
//    fallback failed for its own primary trigger, after having already pushed a branch,
//    leaving that branch orphaned.
// 2. It pushed with a plain `git push`, so a fix branch left behind by an earlier round
//    of the same PR made the push non-fast-forward and the fix was lost.

import { autoFixBranchName, isCrosscheckAutoFixPR } from '../github/superseded-fix-pr.js'

export type AutoFixDelivery =
  // The base branch exists — push the branch and open the follow-up PR.
  | { kind: 'pull_request'; base: string }
  // The base branch is gone, so the source PR has merged and any PR cut from this
  // snapshot would be stale the moment it opened — the exact artifact the superseded
  // -auto-fix-PR cleanup exists to close. Don't create it; post the diff instead.
  | { kind: 'comment'; reason: 'base_branch_gone' }

export function planAutoFixDelivery(baseBranchExists: boolean, baseBranch: string): AutoFixDelivery {
  return baseBranchExists
    ? { kind: 'pull_request', base: baseBranch }
    : { kind: 'comment', reason: 'base_branch_gone' }
}

// `--force-with-lease=<ref>:<oid>` states the remote value we believe we are replacing.
// With an empty oid it means "expect this ref not to exist", so one form covers both
// creating the branch and replacing a superseded one — and a branch someone else moved
// in between fails the lease instead of being overwritten.
//
// Force is appropriate here only because the branch is crosscheck's own artifact for
// one PR and one finding: the newer fix is built on the newer PR head and supersedes
// whatever the previous round pushed. It is never used on a branch a human owns.
export function forceWithLeaseArgs(branch: string, remoteOid: string | null): string[] {
  return [
    'push',
    `--force-with-lease=refs/heads/${branch}:${remoteOid ?? ''}`,
    'origin',
    `HEAD:${branch}`,
  ]
}

// `git ls-remote --heads origin <branch>` prints "<oid>\t<ref>" per match, and nothing
// at all when the branch does not exist.
export function parseLsRemoteOid(output: string): string | null {
  const line = output.split('\n').map(l => l.trim()).find(Boolean)
  if (!line) return null
  const oid = line.split(/\s+/)[0]
  return /^[0-9a-f]{40}$/i.test(oid) ? oid : null
}

export function isLeaseRejection(message: string): boolean {
  return /stale info|force-with-lease|fetch first|non-fast-forward/i.test(message)
}

// What GitHub reports about a PR whose head is the fix branch. Structural, so the
// decision below can be exercised without an Octokit response.
export interface FixBranchPR {
  number: number
  body?: string | null
  user?: { login: string } | null
  head: { ref: string }
}

export type FixBranchOwnership =
  | { owned: true; fixPrNumber: number }
  | { owned: false; reason: 'identity_unknown' | 'no_crosscheck_fix_pr' }

// Whether the fix branch that already exists on the remote is crosscheck's own artifact,
// and so safe to replace.
//
// Anything the pusher controls is not evidence: a commit message trailer, an author or
// committer name, and the branch name itself are all free-form strings that whoever
// creates `fix/cr-<n>-review-issues` can set to whatever they like — so a human branch
// carrying a `Crosscheck-Reviewer:` trailer would read as crosscheck's and be
// force-overwritten. Ownership is instead taken from GitHub's own record: a pull request
// **opened by the identity crosscheck authenticates as**, from this exact branch, whose
// body carries the auto-fix marker. Another actor cannot produce that record without
// crosscheck's credentials.
//
// The residual case is an install whose token belongs to a human who also works by hand:
// there, "crosscheck" and "that person" are one account and no check can separate them.
//
// Closed PRs count — the branch is still crosscheck's artifact once it has opened a PR
// from it. A branch with no such PR (an orphan left by a round that pushed before PR
// creation failed) is deliberately not replaced: the fix is delivered as a diff instead,
// which loses the follow-up PR but never someone else's commits.
export function assessFixBranchOwnership(input: {
  sourcePrNumber: number
  crosscheckLogin: string | null
  candidates: FixBranchPR[]
}): FixBranchOwnership {
  if (!input.crosscheckLogin) return { owned: false, reason: 'identity_unknown' }
  const login = input.crosscheckLogin.toLowerCase()
  const fixBranch = autoFixBranchName(input.sourcePrNumber)
  const ours = input.candidates.find(candidate =>
    candidate.head?.ref === fixBranch
    && candidate.user?.login?.toLowerCase() === login
    && isCrosscheckAutoFixPR(candidate.body, input.sourcePrNumber))
  return ours ? { owned: true, fixPrNumber: ours.number } : { owned: false, reason: 'no_crosscheck_fix_pr' }
}

// `pulls.create` rejecting the base branch, which is how a source PR that merges between
// the pre-flight check and the create call reports itself: GitHub deleted the head branch
// in that window, so the base we validated is gone by the time we ask for the PR.
export function isInvalidBaseError(err: unknown): boolean {
  const failure = err as {
    status?: number
    message?: string
    errors?: Array<{ field?: string; code?: string }>
    response?: { data?: { errors?: Array<{ field?: string; code?: string }> } }
  }
  if (failure?.status !== 422) return false
  const errors = failure.response?.data?.errors ?? failure.errors ?? []
  if (errors.some(entry => entry?.field === 'base' && entry?.code === 'invalid')) return true
  // Octokit's RequestError embeds the response body in its message; a shape we don't
  // recognise field-by-field is still readable there.
  return /"field"\s*:\s*"base"/.test(failure.message ?? '')
}
