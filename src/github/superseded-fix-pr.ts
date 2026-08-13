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

// Closes every open auto-fix PR cut from `sourcePrNumber`, commenting first so the
// reason survives on the timeline. Returns one outcome per candidate found; an empty
// array means there was nothing cut from that PR (the common case).
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

  const outcomes: SupersedeOutcome[] = []
  for (const candidate of candidates) {
    if (!isCrosscheckAutoFixPR(candidate.body, sourcePrNumber)) {
      outcomes.push({ prNumber: candidate.number, status: 'not_crosscheck' })
      continue
    }
    try {
      await octokit.rest.issues.createComment({
        owner, repo, issue_number: candidate.number,
        body: buildSupersededComment({ owner, repo, sourcePrNumber, mergeCommitSha }),
      })
      await octokit.rest.pulls.update({ owner, repo, pull_number: candidate.number, state: 'closed' })
      outcomes.push({ prNumber: candidate.number, status: 'closed' })
    } catch (err: unknown) {
      outcomes.push({
        prNumber: candidate.number,
        status: 'failed',
        reason: err instanceof Error ? err.message : String(err),
      })
    }
  }
  return outcomes
}
