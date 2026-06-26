import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import chalk from 'chalk'
import { execa } from 'execa'
import ora from 'ora'
import { createGithubClient, postReviewComment } from '../github/client.js'
import { detectOriginFull, assignReviewer, type PROrigin } from '../github/detector.js'
import { runCodexReview } from '../reviewers/codex.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { loadConfig, getGithubToken } from '../config/loader.js'
import { normalizeVendor, VENDOR_ALIAS_HINT } from '../lib/vendor.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { parseVerdict, formatVerdict, prependVerdictToComment, NULL_VERDICT_WARNING, applySeverityGate, SEVERITY_GATE_NOTE } from '../lib/verdict.js'
import { clonePRForReview } from '../lib/clone.js'
import { parsePRSpec, type PRRef } from '../lib/pr-spec.js'
import { closedPRSkip } from '../lib/pr-state.js'
import { resolveCliInvocation } from '../lib/cli-invocation.js'
import { executeMultiPR, resolveRunConcurrency, printMultiPRSummary, concurrencyError, aggregateExitCode, type ConcurrencyOpts } from '../lib/multi-run.js'

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export async function runReview(prUrl: string, configPath?: string, forceReviewer?: string) {
  const config = loadConfig(configPath)
  initLogger(config.logs)
  fileLog({ level: 'info', event: 'session_start', command: 'review', pr_url: prUrl })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'review', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const octokit = createGithubClient(token)

  const parsed = parsePRUrl(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed

  const spinner = ora(`Fetching PR #${number}...`).start()
  const { data: pr } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
  const closedSkip = closedPRSkip(pr)
  if (closedSkip) {
    spinner.info(`PR #${number} is ${closedSkip.status} — nothing to do`)
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: closedSkip.reason })
    return
  }
  spinner.succeed(`PR #${number}: ${pr.title}`)
  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repo}`, pr: number, sha: pr.head.sha })

  let reviewer: 'claude' | 'codex' | null
  let origin: PROrigin = 'human'

  const normalizedReviewer = normalizeVendor(forceReviewer)
  if (forceReviewer !== undefined && normalizedReviewer === null) {
    console.error(chalk.red(`✗ Unknown reviewer "${forceReviewer}". Expected: ${VENDOR_ALIAS_HINT}`))
    process.exit(1)
  }

  if (normalizedReviewer !== null) {
    reviewer = normalizedReviewer
    console.log(chalk.dim(`  reviewer: ${reviewer} (forced)`))
  } else {
    const { origin: detectedOrigin, method } = await detectOriginFull(
      pr.body ?? '',
      pr.head.ref,
      owner,
      repo,
      number,
      config,
      token,
      pr.user?.login,
    )
    origin = detectedOrigin
    reviewer = await assignReviewer(origin, config)
    if (!reviewer) {
      console.log(chalk.dim(`  PR origin: ${origin} (via ${method}) — no reviewer assigned (use --reviewer ${VENDOR_ALIAS_HINT} to force)`))
      return
    }
    console.log(chalk.dim(`  PR origin: ${origin} (via ${method}) → assigned reviewer: ${reviewer}`))
  }

  // Clone the repo into a temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  const spinner2 = ora('Cloning repo for review...').start()
  let reviewSpinner: ReturnType<typeof ora> | undefined

  try {
    clonePRForReview({
      owner, repo, prNumber: number, baseRef: pr.base.ref,
      tmpDir, token, protocol: config.clone_protocol,
      onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: pr.base.ref }),
    })
    spinner2.succeed('Repo ready')

    let reviewText: string
    let tokensUsed: number | undefined
    let model = 'default'
    const reviewStart = Date.now()
    fileLog({ level: 'info', event: 'review_started', repo: `${owner}/${repo}`, pr: number, reviewer })
    let elapsed = 0
    reviewSpinner = ora(`Running ${reviewer} review...`).start()
    const elapsedTimer = setInterval(() => { elapsed++; reviewSpinner!.text = `Running ${reviewer} review... (${elapsed}s)` }, 1000)

    // Honor a per-vendor configured timeout; unset (null) → reviewer's built-in default.
    const codexTimeoutMs = config.vendors.codex.timeout_sec == null ? undefined : config.vendors.codex.timeout_sec * 1000
    const claudeTimeoutMs = config.vendors.claude.timeout_sec == null ? undefined : config.vendors.claude.timeout_sec * 1000

    try {
      if (reviewer === 'codex') {
        ;({ review: reviewText, tokensUsed, model } = await runCodexReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.codex,
          undefined,
          msg => { reviewSpinner!.text = msg },
          codexTimeoutMs,
        ))
      } else {
        ;({ review: reviewText, tokensUsed, model } = await runClaudeReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.claude,
          config.budget.per_review_usd,
          undefined,
          msg => { reviewSpinner!.text = msg },
          claudeTimeoutMs,
        ))
      }
    } finally {
      clearInterval(elapsedTimer)
    }

    reviewSpinner.succeed(`Review complete (${elapsed}s)`)
    const parsed = parseVerdict(reviewText)
    const { clean } = parsed
    if (parsed.verdict === null) {
      fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repo}`, pr: number, reviewer, output_length: reviewText.length })
    }
    // Severity gate: a NEEDS WORK review with no blocking (Critical/High) finding is
    // approved-with-comments (matches the runner's gating so both paths converge).
    const gate = applySeverityGate(parsed.verdict, clean)
    const verdict = gate.verdict
    if (gate.downgraded) {
      fileLog({ level: 'info', event: 'verdict_severity_gated', repo: `${owner}/${repo}`, pr: number, reviewer, raw_verdict: parsed.verdict, gated_verdict: verdict })
    }
    fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repo}`, pr: number, reviewer, model, verdict: verdict ?? undefined, duration_ms: Date.now() - reviewStart, tokens_used: tokensUsed })
    console.log(`  ${formatVerdict(verdict)}`)
    const commentBody = verdict === null
      ? `${NULL_VERDICT_WARNING}\n\n${clean}`
      : prependVerdictToComment(gate.downgraded ? `${SEVERITY_GATE_NOTE}\n\n${clean}` : clean, verdict)
    await postReviewComment(octokit, owner, repo, number, commentBody, reviewer, config.brand, origin, verdict ?? undefined, undefined, false, model, 'review', 1, pr.head.sha)
    fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repo}`, pr: number, url: prUrl })
    console.log(chalk.green(`\n✓ Review posted to ${prUrl}\n`))

  } catch (err: unknown) {
    spinner2.fail()
    reviewSpinner?.fail()
    const message = err instanceof Error ? err.message : String(err)
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'review' }, err)
    console.error(chalk.red(`\n✗ ${message}`))
    process.exit(2)
  } finally {
    rmSync(tmpDir, { force: true, recursive: true })
  }
}

export interface ReviewSpecOpts extends ConcurrencyOpts {
  config?: string
  reviewer?: string
}

export function buildReviewChildArgs(ref: PRRef, opts: ReviewSpecOpts): string[] {
  const args = ['review', ref.url]
  if (opts.config) args.push('-c', opts.config)
  if (opts.reviewer) args.push('--reviewer', opts.reviewer)
  return args
}

// Entry point for the `review` command. A single PR reviews in-process; multiple
// PRs fan out to concurrent `crosscheck review` subprocesses.
export async function runReviewSpec(spec: string, opts: ReviewSpecOpts = {}): Promise<void> {
  const concErr = concurrencyError(opts)
  if (concErr) {
    console.error(chalk.red(`✗ ${concErr}`))
    process.exit(1)
  }

  let refs: PRRef[]
  try {
    refs = parsePRSpec(spec)
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  if (refs.length === 1) {
    await runReview(refs[0].url, opts.config, opts.reviewer)
    return
  }

  const { concurrency, staggerMs } = resolveRunConcurrency(refs.length, opts)
  if (concurrency > 1) {
    console.log(chalk.dim(`\n  reviewing ${refs.length} PRs (${Math.min(concurrency, refs.length)} in parallel, ${staggerMs}ms stagger)`))
  } else {
    console.log(chalk.dim(`\n  reviewing ${refs.length} PRs sequentially`))
  }

  const invocation = resolveCliInvocation()
  const capture = concurrency > 1
  const dispatch = async (ref: PRRef): Promise<string | void> => {
    const args = [...invocation.args, ...buildReviewChildArgs(ref, opts)]
    if (!capture) {
      await execa(invocation.command, args, { stdio: 'inherit' })
      return
    }
    const result = await execa(invocation.command, args, { stdio: 'pipe', all: true })
    return result.all ?? ''
  }

  const results = await executeMultiPR(refs, { dispatch }, concurrency, staggerMs)
  printMultiPRSummary(results)
  process.exitCode = aggregateExitCode(results)
}
