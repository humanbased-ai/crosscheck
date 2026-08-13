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
