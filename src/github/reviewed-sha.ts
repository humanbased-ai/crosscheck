import type { Octokit } from 'octokit'

// The `sha=` field in a verdict annotation is the only machine-readable link between
// a review and the code it judged. It is read from the ephemeral clone's HEAD, which
// can hold a commit that never reached the remote — a fix commit whose push failed
// leaves the clone one commit ahead of the repo. Stamping that sha produces a verdict
// attributed to code nobody can resolve, and an APPROVE on phantom code reads as
// routine on the PR page while the BLOCK it cleared was the accurate one.
//
// Verification is done against the repo (not the clone) because the clone is exactly
// the thing under suspicion.

export type ReviewedShaStatus =
  // Resolvable and on the PR's line of history — safe to stamp.
  | 'head'          // identical to the PR head
  | 'ancestor'      // the PR head descends from it (head moved on after the review)
  | 'descendant'    // it descends from the PR head: the reviewed tree is the PR head plus
                    // commits pushed elsewhere. This is the auto-fix-branch fallback —
                    // the fix could not land on the PR branch, so it went to
                    // `fix/cr-<n>-review-issues` and the recheck ran against it. The
                    // commit is real and resolvable; readers that require the sha to
                    // equal HEAD (workflow state, step detection) already treat such a
                    // verdict as not covering HEAD.
  // Rejected:
  | 'unknown_commit'  // does not resolve in the repo at all — never pushed
  | 'diverged'        // resolves, but shares no history with the PR head
  | 'unverifiable'    // the repo could not be asked (API error)

export interface ReviewedShaVerification {
  status: ReviewedShaStatus
  /** The PR head at verification time, freshly read — `pr.head.sha` goes stale after a fix push. */
  headSha: string | null
  /** Populated for `unverifiable`, to name the API failure in the error. */
  error?: string
}

export function isVerifiedReviewedSha(status: ReviewedShaStatus): boolean {
  return status === 'head' || status === 'ancestor' || status === 'descendant'
}

export async function verifyReviewedSha(
  octokit: Octokit,
  owner: string,
  repo: string,
  pullNumber: number,
  sha: string,
): Promise<ReviewedShaVerification> {
  let headSha: string
  try {
    const { data: pull } = await octokit.rest.pulls.get({ owner, repo, pull_number: pullNumber })
    headSha = pull.head.sha
  } catch (err: unknown) {
    return { status: 'unverifiable', headSha: null, error: errorText(err) }
  }

  if (sha === headSha) return { status: 'head', headSha }

  // compareCommits with the reviewed sha as base answers both questions in one call:
  // a 404 means the sha does not resolve in this repo, and the status says how the two
  // commits are related.
  try {
    const { data: comparison } = await octokit.rest.repos.compareCommits({
      owner, repo, base: sha, head: headSha,
    })
    switch (comparison.status) {
      // 'identical' — short and long sha of the same commit.
      case 'identical':
      // 'ahead' — the head is ahead of the reviewed sha, i.e. the sha is an ancestor.
      case 'ahead':
        return { status: 'ancestor', headSha }
      // 'behind' — the head is behind the reviewed sha, i.e. the sha descends from it.
      case 'behind':
        return { status: 'descendant', headSha }
      default:
        return { status: 'diverged', headSha }
    }
  } catch (err: unknown) {
    if (statusCode(err) === 404) return { status: 'unknown_commit', headSha }
    return { status: 'unverifiable', headSha, error: errorText(err) }
  }
}

export function reviewedShaRejection(
  verification: ReviewedShaVerification,
  sha: string,
  verdict: string | null,
): string {
  const subject = `${verdict ?? 'verdict'} not posted`
  const head = verification.headSha ?? 'unknown'
  switch (verification.status) {
    case 'unknown_commit':
      return `${subject}: reviewed commit ${sha} does not exist in the repository — the reviewed tree was never pushed (PR head is ${head}). Re-run once the commit has landed.`
    case 'diverged':
      return `${subject}: reviewed commit ${sha} shares no history with the PR head ${head} — the verdict describes code this PR would not merge.`
    case 'unverifiable':
      return `${subject}: could not verify reviewed commit ${sha} against the repository — ${verification.error ?? 'unknown error'}.`
    default:
      return `${subject}: reviewed commit ${sha} failed verification.`
  }
}

function statusCode(err: unknown): number | undefined {
  const status = (err as { status?: unknown })?.status
  return typeof status === 'number' ? status : undefined
}

function errorText(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}
