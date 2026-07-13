import chalk from 'chalk'
import type { RepoWorkflowStep } from '../config/schema.js'
import {
  formatRepoWorkflowSteps,
  parseRepoRef,
  parseRepoWorkflowSteps,
  perRepoWorkflowPath,
  readRepoWorkflowStepTypes,
  removeRepoWorkflowOverride,
  writeRepoWorkflowStepTypes,
} from '../lib/repo-workflow.js'

export interface AlterOpts {
  steps?: string
  reviewOnly?: boolean
  reset?: boolean
  show?: boolean
  // Test-only override for the per-repo workflows directory.
  workflowsDir?: string
}

export function resolveSteps(opts: AlterOpts): RepoWorkflowStep[] {
  if (opts.reviewOnly && opts.steps) {
    // --review-only is an alias for --steps review. The only explicit value that
    // does not conflict is `review` itself; anything else — a deeper depth OR an
    // unparseable value — surfaces this specific conflict message rather than the
    // generic parse error, so the real problem (the incompatible flags) is clear.
    let isJustReview = false
    try {
      const explicit = parseRepoWorkflowSteps(opts.steps)
      isJustReview = explicit.length === 1 && explicit[0] === 'review'
    } catch {
      isJustReview = false
    }
    if (!isJustReview) {
      throw new Error('--review-only cannot be combined with --steps unless --steps is review')
    }
    return ['review']
  }
  if (opts.reviewOnly) return ['review']
  if (opts.steps) return parseRepoWorkflowSteps(opts.steps)
  throw new Error('Choose a workflow depth with --steps review,fix,recheck or --review-only (or use --show / --reset)')
}

function fail(err: unknown, code: 1 | 2): never {
  console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
  process.exit(code)
}

export function runAlter(repoInput: string, opts: AlterOpts = {}): void {
  // ── Validate intent — user errors exit 1 ──────────────────────────────────
  const repo = parseRepoRef(repoInput)
  if (!repo) {
    fail(new Error('Invalid repo. Use owner/repo, github.com/owner/repo, or https://github.com/owner/repo'), 1)
  }
  const { owner, name } = repo

  let steps: RepoWorkflowStep[] | undefined
  if (!opts.reset && !opts.show) {
    try {
      steps = resolveSteps(opts)
    } catch (err: unknown) {
      fail(err, 1)
    }
  }

  // ── Filesystem effects — unexpected failures (EACCES, ENOSPC, …) exit 2 ────
  try {
    if (opts.reset) {
      const removed = removeRepoWorkflowOverride(owner, name, opts.workflowsDir)
      if (removed) {
        console.log(chalk.green(`✓ ${owner}/${name} override removed — reverts to the global workflow`))
      } else {
        console.log(chalk.dim(`  ${owner}/${name} had no override — already on the global workflow`))
      }
      return
    }

    if (opts.show) {
      const current = readRepoWorkflowStepTypes(owner, name, opts.workflowsDir)
      if (current) {
        console.log(`${owner}/${name}  ${chalk.cyan(formatRepoWorkflowSteps(current))}`)
        console.log(chalk.dim(`  ${perRepoWorkflowPath(owner, name, opts.workflowsDir)}`))
      } else {
        console.log(`${owner}/${name}  ${chalk.dim('uses the global workflow (no override)')}`)
      }
      return
    }

    const path = writeRepoWorkflowStepTypes(owner, name, steps!, opts.workflowsDir)
    console.log(chalk.green(`✓ ${owner}/${name} workflow set to ${formatRepoWorkflowSteps(steps!)}`))
    console.log(chalk.dim(`  ${path}`))
    console.log(chalk.dim('  Applies on the next PR event — no need to restart crosscheck watch.'))
  } catch (err: unknown) {
    fail(err, 2)
  }
}
