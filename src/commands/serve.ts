import { mkdtempSync, rmSync } from 'fs'
import { tmpdir, hostname } from 'os'
import { join } from 'path'
import { execSync } from 'child_process'
import chalk from 'chalk'
import { findAvailablePort } from '../lib/port.js'
import { createWebhookServer, type PREvent } from '../github/webhook.js'
import { checkRepoAccessible, createGithubClient, getCommitMessage } from '../github/client.js'
import { acquirePRLock, releasePRLock } from '../lib/pr-lock.js'
import { checkRemoteLock, acquireRemoteLock, releaseRemoteLock, startRemoteLockHeartbeat } from '../github/review-status.js'
import { scanUnreviewedPRs, buildScopesFromConfig } from '../lib/backtrace.js'
import { detectOriginFull, assignReviewer } from '../github/detector.js'
import {
  loadConfig,
  getGithubToken,
  getWebhookSecret,
  resolveConfigPath,
  promptDeploymentMode,
  detectScopesForDeployment,
  patchDeploymentConfig,
} from '../config/loader.js'
import { randomFortune } from '../lib/fortune.js'
import { initLogger, log as fileLog, logError, logUncaught } from '../lib/logger.js'
import { isAuthorAllowed } from '../lib/filter.js'
import { runWorkflow } from '../lib/runner.js'
import { loadWorkflow, type WorkflowStep } from '../lib/workflow.js'
import { fetchStepHistory, identifyNextWorkflowStep } from '../lib/pr-workflow-state.js'
import { PRBoard, fmtTime, FMT_TIME_WIDTH } from '../lib/board.js'
import { clonePRForReview } from '../lib/clone.js'
import { PersistentShaSet } from '../lib/sha-cache.js'
import { PersistentDiffHashMap, computeDiffHash } from '../lib/diff-hash.js'
import { isCrosscheckCommitMessage } from '../lib/crosscheck-commit.js'
import { CROSSCHECK_ISSUES_URL } from '../lib/product.js'
import {
  getSmartSwitch,
  isSubscriptionLimitError,
  detectFailedVendor,
  triggerSwitch,
  notifyReviewSuccess,
  stopSmartSwitch,
} from '../lib/smart-switch.js'
import type { Config } from '../config/schema.js'

function buildFallbackConfig(config: Config, fallbackVendor: 'claude' | 'codex'): Config {
  return {
    ...config,
    mode: 'single-vendor',
    vendors: {
      codex: { ...config.vendors.codex, enabled: fallbackVendor === 'codex' },
      claude: { ...config.vendors.claude, enabled: fallbackVendor === 'claude' },
    },
  }
}

// Deduplication — keyed by owner/repo#pr@sha
const inFlight = new Set<string>()
// SHAs pushed by the address step — persisted so restarts don't review our own commits
const crosscheckShas = new PersistentShaSet()
// Last-reviewed diff hash per PR — skip reviews when a new SHA has identical diff vs base
const diffHashes = new PersistentDiffHashMap()
// PRs reviewed at least once — synchronize events on these run as recheck rounds
const reviewedPRKeys = new Set<string>()
const prRoundCounts = new Map<string, number>()
// Loaded once at startup; used to read max_rounds in handlePR
let workflow: WorkflowStep[] = []

const NOISE_EXT = /\.(lock|snap|min\.js|min\.css|csv|json|png|jpg|jpeg|gif|svg|mp4|woff2?|ttf|eot|ico|pdf)$/i

function computePRLoc(tmpDir: string, baseBranch: string): number {
  try {
    const stat = execSync(`git diff --stat origin/${baseBranch}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
    let total = 0
    for (const line of stat.split('\n')) {
      const m = line.match(/^\s+(.+?)\s+\|\s+(\d+)/)
      if (!m) continue
      const file = m[1].trim().replace(/\{.*?=> /, '').replace('}', '')
      if (!NOISE_EXT.test(file)) total += parseInt(m[2], 10)
    }
    return total
  } catch {
    return 0
  }
}

async function handlePR(event: PREvent, config: ReturnType<typeof loadConfig>, token: string, board: PRBoard) {
  const { pull_request: pr, repository: repo } = event
  const owner = repo.owner.login
  const repoName = repo.name
  const prNumber = event.number
  const key = `${owner}/${repoName}#${prNumber}@${pr.head.sha}`

  if (inFlight.has(key)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'duplicate' })
    return
  }

  if (event.action === 'synchronize') {
    const message = await getCommitMessage(owner, repoName, pr.head.sha, token).catch(() => null)
    if (message !== null && isCrosscheckCommitMessage(message)) {
      fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_commit', sha: pr.head.sha })
      return
    }
  }

  if (crosscheckShas.has(pr.head.sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'crosscheck_sha', sha: pr.head.sha })
    return
  }

  inFlight.add(key)

  const author = pr.user.login

  if (!isAuthorAllowed(config.routing.allowed_authors, author)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'author_not_allowed', author })
    inFlight.delete(key)
    return
  }

  const { origin, method: originMethod } = await detectOriginFull(
    pr.body ?? '', pr.head.ref,
    owner, repoName, prNumber,
    config, token, pr.user.login,
  )

  // Smart-switch: when cross-vendor is degraded, override to single-vendor with the healthy vendor
  const ss = getSmartSwitch()
  const announce = (l1: string, l2?: string) => { board.log(l1, l2); fileLog({ level: 'info', event: 'message', message: l2 ? `${l1} ${l2}` : l1 }) }
  const effectiveConfig = (config.mode === 'cross-vendor' && ss.active && ss.fallbackVendor)
    ? buildFallbackConfig(config, ss.fallbackVendor)
    : config

  const reviewer = await assignReviewer(origin, effectiveConfig)

  fileLog({ level: 'info', event: 'pr_received', repo: `${owner}/${repoName}`, pr: prNumber, sha: pr.head.sha, action: event.action, origin, origin_method: originMethod, author, smart_switch_active: ss.active })

  const ts = chalk.dim(fmtTime())
  const tsIndent = ' '.repeat(FMT_TIME_WIDTH + 2)

  if (!reviewer) {
    board.log(
      `${ts}  PR #${prNumber} ${event.action}  ${chalk.dim(pr.title)}`,
      `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  no reviewer — skipping`,
    )
    inFlight.delete(key)
    return
  }

  const modeNote = ss.active ? chalk.yellow(' [smart-switch]') : ''
  board.log(
    `${ts}  PR #${prNumber} ${event.action}  ${chalk.dim(pr.title)}`,
    `${tsIndent}origin=${chalk.yellow(origin)}  via=${chalk.dim(originMethod)}  reviewer=${chalk.cyan(reviewer)}${modeNote}`,
  )

  if (!acquirePRLock(owner, repoName, prNumber, pr.head.sha)) {
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'in_progress_local' })
    inFlight.delete(key)
    return
  }

  const lockOctokit = createGithubClient(token)
  if (await checkRemoteLock(lockOctokit, owner, repoName, pr.head.sha)) {
    releasePRLock(owner, repoName, prNumber, pr.head.sha)
    fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'in_progress_remote' })
    inFlight.delete(key)
    return
  }
  try {
    await acquireRemoteLock(lockOctokit, owner, repoName, pr.head.sha)
  } catch (err: unknown) {
    releasePRLock(owner, repoName, prNumber, pr.head.sha)
    inFlight.delete(key)
    logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'lock' }, err)
    return
  }

  const prKey = `${owner}/${repoName}#${prNumber}`

  // Determine the correct starting step from PR comment history so serve
  // behaves correctly after a restart (reviewedPRKeys is in-memory only).
  // Fast-path: if the PR was reviewed in this session, skip the API call.
  let isRecheckRun = reviewedPRKeys.has(prKey)
  let round = isRecheckRun ? (prRoundCounts.get(prKey) ?? 1) + 1 : 1
  let resolvedSteps: WorkflowStep[] | undefined
  let detectedReviewComment: { id?: number; body: string } | undefined

  if (!isRecheckRun) {
    try {
      const allSteps = loadWorkflow(process.cwd())
      const history = await fetchStepHistory(owner, repoName, prNumber, token)
      const nextResult = identifyNextWorkflowStep(history, allSteps, pr.head.sha)
      if (nextResult.step === null) {
        await releaseRemoteLock(lockOctokit, owner, repoName, pr.head.sha, 'success')
        releasePRLock(owner, repoName, prNumber, pr.head.sha)
        inFlight.delete(key)
        fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'workflow_complete', sha: pr.head.sha })
        return
      }
      if (nextResult.hasExistingReview) {
        isRecheckRun = nextResult.step.type !== 'review'
        round = nextResult.round
        detectedReviewComment = nextResult.reviewComment
        const nextStepIdx = allSteps.findIndex(s => s.type === nextResult.step!.type)
        if (nextStepIdx >= 0) resolvedSteps = allSteps.slice(nextStepIdx)
      }
    } catch { /* best-effort — fall back to session-based detection */ }
  }

  const reviewStart = Date.now()
  const tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  let stopHeartbeat = () => {}
  let boardAdded = false

  try {
    clonePRForReview({
      owner, repo: repoName, prNumber, baseRef: pr.base.ref,
      tmpDir, token, protocol: config.clone_protocol,
      onBaseFetchFailed: () => fileLog({ level: 'warn', event: 'base_branch_fetch_skipped', repo: `${owner}/${repoName}`, pr: prNumber, base: pr.base.ref }),
    })

    let newDiffHash: string | null = null
    try {
      newDiffHash = computeDiffHash(tmpDir, pr.base.ref)
    } catch { /* base unavailable — proceed with full review, skip cache update */ }

    const prev = newDiffHash ? diffHashes.get(prKey) : undefined
    if (newDiffHash && prev && prev.hash === newDiffHash && prev.sha !== pr.head.sha) {
      const prevShort = prev.sha.slice(0, 7)
      const nowShort = pr.head.sha.slice(0, 7)
      fileLog({ level: 'info', event: 'pr_skipped', repo: `${owner}/${repoName}`, pr: prNumber, reason: 'no_diff_change', sha: pr.head.sha, prev_sha: prev.sha })
      board.log(
        `${chalk.dim(fmtTime())}  PR #${prNumber} ${event.action}  ${chalk.dim('no diff change since last review')}`,
        `${' '.repeat(FMT_TIME_WIDTH + 2)}prev=${chalk.dim(prevShort)} → ${chalk.dim(nowShort)}  ${chalk.dim('(skipped)')}`,
      )
      try {
        await lockOctokit.rest.issues.createComment({
          owner, repo: repoName, issue_number: prNumber,
          body: `✓ No diff change since the last review (was \`${prevShort}\`, now \`${nowShort}\`). Skipping re-review.\n\n<!-- crosscheck: no_diff_change prev_sha=${prev.sha} sha=${pr.head.sha} -->`,
        })
        fileLog({ level: 'info', event: 'comment_posted', repo: `${owner}/${repoName}`, pr: prNumber, kind: 'no_diff_change' })
      } catch (err: unknown) {
        logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'no_diff_comment' }, err)
      }
      await releaseRemoteLock(lockOctokit, owner, repoName, pr.head.sha, 'success')
      return
    }

    board.addPR(key, prNumber, `${owner}/${repoName}`, pr.head.ref, round)
    boardAdded = true

    const prLoc = computePRLoc(tmpDir, pr.base.ref)
    board.updatePR(key, { prLoc })
    stopHeartbeat = startRemoteLockHeartbeat(lockOctokit, owner, repoName, pr.head.sha)

    await runWorkflow({
      owner, repoName, prNumber, pr,
      tmpDir, token, config: effectiveConfig, origin,
      reviewStart,
      log: (msg: string) => board.log(`${chalk.dim(fmtTime())}  ${msg}`),
      onPhaseChange: (label, data) => board.updatePR(key, { label, ...data }),
      crosscheckShas,
      smartSwitchFallback: (ss.active && ss.fallbackVendor) ? ss.fallbackVendor : undefined,
      onVendorLimit: (failedVendor, fallbackVendor, reason) => {
        if (config.mode === 'cross-vendor' && fallbackVendor !== null && !getSmartSwitch().active) {
          triggerSwitch(failedVendor, reason, announce)
        }
      },
      ...(resolvedSteps !== undefined && { steps: resolvedSteps }),
      ...(detectedReviewComment !== undefined && { initialReviewComment: detectedReviewComment }),
      isRecheckRun,
      round,
      trigger: event.action === 'backtrace' ? 'backtrace' : 'serve',
    })

    reviewedPRKeys.add(prKey)
    prRoundCounts.set(prKey, round)
    if (newDiffHash) {
      let reviewedHash: string | null = null
      try {
        reviewedHash = computeDiffHash(tmpDir, pr.base.ref)
      } catch { /* base unavailable post-workflow — skip cache update */ }
      if (reviewedHash) diffHashes.upsert(prKey, { sha: pr.head.sha, hash: reviewedHash })
    }
    board.completePR(key, {
      elapsedMs: Date.now() - reviewStart,
      url: `github.com/${owner}/${repoName}/pull/${prNumber}`,
    })
    notifyReviewSuccess(reviewer, announce)
    stopHeartbeat()
    await releaseRemoteLock(lockOctokit, owner, repoName, pr.head.sha, 'success')
  } catch (err: unknown) {
    stopHeartbeat()
    const message = err instanceof Error ? err.message : (err as { message?: string }).message ?? 'unknown error'
    if (boardAdded) board.failPR(key, message)
    logError({ repo: `${owner}/${repoName}`, pr: prNumber, phase: 'review' }, err)
    await releaseRemoteLock(lockOctokit, owner, repoName, pr.head.sha, 'failure')
    if (config.mode === 'cross-vendor' && !getSmartSwitch().active && isSubscriptionLimitError(err)) {
      const failedVendor = detectFailedVendor(err)
      if (failedVendor) triggerSwitch(failedVendor, message, announce)
    }
  } finally {
    releasePRLock(owner, repoName, prNumber, pr.head.sha)
    rmSync(tmpDir, { force: true, recursive: true })
    inFlight.delete(key)
  }
}

export interface ServeOpts {
  config?: string
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
  port?: number
  backtrace?: boolean
}

export async function runServe(opts: ServeOpts = {}) {
  const configPath = opts.config
  let config = loadConfig(configPath)
  // --port forces the webhook server port for this session only (no config write).
  // Unlike the default auto-shift, a forced port is used verbatim below.
  if (opts.port !== undefined) {
    config = { ...config, server: { ...config.server, port: opts.port } }
  }
  initLogger(config.logs)

  process.on('uncaughtException', (err) => {
    logUncaught('uncaughtException', err)
    console.error(chalk.red(`\n✗ Uncaught exception: ${err.message}`))
    process.exit(2)
  })
  process.on('unhandledRejection', (reason) => {
    logUncaught('unhandledRejection', reason)
    console.error(chalk.red(`\n✗ Unhandled rejection: ${reason instanceof Error ? reason.message : String(reason)}`))
    process.exit(2)
  })

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    logError({ command: 'serve', phase: 'auth' }, err)
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  fileLog({ level: 'info', event: 'session_start', command: 'serve' })

  const board = new PRBoard()
  workflow = loadWorkflow(process.cwd())
  board.setConfig(config, workflow)

  // ── Deployment setup ─────────────────────────────────────────────────────
  let effectiveDeployment: 'personal' | 'team' | undefined = config.deployment
  let sessionOnly = false

  if (opts.personal || opts.team) {
    effectiveDeployment = opts.personal ? 'personal' : 'team'
    sessionOnly = true
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    config = { ...config, users: detected.users, orgs: detected.orgs, repos: [] }
  } else if (opts.reconfigure || !config.deployment) {
    effectiveDeployment = await promptDeploymentMode(opts.reconfigure ? config.deployment : undefined)
    const cfgPath = resolveConfigPath(configPath) ?? join(process.cwd(), 'crosscheck.config.yml')
    const detected = await detectScopesForDeployment(effectiveDeployment, token)
    patchDeploymentConfig(cfgPath, effectiveDeployment, detected.login, detected.orgs, !!opts.reconfigure)
    config = loadConfig(configPath)
    // Re-apply the session port override — loadConfig re-read the file, dropping it.
    if (opts.port !== undefined) {
      config = { ...config, server: { ...config.server, port: opts.port } }
    }
    console.log(`\n  ${chalk.green('✓')} deployment set to ${chalk.cyan(effectiveDeployment)} ${chalk.dim(`(saved to ${cfgPath})`)}`)
  }

  // ── Repo accessibility validation ─────────────────────────────────────────
  const repoChecks = await Promise.all(
    config.repos.map(async ({ owner, name }) => ({
      owner, name,
      ok: await checkRepoAccessible(owner, name, token).catch(() => false),
    }))
  )
  for (const { owner, name, ok } of repoChecks) {
    if (!ok) {
      console.log(chalk.yellow(`  ✗ repo not accessible: ${owner}/${name} — skipped`))
      fileLog({ level: 'warn', event: 'repo_inaccessible', repo: `${owner}/${name}` })
    }
  }

  const webhookSecret = getWebhookSecret()

  const server = createWebhookServer(
    config,
    webhookSecret,
    (event) => { void handlePR(event, config, token, board) },
    (msg: string) => board.log(chalk.dim(new Date().toLocaleTimeString()) + '  ' + msg),
    fileLog,
  )

  // A forced --port is used verbatim (fail if busy). Without it, serve auto-shifts
  // to the next free port so an incidental clash doesn't stop the daemon.
  let effectivePort: number
  if (opts.port !== undefined) {
    effectivePort = config.server.port
  } else {
    try {
      effectivePort = await findAvailablePort(config.server.port)
    } catch (err) {
      console.error(chalk.red(`\n✗ ${err instanceof Error ? err.message : String(err)}`))
      process.exit(1)
    }
    if (effectivePort !== config.server.port) {
      console.log(chalk.yellow(`  ⚠  Port ${config.server.port} in use — using port ${effectivePort} instead`))
      config = { ...config, server: { ...config.server, port: effectivePort } }
    }
  }

  // With a forced --port there is no auto-shift, so a clash is fatal. Convert the
  // async EADDRINUSE emit into a clean exit 1 instead of an uncaught exception.
  if (opts.port !== undefined) {
    server.on('error', (err: NodeJS.ErrnoException) => {
      const msg = err.code === 'EADDRINUSE'
        ? `Port ${effectivePort} is already in use. Free it or pass a different --port.`
        : err.message
      console.error(chalk.red(`\n✗ ${msg}`))
      process.exit(1)
    })
  }

  server.listen(effectivePort, () => {
    const webhookUrl = `http://${hostname()}:${effectivePort}${config.server.webhook_path}`
    console.log(chalk.dim(`\n  "${randomFortune()}"\n`))
    console.log(chalk.bold('crosscheck serving\n'))
    console.log(chalk.yellow(`  ⚠  serve is in beta — report issues at ${CROSSCHECK_ISSUES_URL}\n`))
    if (effectiveDeployment) {
      const label = sessionOnly
        ? chalk.dim(`${effectiveDeployment} (session only — not saved)`)
        : chalk.cyan(effectiveDeployment)
      console.log(`  deployment  ${label}`)
    }
    if (config.orgs.length > 0) {
      console.log(`  orgs        ${chalk.cyan(config.orgs.join(', '))}`)
    }
    console.log(`  mode        ${chalk.cyan(config.mode)}`)
    console.log(`  quality     ${chalk.cyan(config.quality.tier)}`)
    console.log(`  port        ${chalk.cyan(String(config.server.port))}`)
    console.log(`  endpoint    ${chalk.cyan(webhookUrl)}`)
    const cfgPath = resolveConfigPath(configPath)
    console.log(`  config      ${chalk.dim(cfgPath ?? 'none (using defaults)')}`)
    if (effectiveDeployment === 'team' && config.routing.allowed_authors.length === 0) {
      console.log(`  authors     ${chalk.dim('all PRs (team mode)')}`)
    } else if (config.routing.allowed_authors.length > 0) {
      console.log(`  authors     ${chalk.cyan(config.routing.allowed_authors.join(', '))}`)
    } else {
      console.log()
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('No author filter set — all PRs in monitored orgs/repos will be reviewed.')}`)
      console.log(`     ${chalk.dim('Run')} ${chalk.cyan('crosscheck serve --reconfigure')} ${chalk.dim('to set up a deployment mode.')}`)
    }

    // Warn when author_routes will be silently bypassed (cross-vendor + both vendors enabled).
    const bothVendorsEnabled = config.mode === 'cross-vendor'
      && config.vendors.claude.enabled
      && config.vendors.codex.enabled
    const routedAllowedAuthors = bothVendorsEnabled
      ? Object.entries(config.routing.author_routes).filter(([login]) =>
          config.routing.allowed_authors.length === 0 || config.routing.allowed_authors.includes(login)
        )
      : []
    if (routedAllowedAuthors.length > 0) {
      console.log()
      console.log(`  ${chalk.yellow('⚠')}  ${chalk.yellow('author_routes bypassed in cross-vendor mode (both vendors enabled).')}`)
      for (const [login, vendor] of routedAllowedAuthors) {
        console.log(`     ${chalk.dim(`${login} → ${vendor}`)}`)
      }
      console.log(`     ${chalk.dim('PRs without attribution markers fall through to')} ${chalk.cyan(`fallback_reviewer: ${config.routing.fallback_reviewer ?? 'skip'}`)} ${chalk.dim('instead.')}`)
    }

    console.log()
    console.log(chalk.dim('Register the endpoint above as a GitHub webhook (content-type: application/json).'))
    if (config.orgs.length > 0) {
      for (const org of config.orgs) {
        console.log(chalk.dim(`  → https://github.com/organizations/${org}/settings/hooks`))
      }
    }
    console.log(chalk.dim('Listening for pull_request events...\n'))

    // Backtrace: find open PRs that haven't been reviewed yet
    if (opts.backtrace === true || (opts.backtrace !== false && config.backtrace.enabled)) {
      void (async () => {
        try {
          board.log('backtrace: scanning open PRs in monitored scope...')
          fileLog({ level: 'info', event: 'backtrace_start' })
          const backtraceScopes = await buildScopesFromConfig(config, token)
          const { queued, alreadyReviewed, skippedAuthor } = await scanUnreviewedPRs(backtraceScopes, config, token)
          if (queued.length === 0) {
            board.log('backtrace: no unreviewed open PRs found')
          } else {
            const parts = [`${queued.length} PR${queued.length !== 1 ? 's' : ''} queued`]
            if (alreadyReviewed > 0) parts.push(`${alreadyReviewed} already reviewed`)
            if (skippedAuthor > 0) parts.push(`${skippedAuthor} skipped (author filter)`)
            board.log(`backtrace: ${parts.join(', ')}`)
          }
          fileLog({ level: 'info', event: 'backtrace_complete', queued: queued.length, already_reviewed: alreadyReviewed, skipped_author: skippedAuthor })
          void Promise.all(queued.map(pr => handlePR({
            action: 'backtrace',
            number: pr.number,
            pull_request: {
              title: pr.title,
              body: pr.body ?? '',
              head: { ref: pr.headRef, sha: pr.headSha, repo: pr.headRepo ? { full_name: pr.headRepo } : null },
              base: { ref: pr.baseRef, repo: { full_name: `${pr.owner}/${pr.repo}` } },
              html_url: `https://github.com/${pr.owner}/${pr.repo}/pull/${pr.number}`,
              user: { login: pr.author },
            },
            repository: {
              name: pr.repo,
              owner: { login: pr.owner },
              clone_url: `https://github.com/${pr.owner}/${pr.repo}.git`,
            },
          }, config, token, board)))
        } catch (err: unknown) {
          const msg = err instanceof Error ? err.message : String(err)
          board.log(`backtrace: scan failed — ${msg}`)
          fileLog({ level: 'warn', event: 'backtrace_error', message: msg })
        }
      })()
    }


    board.setTunnel('serve', webhookUrl, true)
    board.start()
  })

  process.on('SIGINT', () => {
    board.stop()
    stopSmartSwitch()
    console.log('\nShutting down...')
    fileLog({ level: 'info', event: 'session_end', command: 'serve' })
    server.close(() => process.exit(0))
  })
}
