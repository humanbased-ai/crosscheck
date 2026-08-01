// Orchestrates the one Linear write crosscheck makes: mirroring a review verdict
// onto the Linear issue the PR belongs to.
//
// This never throws. Auth is resolved up front (fail-fast, before the expensive
// review runs), so anything that goes wrong here is a per-write problem on a review
// that already succeeded and already posted to GitHub. The caller logs the returned
// status — failures are reported, never swallowed.

import { buildLinearCommentBody, shouldPostToLinear } from './comment.js'
import { findIssueByIdentifier, postLinearComment, type LinearRequestOptions } from './client.js'
import { extractLinearRef } from './ref.js'
import type { ResolvedLinearAuth } from './identity.js'
import type { LinearConfig } from '../config/schema.js'

export type LinearNotifyStatus = 'posted' | 'skipped' | 'failed'

export interface LinearNotifyResult {
  status: LinearNotifyStatus
  /** Machine-readable reason for skipped/failed. */
  reason?: string
  identifier?: string
  url?: string
}

export interface LinearNotifyParams {
  auth: ResolvedLinearAuth
  config: LinearConfig
  pr: { branch?: string; title: string; body?: string; url: string; sha?: string }
  verdict: string | null
  reviewer: string
  origin: string
  model: string
  summary?: string
  service?: string
  /** Workflow step that produced this verdict. Defaults to 'review'. */
  stepType?: string
  /** 1-based workflow round. Defaults to 1. */
  round?: number
}

// Linear issue URLs are https://linear.app/<workspace>/issue/<ID>/<slug>.
export function issueBelongsToWorkspace(issueUrl: string, workspace: string): boolean {
  try {
    const segments = new URL(issueUrl).pathname.split('/').filter(Boolean)
    return segments[0]?.toLowerCase() === workspace.toLowerCase()
  } catch {
    // Unparseable URL from the API — fail closed rather than post to the wrong place.
    return false
  }
}

export async function notifyLinear(
  params: LinearNotifyParams,
  opts: LinearRequestOptions = {},
): Promise<LinearNotifyResult> {
  const { auth, config, pr } = params

  if (!shouldPostToLinear(params.verdict, config.comment_on)) {
    return { status: 'skipped', reason: 'verdict-not-configured' }
  }

  const ref = extractLinearRef({ branch: pr.branch, title: pr.title, body: pr.body }, config.team_keys)
  if (!ref) return { status: 'skipped', reason: 'no-issue-ref' }

  try {
    const issue = await findIssueByIdentifier(auth, ref.id, opts)
    if (!issue) return { status: 'skipped', reason: 'issue-not-found', identifier: ref.id }

    // An explicit URL names a workspace, and identifiers repeat across workspaces.
    // If the credentials resolve a different workspace, this is a same-numbered
    // issue somewhere else — never the one the PR pointed at.
    if (ref.workspace && !issueBelongsToWorkspace(issue.url, ref.workspace)) {
      return { status: 'skipped', reason: 'workspace-mismatch', identifier: ref.id }
    }

    const body = buildLinearCommentBody({
      signature: auth.signature,
      verdict: params.verdict,
      reviewer: params.reviewer,
      origin: params.origin,
      model: params.model,
      prUrl: pr.url,
      prTitle: pr.title,
      ...(pr.sha && { sha: pr.sha }),
      ...(params.stepType && { stepType: params.stepType }),
      ...(params.round !== undefined && { round: params.round }),
      ...(params.summary && { summary: params.summary }),
      ...(params.service && { service: params.service }),
    })

    const comment = await postLinearComment(auth, issue.id, body, opts)
    return { status: 'posted', identifier: issue.identifier, url: comment.url }
  } catch (err: unknown) {
    return {
      status: 'failed',
      reason: err instanceof Error ? err.message : String(err),
      identifier: ref.id,
    }
  }
}
