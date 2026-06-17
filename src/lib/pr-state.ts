export interface ClosedPRSkip {
  status: 'merged' | 'closed'
  reason: 'pr_merged' | 'pr_closed'
}

// A merged or closed PR has nothing left to review, fix, or recheck — crosscheck
// should stop before cloning rather than run a no-op workflow against it (a merged
// PR's head is already in the base, so the effective diff is empty and the fixer
// applies nothing). merged is checked first because a merged PR is also `closed`,
// and "merged" is the clearer message.
export function closedPRSkip(pr: { merged?: boolean | null; state?: string | null }): ClosedPRSkip | null {
  if (pr.merged) return { status: 'merged', reason: 'pr_merged' }
  if (pr.state === 'closed') return { status: 'closed', reason: 'pr_closed' }
  return null
}
