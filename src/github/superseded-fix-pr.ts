import type { Octokit } from 'octokit'

// An auto-fix PR is a snapshot of the reviewed PR at the moment the fix ran. Once the
// source PR merges, that snapshot is frozen against a tree that no longer exists: if
// the author pushed their own fix for the same finding, the two fixes live side by side
// and merging the auto-fix reintroduces exactly what the author's version removed —
// while reading, on the PR page, like a routine cleanup merge. Nothing in the auto-fix
// PR says it was superseded.
//
// So when the source PR merges, close its auto-fix PR and say why. The finding is
// either fixed on the base branch or still open there; either way the stale snapshot
// is not the vehicle for it.

export function autoFixBranchName(sourcePrNumber: number): string {
  return `fix/cr-${sourcePrNumber}-review-issues`
}

// First line of every auto-fix PR body. Doubles as the ownership check below, so it is
// built here rather than inlined at the creation site.
export function autoFixPRIntro(sourcePrNumber: number): string {
  return `Auto-fix by crosscheck for CR issues found in #${sourcePrNumber}.`
}

// Branch-name matching alone would let a hand-created branch of the same name be
// closed by crosscheck. Require the body it writes as well.
export function isCrosscheckAutoFixPR(body: string | null | undefined, sourcePrNumber: number): boolean {
  return (body ?? '').includes(autoFixPRIntro(sourcePrNumber))
}

export function buildSupersededComment(input: {
  owner: string
  repo: string
  sourcePrNumber: number
  mergeCommitSha: string | null
}): string {
  const mergedAs = input.mergeCommitSha
    ? ` as [\`${input.mergeCommitSha.slice(0, 9)}\`](https://github.com/${input.owner}/${input.repo}/commit/${input.mergeCommitSha})`
    : ''
  return [
    '### Superseded — closing',
    '',
    `#${input.sourcePrNumber} merged${mergedAs}, so the changes on this branch are a snapshot of a tree that no longer exists. If the author fixed the same finding themselves, merging this PR would reintroduce what their fix removed.`,
    '',
    `Re-run a review against \`${input.owner}/${input.repo}\`'s base branch if the finding still stands there — this branch is not the right vehicle for it.`,
    '',
    '<!-- crosscheck: superseded_auto_fix -->',
  ].join('\n')
}

export type SupersedeStatus = 'closed' | 'not_crosscheck' | 'failed'

export interface SupersedeOutcome {
  prNumber: number
  status: SupersedeStatus
  reason?: string
}

// True once the source PR has merged. A PR closed *unmerged* is not a merge: the
// source branch is still where that finding gets addressed.
//
// The merge handler sweeps for auto-fix PRs exactly once, so a fallback auto-fix
// PR opened after that sweep is never seen by it and stays open and mergeable —
// the stale-snapshot regression this module exists to prevent. The fix step asks
// this immediately before it pushes the branch and opens the PR, which closes
// the window down to that single call.
//
// Fails open: an unreadable state returns false and the fix is delivered as
// usual. A dropped fix is invisible to everyone, whereas today's behaviour is to
// create unconditionally — so failing open is no regression, and the merge
// webhook remains the primary mechanism.
export async function sourcePRHasMerged(
  octokit: Octokit,
  owner: string,
  repo: string,
  sourcePrNumber: number,
): Promise<boolean> {
  try {
    const { data } = await octokit.rest.pulls.get({ owner, repo, pull_number: sourcePrNumber })
    return data.merged === true
  } catch {
    return false
  }
}

// Closes every open auto-fix PR cut from `sourcePrNumber`, commenting first so the
// reason survives on the timeline. Returns one outcome per candidate found, in the
// order GitHub listed them; an empty array means there was nothing cut from that PR
// (the common case).
//
// Candidates are handled concurrently — a comment+close pair is two round-trips,
// and serialising them makes every later candidate wait on all the earlier ones.
// Ordering that matters is preserved: comment still precedes close *within* a
// candidate, and Promise.all keeps the results positional.
export async function closeSupersededAutoFixPRs(
  octokit: Octokit,
  owner: string,
  repo: string,
  sourcePrNumber: number,
  mergeCommitSha: string | null,
): Promise<SupersedeOutcome[]> {
  const branch = autoFixBranchName(sourcePrNumber)
  const { data: candidates } = await octokit.rest.pulls.list({
    owner, repo, state: 'open', head: `${owner}:${branch}`,
  })

  return Promise.all(candidates.map(async (candidate): Promise<SupersedeOutcome> => {
    if (!isCrosscheckAutoFixPR(candidate.body, sourcePrNumber)) {
      return { prNumber: candidate.number, status: 'not_crosscheck' }
    }
    try {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: candidate.number,
        body: buildSupersededComment({ owner, repo, sourcePrNumber, mergeCommitSha }),
      })
      await octokit.rest.pulls.update({ owner, repo, pull_number: candidate.number, state: 'closed' })
      return { prNumber: candidate.number, status: 'closed' }
    } catch (err: unknown) {
      // Per-candidate catch, so one failure cannot reject the whole batch and
      // leave the remaining candidates unreported.
      return {
        prNumber: candidate.number,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      }
    }
  }))
}
