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
import { loadConfig, getGithubToken, getLinearCredentials } from '../config/loader.js'
import { resolveLinearAuth, withWorker, isLinearConfigError, type ResolvedLinearAuth } from '../linear/identity.js'
import { notifyLinear } from '../linear/notify.js'
import { normalizeVendor, VENDOR_ALIAS_HINT } from '../lib/vendor.js'
import { initLogger, log as fileLog, logError } from '../lib/logger.js'
import { parseVerdict, formatVerdict, prependVerdictToComment, NULL_VERDICT_WARNING, applySeverityGate, SEVERITY_GATE_NOTE, DOC_ONLY_GATE_NOTE, detectInconclusiveReview } from '../lib/verdict.js'
import { clonePRForReview, BaseRefUnavailableError, changedFilesVsBase } from '../lib/clone.js'
import { isDocOnlyChange } from '../lib/review-strategy.js'
import { linearWritePossible, DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { prepareReviewPlan, finishReviewOrFallback, savePublishedReview, assertReviewFresh } from '../lib/review-memory.js'
import { parsePRSpec, type PRRef } from '../lib/pr-spec.js'
import { closedPRSkip } from '../lib/pr-state.js'
import { resolveCliInvocation } from '../lib/cli-invocation.js'
import { executeMultiPR, resolveRunConcurrency, printMultiPRSummary, concurrencyError, aggregateExitCode, type ConcurrencyOpts } from '../lib/multi-run.js'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'
import { checkRemoteLock, claimRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'
import { fetchStepHistoryWithRetry, identifyNextWorkflowStep } from '../lib/pr-workflow-state.js'
import { loadWorkflow } from '../lib/workflow.js'
import { filterStepsByTypes, readRepoWorkflowStepTypes } from '../lib/repo-workflow.js'
import { loadSkillCatalog } from '../skills/catalog.js'
import { createSkillActivationSession } from '../skills/broker.js'
import { formatSkillAttribution } from '../skills/attribution.js'

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

export async function runReview(prUrl: string, configPath?: string, forceReviewer?: string, force = false) {
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

  // `review` posts to the same PR as `run` and `watch`, so it answers to the same two
  // questions they do — is this commit already settled, and is anyone else on it.
  // Skipping both is how this command re-reviewed commits another instance had already
  // APPROVEd, and how it posted a second, contradicting verdict on a commit a watcher
  // was reviewing at that moment (measured on humanbased-ai/monorepo#4507).
  if (!force) {
    try {
      const repoStepOverride = readRepoWorkflowStepTypes(owner, repo)
      const globalWorkflow = loadWorkflow(process.cwd())
      const allSteps = repoStepOverride ? filterStepsByTypes(globalWorkflow, repoStepOverride) : globalWorkflow
      const history = await fetchStepHistoryWithRetry(owner, repo, number, token)
      const next = identifyNextWorkflowStep(history, allSteps, pr.head.sha, { mergeable: pr.mergeable })
      if (next.stopReason === 'approved') {
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'approved', sha: pr.head.sha })
        console.log(chalk.dim('  this commit is already approved — nothing to do until new commits land (use --force to review it anyway)'))
        return
      }
    } catch (err: unknown) {
      // Unlike run/watch this command reviews and nothing more: it cannot resume a
      // half-finished workflow or modify an approved commit, so an unreadable history
      // costs at most one redundant review comment. Warn and continue rather than
      // strand an explicit user request on a transient API failure.
      fileLog({ level: 'warn', event: 'approval_check_skipped', repo: `${owner}/${repo}`, pr: number, error: err instanceof Error ? err.message : String(err) })
      console.log(chalk.yellow('  ⚠ could not read PR history — reviewing without the approval check'))
    }
  }

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

  // Deferred to here on purpose: after the closed-PR check and reviewer routing,
  // before the clone. Resolving earlier meant a closed PR — or one routing assigns
  // no reviewer to — exited nonzero over a Linear credential it was never going to
  // use, replacing a clean skip with a failure.
  let linearAuth: ResolvedLinearAuth | null = null
  if (linearWritePossible(config.linear, [{ type: 'review' }])) {
    try {
      linearAuth = await resolveLinearAuth(config.linear, getLinearCredentials(config.linear.auth))
      fileLog({ level: 'info', event: 'linear_auth_resolved', mode: linearAuth.mode, actor: linearAuth.actor })
    } catch (err) {
      logError({ command: 'review', phase: 'linear-auth' }, err)
      console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
      process.exit(isLinearConfigError(err) ? 1 : 2)
    }
  }

  // Taken here, not earlier: everything above can still decline the PR — a closed
  // PR, routing that assigns no reviewer, an unusable Linear credential — and each
  // of those returns. Holding the lock across them would leave the lock file and a
  // pending `crosscheck/review` status behind on a PR nothing is reviewing.
  if (!acquirePRLock(owner, repo, number, pr.head.sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_local', sha: pr.head.sha })
    console.log(chalk.yellow(`⚠  PR #${number} is already being worked on by another crosscheck process — skipping`))
    return
  }
  let lockHeld = true
  // A holder rather than a bare `let`: releaseLocks closes over it, so it has to be
  // declared before the heartbeat that fills it in can start.
  const heartbeat: { stop?: () => void } = {}
  // Every exit after this point goes through here exactly once: the lock must not
  // outlive the review, and the commit status must not be resolved twice.
  const releaseLocks = async (outcome: 'success' | 'failure'): Promise<void> => {
    if (!lockHeld) return
    lockHeld = false
    heartbeat.stop?.()
    await releaseRemoteLock(octokit, owner, repo, pr.head.sha, outcome)
    releasePRLock(owner, repo, number, pr.head.sha)
  }
  try {
    if (await checkRemoteLock(octokit, owner, repo, pr.head.sha)) {
      lockHeld = false
      releasePRLock(owner, repo, number, pr.head.sha)
      fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'in_progress_remote', sha: pr.head.sha })
      console.log(chalk.yellow(`⚠  PR #${number} is already being reviewed on another machine — skipping`))
      return
    }
    if (!await claimRemoteLock(octokit, owner, repo, pr.head.sha)) {
      lockHeld = false
      releasePRLock(owner, repo, number, pr.head.sha)
      fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repo}`, pr: number, reason: 'lost_remote_claim', sha: pr.head.sha })
      console.log(chalk.yellow(`⚠  PR #${number} was claimed by another crosscheck instance — skipping`))
      return
    }
  } catch (err: unknown) {
    lockHeld = false
    releasePRLock(owner, repo, number, pr.head.sha)
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'lock' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(2)
  }
  heartbeat.stop = startRemoteLockHeartbeat(octokit, owner, repo, pr.head.sha)

  // Clone the repo into a temp dir
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  const skillSession = config.skills.enabled.length > 0
    ? createSkillActivationSession('review', config.skills.enabled, loadSkillCatalog())
    : undefined
  const spinner2 = ora('Cloning repo for review...').start()
  let reviewSpinner: ReturnType<typeof ora> | undefined

  try {
    const { baseRefStatus } = await clonePRForReview({
      owner, repo, prNumber: number, baseRef: pr.base.ref, baseSha: pr.base.sha,
      tmpDir, token, protocol: config.clone_protocol, repositoryCache: config.repository_cache,
      onProgress: line => { spinner2.text = `Cloning repo for review... ${line}` },
      onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repo}`, pr: number, base: pr.base.ref }),
      onBaseRefRecovered: status => fileLog({ level: 'info', event: 'base_ref_recovered', repo: `${owner}/${repo}`, pr: number, base: pr.base.ref, via: status }),
      onCacheFailed: message => fileLog({ level: 'warn', event: 'repository_cache_failed', repo: `${owner}/${repo}`, pr: number, error: message }),
    })
    spinner2.succeed('Repo ready')
    if (baseRefStatus === 'unavailable') {
      fileLog({ level: 'error', event: 'base_ref_unavailable', repo: `${owner}/${repo}`, pr: number, base: pr.base.ref, base_sha: pr.base.sha })
      throw new BaseRefUnavailableError(pr.base.ref)
    }
    if (baseRefStatus !== 'fetched') {
      console.log(chalk.yellow(`  base ref origin/${pr.base.ref} was missing — recovered ${baseRefStatus === 'recovered_by_sha' ? 'from the PR base commit' : "from the PR's merge ref"}`))
    }

    const memoryPlan = config.quality.review_memory ? prepareReviewPlan({
      repoDir: tmpDir, subject: `${owner}/${repo}#${number}`, baseBranch: pr.base.ref,
      instructions: DEFAULT_REVIEW_INSTRUCTIONS, policy: JSON.stringify(config.quality),
    }) : undefined
    if (memoryPlan) fileLog({ level: 'info', event: 'review_memory_plan', repo: `${owner}/${repo}`, pr: number, mode: memoryPlan.mode, reason: memoryPlan.reason })
    let reviewText: string
    let tokensUsed: number | undefined
    let model = 'default'
    let effort: string | undefined
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
        ;({ review: reviewText, tokensUsed, model, effort } = await runCodexReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.codex,
          memoryPlan?.instructions,
          msg => { reviewSpinner!.text = msg },
          codexTimeoutMs,
          undefined,
          undefined,
          skillSession,
          config.skills.codex_full_access,
        ))
      } else {
        ;({ review: reviewText, tokensUsed, model, effort } = await runClaudeReview(
          tmpDir,
          pr.base.ref,
          pr.title,
          config.quality,
          config.vendors.claude,
          config.budget.per_review_usd,
          memoryPlan?.instructions,
          msg => { reviewSpinner!.text = msg },
          claudeTimeoutMs,
          undefined,
          undefined,
          undefined,
          skillSession,
        ))
      }
    } finally {
      clearInterval(elapsedTimer)
    }

    reviewSpinner.succeed(`Review complete (${elapsed}s)`)
    const activatedSkills = skillSession?.activations() ?? []
    if (activatedSkills.length > 0) console.log(chalk.dim(`  skills: ${formatSkillAttribution(activatedSkills)}`))
    const structured = memoryPlan ? finishReviewOrFallback(memoryPlan, reviewText) : undefined
    if (structured) reviewText = structured.text
    if (structured?.adjustments?.length) {
      fileLog({ level: 'info', event: 'structured_review_reconciled', repo: `${owner}/${repo}`, pr: number, reviewer, adjustments: structured.adjustments })
    }
    if (structured?.fallbackReason) {
      fileLog({ level: 'warn', event: 'structured_review_fallback', repo: `${owner}/${repo}`, pr: number, reviewer, reason: structured.fallbackReason })
      console.log(chalk.yellow(`  structured review unusable (${structured.fallbackReason}) — posting raw output without a verdict`))
    }
    const parsed = parseVerdict(reviewText)
    const { clean } = parsed
    if (parsed.verdict === null) {
      fileLog({ level: 'warn', event: 'verdict_parse_failed', repo: `${owner}/${repo}`, pr: number, reviewer, output_length: reviewText.length })
    }
    // Inconclusive gate, ahead of the severity gate for the reason spelled out in
    // runner.ts: a findings-free non-review would otherwise be upgraded to APPROVE.
    const inconclusive = detectInconclusiveReview(clean)
    if (inconclusive.inconclusive) {
      fileLog({ level: 'error', event: 'review_inconclusive', repo: `${owner}/${repo}`, pr: number, reviewer, model, reason: inconclusive.reason, raw_verdict: parsed.verdict ?? undefined, output_length: reviewText.length })
      console.log(chalk.red(`\n✗ ${reviewer} did not review PR #${number} — ${inconclusive.reason}`))
      console.log(chalk.dim(`\n--- unposted review ---\n${clean}\n--- end ---`))
      throw new Error(`${reviewer} review inconclusive — ${inconclusive.reason}`)
    }

    // Severity gate: a NEEDS WORK review with no blocking (Critical/High) finding is
    // approved-with-comments (matches the runner's gating so both paths converge).
    // Read from the clone, not the API: a truncated file list could turn a mixed
    // PR into an apparently doc-only one, and that now caps the verdict.
    const docOnly = isDocOnlyChange(changedFilesVsBase(tmpDir, pr.base.ref)?.files ?? [])
    const gate = applySeverityGate(parsed.verdict, clean, { docOnly })
    const verdict = gate.verdict
    if (gate.downgraded) {
      fileLog({ level: 'info', event: 'verdict_severity_gated', repo: `${owner}/${repo}`, pr: number, reviewer, raw_verdict: parsed.verdict, gated_verdict: verdict, reason: gate.reason })
    }
    fileLog({ level: 'info', event: 'review_complete', repo: `${owner}/${repo}`, pr: number, reviewer, model, verdict: verdict ?? undefined, duration_ms: Date.now() - reviewStart, tokens_used: tokensUsed, skills_activated: activatedSkills.map(skill => skill.name) })
    console.log(`  ${formatVerdict(verdict)}`)
    const gateNote = gate.reason === 'doc_only' ? DOC_ONLY_GATE_NOTE : SEVERITY_GATE_NOTE
    const reviewBody = verdict === null
      ? `${NULL_VERDICT_WARNING}\n\n${clean}`
      : prependVerdictToComment(gate.downgraded ? `${gateNote}\n\n${clean}` : clean, verdict)
    if (memoryPlan) {
      const { data: current } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
      assertReviewFresh(memoryPlan, current, pr.head.sha, pr.head.sha, pr.state)
    }
    await postReviewComment(octokit, owner, repo, number, reviewBody, reviewer, config.brand, origin, verdict ?? undefined, undefined, false, model, 'review', 1, pr.head.sha, undefined, undefined, activatedSkills, effort)
    if (memoryPlan && structured?.snapshot) {
      // The review is already posted; a memory write failure only costs the next review its delta.
      try {
        if (!await savePublishedReview(memoryPlan, structured.snapshot)) fileLog({ level: 'info', event: 'review_memory_superseded', repo: `${owner}/${repo}`, pr: number })
      } catch (err) {
        fileLog({ level: 'warn', event: 'review_memory_save_failed', repo: `${owner}/${repo}`, pr: number, error: err instanceof Error ? err.message : String(err) })
      }
    }
    fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repo}`, pr: number, url: prUrl })
    console.log(chalk.green(`\n✓ Review posted to ${prUrl}\n`))

    if (linearAuth) {
      const linear = await notifyLinear({
        // Attribute to crosscheck/review rather than a flat crosscheck, so this
        // write is distinguishable from a fix or a recheck.
        auth: config.linear.identity.per_step_actor ? withWorker(linearAuth, 'review') : linearAuth,
        config: config.linear,
        pr: { branch: pr.head.ref, title: pr.title, body: pr.body ?? '', url: prUrl, sha: pr.head.sha },
        verdict,
        reviewer,
        origin,
        model,
        service: config.brand.service_name,
      })
      fileLog({
        level: linear.status === 'failed' ? 'warn' : 'info',
        event: 'linear_comment',
        repo: `${owner}/${repo}`, pr: number,
        status: linear.status, reason: linear.reason, issue: linear.identifier,
      })
      if (linear.status === 'posted') {
        console.log(chalk.dim(`  linear: commented on ${linear.identifier} (${linear.url})`))
      } else if (linear.status === 'failed') {
        // The review itself succeeded and is already on the PR — surface the Linear
        // failure without failing the run.
        console.error(chalk.yellow(`  linear: write failed — ${linear.reason}`))
      }
    }

  } catch (err: unknown) {
    spinner2.fail()
    reviewSpinner?.fail()
    const message = err instanceof Error ? err.message : String(err)
    logError({ repo: `${owner}/${repo}`, pr: number, phase: 'review' }, err)
    // Released as `failure`, not `success`: this SHA was not reviewed, and
    // `crosscheck/review` is a status a repo can require for merge — a green one
    // here would let an unreviewed HEAD satisfy branch protection.
    await releaseLocks('failure')
    console.error(chalk.red(`\n✗ ${message}`))
    process.exit(2)
  } finally {
    await releaseLocks('success')
    skillSession?.close()
    rmSync(tmpDir, { force: true, recursive: true })
  }
}

export interface ReviewSpecOpts extends ConcurrencyOpts {
  config?: string
  reviewer?: string
  /** Review this commit even when it is already approved. */
  force?: boolean
}

export function buildReviewChildArgs(ref: PRRef, opts: ReviewSpecOpts): string[] {
  const args = ['review', ref.url]
  if (opts.config) args.push('-c', opts.config)
  if (opts.reviewer) args.push('--reviewer', opts.reviewer)
  if (opts.force) args.push('--force')
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
    await runReview(refs[0].url, opts.config, opts.reviewer, opts.force)
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
