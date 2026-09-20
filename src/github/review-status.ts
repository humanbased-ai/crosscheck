import type { Octokit } from 'octokit'
import { INSTANCE_ID } from '../lib/pr-lock.js'

const CONTEXT = 'crosscheck/review'
// Lock is stale when the process hasn't heartbeated within this window.
// Shorter = faster self-heal after a crash; must exceed HEARTBEAT_INTERVAL_MS
// by enough margin to survive a slow GitHub API round-trip.
const STALE_MS = 5 * 60 * 1000
// Heartbeat keeps the pending status fresh so long-running reviews don't look
// abandoned. Must be well under STALE_MS so a live review never goes stale.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000

// How long to let concurrent claims settle before reading back who won.
// createCommitStatus is an upsert, not a compare-and-swap — GitHub offers no
// conditional create for a commit status — so two instances can both write. The
// settle-then-read-back below is what turns that into a decision instead of two
// instances both proceeding. It must comfortably exceed a write round-trip.
const CLAIM_SETTLE_MS = 2_500

// The claim marker. Kept short: GitHub truncates a status description at 140 chars,
// and the instance id has to survive that intact to be readable on the way back.
function claimDescription(id: string): string {
  return `crosscheck ${id}`
}

/** Parse the instance id out of a claim description. Null for a foreign or legacy status. */
export function parseClaimOwner(description: string | null | undefined): string | null {
  if (!description) return null
  const m = description.match(/^crosscheck ([^\s]+)/)
  return m ? (m[1] ?? null) : null
}

interface RemoteClaim {
  state: string
  owner: string | null
  updatedAt: number
}

async function readClaim(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<RemoteClaim | null> {
  const { data } = await octokit.rest.repos.getCombinedStatusForRef({ owner, repo, ref: sha })
  const status = data.statuses
    .filter(s => s.context === CONTEXT)
    .sort((a, b) => new Date(b.updated_at).getTime() - new Date(a.updated_at).getTime())[0]
  if (!status) return null
  return {
    state: status.state,
    owner: parseClaimOwner(status.description),
    updatedAt: new Date(status.updated_at).getTime(),
  }
}

/**
 * Is another instance actively reviewing this commit?
 *
 * Our own claim does not count: a retry inside the same process must not be
 * blocked by the pending status that process itself just wrote.
 */
export async function checkRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<boolean> {
  try {
    const claim = await readClaim(octokit, owner, repo, sha)
    if (!claim || claim.state !== 'pending') return false
    if (claim.owner === INSTANCE_ID) return false
    return Date.now() - claim.updatedAt < STALE_MS
  } catch {
    return false
  }
}

export async function acquireRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): Promise<void> {
  await octokit.rest.repos.createCommitStatus({
    owner, repo, sha,
    state: 'pending',
    context: CONTEXT,
    description: `${claimDescription(INSTANCE_ID)} started ${new Date().toISOString()}`,
  })
}

/**
 * Claim the commit and confirm the claim held. Returns false when another instance
 * won, in which case this caller must not review.
 *
 * `checkRemoteLock` then `acquireRemoteLock` is a check-then-act race: two instances
 * that receive the same webhook within a round-trip of each other both see no pending
 * status, both write one, and both review the same commit — the duplicate same-SHA
 * reviews this arbitration exists to stop. GitHub has no conditional status write, so
 * instead of pretending the write was exclusive, both writers read back after a settle
 * window and only the instance whose id survived as the newest status proceeds. Last
 * write wins, deterministically, rather than nobody losing.
 *
 * This is arbitration, not a mutex: a peer writing after the read-back still gets in.
 * The window is milliseconds against a review measured in minutes, and the local lock
 * covers same-machine collisions outright.
 */
export async function claimRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  settleMs: number = CLAIM_SETTLE_MS,
): Promise<boolean> {
  await acquireRemoteLock(octokit, owner, repo, sha)
  await new Promise(resolve => setTimeout(resolve, settleMs))
  try {
    const claim = await readClaim(octokit, owner, repo, sha)
    // No claim readable, or one with no owner (a legacy status, or a description
    // GitHub truncated): nothing proves we lost, and refusing to review on an
    // unreadable status would strand the PR. Proceed — the local lock still holds.
    if (!claim || claim.owner === null) return true
    return claim.owner === INSTANCE_ID
  } catch {
    // The read-back is the optional half. Failing it leaves us exactly where the
    // old unconditional acquire always was, which is still safe enough to review.
    return true
  }
}

// Starts a repeating interval that refreshes the pending status timestamp so
// checkRemoteLock never treats an active review as stale. Returns a stop
// function that must be called in the finally block after the review completes.
export function startRemoteLockHeartbeat(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
): () => void {
  const id = setInterval(() => {
    octokit.rest.repos.createCommitStatus({
      owner, repo, sha,
      state: 'pending',
      context: CONTEXT,
      description: `${claimDescription(INSTANCE_ID)} active ${new Date().toISOString()}`,
    }).catch(() => { /* best-effort */ })
  }, HEARTBEAT_INTERVAL_MS)
  return () => clearInterval(id)
}

/**
 * Publish the review outcome and drop the claim — but only if the claim is still ours.
 *
 * Writing unconditionally let any instance clear any other instance's lock. Worse than
 * the lost mutual exclusion, `crosscheck/review` is a status a repo can require for
 * merge: a late `success` from an instance that reviewed an older commit, or one whose
 * claim was superseded, marks a commit green that nothing has actually reviewed.
 */
export async function releaseRemoteLock(
  octokit: Octokit,
  owner: string,
  repo: string,
  sha: string,
  outcome: 'success' | 'failure',
): Promise<void> {
  try {
    const claim = await readClaim(octokit, owner, repo, sha)
    // A claim owned by someone else is theirs to resolve. An unowned claim (legacy
    // or truncated) is indistinguishable from our own predecessor's, so resolve it
    // rather than leaving a pending status behind forever.
    if (claim && claim.owner !== null && claim.owner !== INSTANCE_ID) return
    await octokit.rest.repos.createCommitStatus({
      owner, repo, sha, state: outcome, context: CONTEXT,
      description: `${claimDescription(INSTANCE_ID)} ${outcome}`,
    })
  } catch { /* best-effort */ }
}
