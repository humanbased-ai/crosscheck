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

export function runAlter(repoInput: string, opts: AlterOpts = {}): void {
  try {
    const repo = parseRepoRef(repoInput)
    if (!repo) {
      throw new Error('Invalid repo. Use owner/repo, github.com/owner/repo, or https://github.com/owner/repo')
    }
    const { owner, name } = repo

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
      const steps = readRepoWorkflowStepTypes(owner, name, opts.workflowsDir)
      if (steps) {
        console.log(`${owner}/${name}  ${chalk.cyan(formatRepoWorkflowSteps(steps))}`)
        console.log(chalk.dim(`  ${perRepoWorkflowPath(owner, name, opts.workflowsDir)}`))
      } else {
        console.log(`${owner}/${name}  ${chalk.dim('uses the global workflow (no override)')}`)
      }
      return
    }

    const steps = resolveSteps(opts)
    const path = writeRepoWorkflowStepTypes(owner, name, steps, opts.workflowsDir)

    console.log(chalk.green(`✓ ${owner}/${name} workflow set to ${formatRepoWorkflowSteps(steps)}`))
    console.log(chalk.dim(`  ${path}`))
    console.log(chalk.dim('  Applies on the next PR event — no need to restart crosscheck watch.'))
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}
