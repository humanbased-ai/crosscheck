#!/usr/bin/env node
import { Command, Option, InvalidArgumentError } from 'commander'
import chalk from 'chalk'
import { parsePort } from './lib/port.js'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { basename, dirname, join } from 'path'
import { runInit } from './commands/init.js'
import { runOnboard } from './commands/onboard.js'
import { runAlter } from './commands/alter.js'
import { runWatch } from './commands/watch.js'
import { runReviewSpec } from './commands/review.js'
import { runStatus } from './commands/status.js'
import { runDiagnose } from './commands/diagnose.js'
import { runOptimize } from './commands/optimize.js'
import { runImpact } from './commands/impact.js'
import { runIssue } from './commands/issue.js'
import { runRunSpec, runRecheckSpec, runFixSpec, runResolveSpec, type RunSpecOpts } from './commands/run.js'
import { runDetectStep } from './commands/detect-step.js'
import { runLinearTest } from './commands/linear-test.js'
import { isLinearConfigError } from './linear/identity.js'
import { runScan } from './commands/scan.js'
import { runKickass } from './commands/kickass.js'
import { runSkillInstall } from './commands/skill.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const { version } = JSON.parse(readFileSync(join(__dirname, '../package.json'), 'utf8')) as { version: string }

const invokedAs = basename(process.argv[1] ?? 'crosscheck').replace(/\.js$/, '')
const programName = invokedAs === 'ck' ? 'ck' : 'crosscheck'

// Commander arg parser for --port: validate at parse time so bad values exit 1
// through Commander's InvalidArgumentError path before any command runs.
const portParser = (raw: string): number => {
  try {
    return parsePort(raw)
  } catch (err) {
    throw new InvalidArgumentError(err instanceof Error ? err.message : String(err))
  }
}

const program = new Command()

program
  .name(programName)
  .description('Cross-vendor AI code review — Claude Code ↔ Codex')
  .version(`❤️  ${version}`)

// Flags shared by the run-family commands (run, recheck, fix, resolve).
interface StepRunFlags {
  config?: string
  reviewer?: string
  fixer?: string
  vendor?: string
  steps?: string
  reviewOnly?: boolean
  dryRun?: boolean
  expectedHeadSha?: string
  crazy?: boolean
  halfCrazy?: boolean
  halfcrazy?: boolean
  timeout?: string | false
  noTimeout?: boolean
  trigger?: string
  concurrent?: string | true
  sequential?: boolean
  stagger?: string
}

function addStepRunOptions(cmd: Command): Command {
  return cmd
    .option('-c, --config <path>', 'config file path')
    .option('-r, --reviewer <vendor>', 'force a specific reviewer: codex | claude')
    .option('--fixer <vendor>', 'force a specific fixer for fix steps: codex | claude')
    .option('--vendor <vendor>', 'force one vendor for review, recheck, and fix steps')
    .option('--dry-run', 'run but do not post a comment or apply fixes')
    .option('--crazy', 'loop fix→recheck until APPROVE; disables all timeout constraints')
    .option('--half-crazy', 'loop fix→recheck until verdict is not BLOCK; disables all timeout constraints')
    .option('--halfcrazy', '(deprecated alias for --half-crazy)')
    .option('--timeout <duration>', 'reviewer subprocess timeout, e.g. 300s or 10m')
    .option('--no-timeout', 'remove the reviewer subprocess timeout cap (implied by --crazy/--half-crazy)')
    .option('--concurrent [n]', 'multi-PR: cap parallel agents; omit n for one agent per PR (default)')
    .option('--sequential', 'multi-PR: run PRs one at a time instead of in parallel')
    .option('--stagger <ms>', 'multi-PR: ms delay between concurrent worker starts; default 2000')
    .addOption(new Option('--trigger <source>').hideHelp())  // internal: set by kickass/watch
}

function buildRunSpecOpts(opts: StepRunFlags): RunSpecOpts {
  const roundMode = opts.crazy ? 'crazy' : (opts.halfCrazy || opts.halfcrazy) ? 'halfcrazy' : undefined
  // Commander sets opts.timeout = false (not opts.noTimeout) when --no-timeout is passed
  const noTimeout = opts.noTimeout || opts.timeout === false
  const trigger = (opts.trigger as import('./lib/runner.js').WorkflowTrigger | undefined) ?? 'run'
  const concurrent = opts.concurrent === undefined ? undefined : opts.concurrent === true ? 0 : Number(opts.concurrent)
  const staggerMs = opts.stagger !== undefined ? Number(opts.stagger) : undefined
  return {
    config: opts.config,
    reviewer: opts.reviewer,
    fixer: opts.fixer,
    vendor: opts.vendor,
    steps: opts.reviewOnly ? 'review' : opts.steps,
    dryRun: opts.dryRun,
    expectedHeadSha: opts.expectedHeadSha,
    roundMode,
    noTimeout,
    timeout: typeof opts.timeout === 'string' ? opts.timeout : undefined,
    trigger,
    concurrent,
    sequential: opts.sequential,
    staggerMs,
  }
}

program
  .command('init')
  .description('Check environment, verify CLI auth, write starter config')
  .option('-c, --config <path>', 'path to write config file')
  .action((opts: { config?: string }) => runInit(opts.config))

program
  .command('onboard')
  .description('Guided setup — select repos to monitor and write config')
  .option('-c, --config <path>', 'config file path to write')
  .option('-y, --yes', 'skip confirmation prompts, accept defaults')
  .option('--personal', 'pre-select personal deployment mode, skip persona prompt')
  .option('--team', 'pre-select team deployment mode, skip persona prompt')
  .option('--reconfigure', 're-run setup (accepted for compatibility; onboard always reconfigures)')
  .action((opts: { config?: string; yes?: boolean; personal?: boolean; team?: boolean; reconfigure?: boolean }) => void runOnboard(opts))

program
  .command('alter <repo>')
  .alias('alter-workflow')
  .description('Set a per-repo workflow override (writes ~/.crosscheck/workflows/<owner>__<repo>.yml)')
  .option('--steps <list>', 'repo workflow depth: review, review,fix, review,recheck, or review,fix,recheck')
  .option('--review-only', 'alias for --steps review')
  .option('--reset', 'remove the per-repo override; revert to the global workflow')
  .option('--show', 'print the repo\'s effective workflow steps without writing')
  .action((repo: string, opts: { steps?: string; reviewOnly?: boolean; reset?: boolean; show?: boolean }) => runAlter(repo, opts))

program
  .command('watch')
  .description('Local dev mode — listen for PRs via gh webhook forward')
  .option('-c, --config <path>', 'config file path')
  .option('--personal', 'personal mode this session only (does not save to config)')
  .option('--team', 'team mode this session only (does not save to config)')
  .option('--reconfigure', 're-run deployment setup and save new choice to config')
  .option('--port <number>', 'force the webhook server port for this session (overrides config; does not save)', portParser)
  .option('--backtrace', 'enable startup scan for unreviewed open PRs this session (overrides backtrace.enabled: false)')
  .option('--no-backtrace', 'skip startup scan for unreviewed open PRs this session (overrides backtrace.enabled: true)')
  .action((opts: { config?: string; personal?: boolean; team?: boolean; reconfigure?: boolean; port?: number; backtrace?: boolean }) => void runWatch(opts))

program
  .command('review <pr-urls...>')
  .description('Trigger a review for one or more PRs. Accepts comma-separated URLs, bare numbers, and ranges (e.g. .../pull/245,255 or .../pull/245-256)')
  .option('-c, --config <path>', 'config file path')
  .option('-r, --reviewer <vendor>', 'force a specific reviewer: codex | claude (bypasses auto-detection)')
  .option('--vendor <vendor>', 'alias for --reviewer')
  .option('--concurrent [n]', 'multi-PR: cap parallel agents; omit n for one agent per PR (default)')
  .option('--sequential', 'multi-PR: run PRs one at a time instead of in parallel')
  .option('--stagger <ms>', 'multi-PR: ms delay between concurrent worker starts; default 2000')
  .action((prUrls: string[], opts: { config?: string; reviewer?: string; vendor?: string; concurrent?: string | true; sequential?: boolean; stagger?: string }) => {
    const concurrent = opts.concurrent === undefined ? undefined : opts.concurrent === true ? 0 : Number(opts.concurrent)
    const staggerMs = opts.stagger !== undefined ? Number(opts.stagger) : undefined
    void runReviewSpec(prUrls.join(','), { config: opts.config, reviewer: opts.reviewer ?? opts.vendor, concurrent, sequential: opts.sequential, staggerMs })
  })

addStepRunOptions(
  program
    .command('run <pr-urls...>')
    .description('Execute the full configured workflow against one or more PRs (review → fix → recheck). Accepts comma-separated URLs, bare numbers, and ranges (e.g. .../pull/245,255 or .../pull/245-256)'),
)
  .option('--steps <list>', 'run only these step types, comma-separated: review,fix,recheck')
  .option('--review-only', 'alias for --steps review (this run only)')
  .option('--expected-head-sha <sha>', 'skip if the PR head changed since selection (single PR only)')
  .action((prUrls: string[], opts: StepRunFlags) => {
    // --review-only is an alias for --steps review; reject a conflicting --steps
    // rather than silently ignoring it (mirrors `crosscheck alter`).
    if (opts.reviewOnly && opts.steps) {
      const normalized = opts.steps.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).join(',')
      if (normalized !== 'review') {
        console.error('error: --review-only cannot be combined with --steps unless --steps is review')
        process.exit(1)
      }
    }
    void runRunSpec(prUrls.join(','), buildRunSpecOpts(opts))
  })

addStepRunOptions(
  program
    .command('recheck <pr-urls...>')
    .description('Force the recheck step against one or more PRs (re-evaluate against the latest review). Accepts comma-separated URLs, bare numbers, and ranges'),
).action((prUrls: string[], opts: StepRunFlags) => void runRecheckSpec(prUrls.join(','), buildRunSpecOpts(opts)))

addStepRunOptions(
  program
    .command('fix <pr-urls...>')
    .description('Force the fix step against one or more PRs (apply fixes for the latest review). Accepts comma-separated URLs, bare numbers, and ranges'),
).action((prUrls: string[], opts: StepRunFlags) => void runFixSpec(prUrls.join(','), buildRunSpecOpts(opts)))

addStepRunOptions(
  program
    .command('resolve <pr-urls...>')
    .description('Force the conflict-resolve step against one or more PRs (resolve merge conflicts). Accepts comma-separated URLs, bare numbers, and ranges'),
).action((prUrls: string[], opts: StepRunFlags) => void runResolveSpec(prUrls.join(','), buildRunSpecOpts(opts)))

program
  .command('detect-step <pr-url>')
  .description('Show the crosscheck step history for a PR and identify the next step to run')
  .option('-c, --config <path>', 'config file path')
  .option('--json', 'emit result as JSON')
  .action((prUrl: string, opts: { config?: string; json?: boolean }) => void runDetectStep(prUrl, opts))

program
  .command('linear-test [issue]')
  .description('Dry-run Linear write-back: verify identity, resolve an issue, print the comment (posts nothing)')
  .option('-c, --config <path>', 'config file path')
  .option('--branch <name>', 'resolve the issue from a branch name instead of naming it')
  .option('--title <text>', 'resolve the issue from a PR title instead of naming it')
  .option('--verdict <verdict>', 'verdict to preview (APPROVE, NEEDS_WORK, BLOCK)')
  .action((issue: string | undefined, opts: { config?: string; branch?: string; title?: string; verdict?: string }) => {
    // `void` on its own leaves a rejection unhandled — the process would print a
    // Node warning and exit 0 instead of reporting the failure.
    runLinearTest(issue, opts).catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err)
      console.error(chalk.red(`✗ ${message}`))
      // A malformed identifier is a typo in the argument the user just supplied,
      // so it is a user error like a missing credential — not an unexpected one.
      const userError = isLinearConfigError(err) || /Malformed Linear issue identifier/.test(message)
      process.exit(userError ? 1 : 2)
    })
  })

program
  .command('scan')
  .description('Scan monitored open PRs and show stale crosscheck workflow state')
  .option('--tidy', 'show only stale PRs that need attention')
  .option('--force', 'bypass the 1-minute scan cache')
  .option('--stale-after <duration>', 'duration like 30m, 2h, 1d', '24h')
  .option('--json', 'emit raw scan result for scripts')
  .action((opts: { tidy?: boolean; force?: boolean; staleAfter?: string; json?: boolean }) => void runScan(opts))

program
  .command('kickass')
  .description('Select actionable PRs from the operator queue and advance them')
  .option('--force', 'bypass the 1-minute scan cache')
  .option('--stale-after <duration>', 'duration like 30m, 2h, 1d', '24h')
  .option('--dry-run', 'print selected actions without running them')
  .option('--crazy', 'loop fix→recheck per PR until APPROVE; disables all timeout constraints')
  .option('--half-crazy', 'loop fix→recheck per PR until verdict is not BLOCK; disables all timeout constraints')
  .option('--halfcrazy', '(deprecated alias for --half-crazy)')
  .option('--timeout <duration>', 'reviewer subprocess timeout, e.g. 300s or 10m (default: 180s for claude, tier-based for codex)')
  .option('--concurrent [n]', 'cap parallel agents; omit n for one agent per PR (default), or set a cap (e.g. --concurrent 3)')
  .option('--sequential', 'run PRs one at a time instead of in parallel')
  .option('--stagger <ms>', 'ms delay between concurrent worker starts; default 2000')
  .action((opts: { force?: boolean; staleAfter?: string; dryRun?: boolean; crazy?: boolean; halfCrazy?: boolean; halfcrazy?: boolean; timeout?: string; concurrent?: string | true; sequential?: boolean; stagger?: string }) => {
    const roundMode = opts.crazy ? 'crazy' : (opts.halfCrazy || opts.halfcrazy) ? 'halfcrazy' : undefined
    const concurrent = opts.concurrent === undefined ? undefined
      : opts.concurrent === true ? 0
      : Number(opts.concurrent)
    const staggerMs = opts.stagger !== undefined ? Number(opts.stagger) : undefined
    void runKickass({ ...opts, roundMode, concurrent, staggerMs })
  })

program
  .command('status')
  .description('Show auth state, config summary, and CLI versions')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { config?: string }) => void runStatus(opts.config))

program
  .command('skill')
  .description('Manage coding-agent skills')
  .command('install <source>')
  .description('Install a skill from a Git URL or local directory')
  .action((source: string) => void runSkillInstall(source))

program
  .command('diagnose')
  .description('Analyze review logs — surface failure patterns, error trends, and improvement suggestions')
  .option('--json', 'output full report as JSON')
  .option('--since <date>', 'only analyze logs from this date onward (YYYY-MM-DD)')
  .option('--pr <url>', 'analyze a specific PR: show step history, log events, skips, and recommendations')
  .action((opts: { json?: boolean; since?: string; pr?: string }) => void runDiagnose(opts))

program
  .command('optimize')
  .description('Use AI to improve review instructions based on diagnose output')
  .option('--apply', 'write the improved instructions to the review step in ~/.crosscheck/workflow.yml')
  .option('--dry-run', 'show diff without writing (default behavior)')
  .option('--agent <vendor>', 'force a specific agent: claude | codex')
  .option('--since <date>', 'limit the diagnose window (YYYY-MM-DD)')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { apply?: boolean; dryRun?: boolean; agent?: string; since?: string; config?: string }) => void runOptimize(opts))

program
  .command('impact')
  .description('Report time saved, issues caught, and code quality trend from review history')
  .option('--json', 'output full report as JSON')
  .option('--since <date>', 'only analyze logs from this date onward (YYYY-MM-DD)')
  .option('--money', 'include a rough monetary estimate')
  .option('-c, --config <path>', 'config file path')
  .action((opts: { json?: boolean; since?: string; money?: boolean; config?: string }) => void runImpact(opts))

program
  .command('issue')
  .description('Detect errors in recent logs, draft a GitHub issue with AI, and submit after confirmation')
  .option('--since <date>', 'only look at logs from this date onward (YYYY-MM-DD, default: 3 days ago)')
  .option('--dry-run', 'print the draft without submitting')
  .option('-y, --yes', 'skip interactive questions and confirmation')
  .option('-c, --config <path>', 'config file path')
  .option('--opportunities', 'analyze logs for reliability patterns and improvement opportunities instead of error patterns')
  .option('--from-queue', 'process pending issue records saved by `diagnose --pr` when no recommendations were generated')
  .action((opts: { since?: string; dryRun?: boolean; yes?: boolean; config?: string; opportunities?: boolean; fromQueue?: boolean }) => void runIssue(opts))

program.parse()
