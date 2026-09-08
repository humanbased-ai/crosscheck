import chalk from 'chalk'
import ora from 'ora'
import { createGithubClient, fetchIssueComment } from '../github/client.js'
import { getGithubToken } from '../config/loader.js'
import { getPRMergeSummary, getRepoMergeConfig, mergePullRequest, type MergeMethod } from '../github/merge.js'
import { fetchStandingVerdictRecords } from '../lib/pr-workflow-state.js'
import { selectStandingVerdict } from '../lib/no-verdict.js'
import { evaluateMergeGate, resolveStrictness, describeStrictness, standingHasBlockingFindings } from '../lib/merge-gate.js'
import { parsePRSpec } from '../lib/pr-spec.js'
import { log as fileLog, logError } from '../lib/logger.js'

export interface MergeOpts {
  loose?: boolean
  tight?: boolean
  force?: boolean
  squash?: boolean
  rebase?: boolean
  merge?: boolean
  dryRun?: boolean
}

interface CheckState {
  failing: string[]
  pending: string[]
}

/**
 * Required-check state for the commit being merged.
 *
 * Both the checks API (GitHub Actions and apps) and the statuses API (everything
 * that predates them, including crosscheck's own `crosscheck/review`) are read:
 * a repo gated only by a legacy status would otherwise look green with nothing
 * having run.
 */
async function readChecks(
  octokit: ReturnType<typeof createGithubClient>,
  owner: string,
  repo: string,
  sha: string,
): Promise<CheckState> {
  const failing: string[] = []
  const pending: string[] = []

  const runs = await octokit.paginate(octokit.rest.checks.listForRef, { owner, repo, ref: sha, per_page: 100 })
  for (const run of runs) {
    if (run.status !== 'completed') { pending.push(run.name); continue }
    // neutral and skipped are not failures; a skipped job is a job that decided
    // it had nothing to do.
    if (run.conclusion !== null && !['success', 'neutral', 'skipped'].includes(run.conclusion)) {
      failing.push(run.name)
    }
  }

  // listCommitStatusesForRef, not the combined-status API: the combined endpoint
  // caps at 100 statuses with no pagination, so a repo with more than 100 status
  // posts would silently miss the rest. This list is paginated and returns
  // newest-first, so the first entry seen per context is the latest.
  const statuses = await octokit.paginate(octokit.rest.repos.listCommitStatusesForRef, { owner, repo, ref: sha, per_page: 100 })
  const seen = new Set<string>()
  for (const status of statuses) {
    if (seen.has(status.context)) continue
    seen.add(status.context)
    if (status.state === 'pending') pending.push(status.context)
    else if (status.state === 'failure' || status.state === 'error') failing.push(status.context)
  }

  return { failing, pending }
}

function resolveMethod(opts: MergeOpts, allowed: MergeMethod[], preferred: MergeMethod): MergeMethod | { error: string } {
  const explicit = (['squash', 'rebase', 'merge'] as const).filter(m => opts[m])
  if (explicit.length > 1) {
    return { error: `--${explicit.join(' and --')} cannot be combined — pick one merge method.` }
  }
  const chosen: MergeMethod = explicit[0] ?? preferred
  if (!allowed.includes(chosen)) {
    return { error: `${describeMethod(chosen)} is not enabled on this repository (allowed: ${allowed.join(', ')}).` }
  }
  return chosen
}

function describeMethod(method: MergeMethod): string {
  return method === 'merge' ? 'A merge commit' : `A ${method} merge`
}

export async function runMerge(prUrl: string, opts: MergeOpts = {}): Promise<void> {
  const strictness = resolveStrictness(opts)
  if (typeof strictness === 'object') {
    console.error(chalk.red(`✗ ${strictness.error}`))
    process.exit(1)
  }

  let refs
  try {
    refs = parsePRSpec(prUrl)
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
  if (refs.length !== 1) {
    console.error(chalk.red('✗ crosscheck merge takes exactly one PR — merging a range in one command is not supported on purpose.'))
    process.exit(1)
  }
  const { owner, repo, number, url } = refs[0]

  const token = getGithubToken()
  const octokit = createGithubClient(token)
  const spinner = ora(`Reading ${owner}/${repo}#${number}...`).start()

  try {
    const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
    if (pr.state !== 'open') {
      spinner.info(`PR #${number} is ${pr.state} — nothing to merge`)
      return
    }
    if (pr.draft) {
      spinner.fail(`PR #${number} is a draft — mark it ready for review first`)
      process.exit(1)
    }

    const headSha: string = pr.head.sha
    const [mergeSummary, repoMerge, rawRecords, me] = await Promise.all([
      getPRMergeSummary(octokit, owner, repo, number, pr.base.ref),
      getRepoMergeConfig(octokit, owner, repo),
      fetchStandingVerdictRecords(owner, repo, number, token).catch(() => []),
      octokit.rest.users.getAuthenticated(),
    ])

    // A `crosscheck` annotation is just comment text on the PR — anything can post
    // one, including the PR author. Only a comment authored by the token that is
    // about to merge can be trusted as a real verdict; an unverifiable read
    // (deleted comment, API failure) or a mismatched author fails closed to no
    // standing verdict rather than trusting a possibly-forged one.
    const records = rawRecords.length > 0
      ? await fetchIssueComment(owner, repo, rawRecords[0].commentId, token)
          .then(c => (c && c.user.login === me.data.login ? rawRecords : []))
      : rawRecords

    const standing = selectStandingVerdict(records)
    // Only consulted at --tight, so it is not fetched for the cheaper gates.
    const checks = strictness === 'tight'
      ? await readChecks(octokit, owner, repo, headSha)
      : { failing: [], pending: [] }

    const method = resolveMethod(opts, repoMerge.allowed, repoMerge.preferred)
    if (typeof method === 'object') {
      spinner.fail(method.error)
      process.exit(1)
    }

    const gate = evaluateMergeGate({
      ...(standing?.verdict !== undefined && { verdict: standing.verdict }),
      ...(standing?.sha !== undefined && { verdictSha: standing.sha }),
      headSha,
      mergeable: mergeSummary.mergeable,
      ...(mergeSummary.mergeStateStatus !== undefined && { mergeStateStatus: mergeSummary.mergeStateStatus }),
      failingChecks: checks.failing,
      pendingChecks: checks.pending,
      hasBlockingFindings: standingHasBlockingFindings(records),
      // `records` above is already the author-verified set.
      strictness,
    })

    spinner.stop()
    console.log(`\n  ${chalk.bold(pr.title)}`)
    console.log(chalk.dim(`  ${owner}/${repo}#${number}  ${headSha.slice(0, 9)}  →  ${pr.base.ref}`))
    console.log(chalk.dim(`  gate: ${describeStrictness(strictness)}   method: ${method}`))
    console.log(chalk.dim(`  standing verdict: ${standing?.verdict ?? 'none'}${standing?.sha ? ` (${standing.sha.slice(0, 9)})` : ''}`))

    if (!gate.allowed) {
      console.log(chalk.red('\n  ✗ not merged'))
      for (const reason of gate.reasons) console.log(chalk.red(`    ${reason}`))
      fileLog({ level: 'info', event: 'merge_refused', repo: `${owner}/${repo}`, pr: number, sha: headSha, strictness, verdict: standing?.verdict, reasons: gate.reasons })
      // Exit 1: a refusal is the answer to a question, but a script that pipes
      // `crosscheck merge` must be able to branch on it without parsing prose.
      process.exit(1)
    }

    for (const s of gate.satisfied) console.log(chalk.green(`  ✓ ${s}`))
    // Forced merges carry their override in `reasons` even when allowed.
    for (const reason of gate.reasons) console.log(chalk.yellow(`  ⚠  ${reason}`))

    if (opts.dryRun) {
      console.log(chalk.dim(`\n  dry-run — would merge with method '${method}', expecting head ${headSha.slice(0, 9)}\n`))
      fileLog({ level: 'info', event: 'merge_dry_run', repo: `${owner}/${repo}`, pr: number, sha: headSha, strictness, method, verdict: standing?.verdict })
      return
    }

    const mergeSpinner = ora('Merging...').start()
    // expectedHeadSha is the load-bearing argument: GitHub rejects the merge if
    // the head moved between the gate reading it and this call, so an approval
    // can never be applied to a commit that arrived after it.
    const result = await mergePullRequest(octokit, owner, repo, number, { method, expectedHeadSha: headSha })
    if (!result.merged) {
      mergeSpinner.fail('GitHub accepted the request but did not merge the PR')
      fileLog({ level: 'error', event: 'merge_not_merged', repo: `${owner}/${repo}`, pr: number, sha: headSha, merge_sha: result.sha, strictness, method, verdict: standing?.verdict })
      process.exit(2)
    }
    mergeSpinner.succeed(`Merged as ${result.sha.slice(0, 9)}`)
    fileLog({ level: 'info', event: 'merge_completed', repo: `${owner}/${repo}`, pr: number, sha: headSha, merge_sha: result.sha, strictness, method, verdict: standing?.verdict })
    console.log(chalk.green(`\n✓ Merged — ${url}\n`))
  } catch (err: unknown) {
    spinner.stop()
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'merge' }, err)
    const message = err instanceof Error ? err.message : String(err)
    // 405 is GitHub refusing the merge itself (branch protection, required
    // reviews); 409 is the head having moved since the gate read it.
    const hint = /\b409\b/.test(message)
      ? ' — the PR head moved since the gate read it; re-run to re-evaluate against the new commit'
      : /\b405\b/.test(message)
        ? ' — GitHub refused the merge, usually branch protection or a required review'
        : ''
    console.error(chalk.red(`✗ ${message}${hint}`))
    process.exit(2)
  }
}
