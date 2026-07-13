import chalk from 'chalk'
import ora from 'ora'
import { createGithubClient } from '../github/client.js'
import { getGithubToken, loadConfig } from '../config/loader.js'
import { loadWorkflow } from '../lib/workflow.js'
import { resolveRepoWorkflowSteps } from '../lib/repo-workflow.js'
import { fetchStepHistory, identifyNextWorkflowStep, type StepRecord } from '../lib/pr-workflow-state.js'

function parsePRUrl(url: string): { owner: string; repo: string; number: number } | null {
  const m = url.match(/github\.com\/([^/]+)\/([^/]+)\/pull\/(\d+)/)
  if (!m) return null
  return { owner: m[1], repo: m[2], number: parseInt(m[3], 10) }
}

function fmtDate(iso: string): string {
  const d = new Date(iso)
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function verdictColor(verdict: string | undefined): string {
  if (!verdict) return chalk.dim('?')
  if (verdict === 'APPROVE') return chalk.green(verdict)
  if (verdict === 'BLOCK') return chalk.red(verdict)
  return chalk.yellow(verdict.replace('_', ' '))
}

function printHistory(records: StepRecord[]): void {
  if (records.length === 0) {
    console.log(chalk.dim('  (no crosscheck steps found)'))
    return
  }
  const typeWidth = Math.max(...records.map(r => r.type.length))
  for (let i = 0; i < records.length; i++) {
    const r = records[i]
    const idx = chalk.dim(String(i + 1).padStart(2))
    const date = chalk.dim(fmtDate(r.createdAt))
    const type = r.type.padEnd(typeWidth)
    const reviewer = r.reviewer ? chalk.cyan(r.reviewer) + (r.model ? chalk.dim(`·${r.model}`) : '') : chalk.dim('—')
    const recordSha = r.sha ?? r.pushedSha
    const sha = recordSha ? chalk.dim(`sha=${recordSha.slice(0, 7)}`) : ''
    const round = r.round > 1 ? chalk.dim(`round=${r.round}`) : ''
    const source = r.source === 'commit' ? chalk.dim('source=commit') : ''
    const verdict = r.type === 'review' || r.type === 'recheck' ? verdictColor(r.verdict) : ''
    const parts = [reviewer, sha, source, round, verdict].filter(Boolean).join('  ')
    console.log(`  ${idx}  ${date}  ${type}  ${parts}`)
  }
}

export async function runDetectStep(
  prUrl: string,
  opts: { config?: string; json?: boolean } = {},
): Promise<void> {
  const parsed = parsePRUrl(prUrl)
  if (!parsed) {
    console.error(chalk.red('Invalid PR URL. Expected: https://github.com/owner/repo/pull/123'))
    process.exit(1)
  }
  const { owner, repo, number } = parsed

  let token: string
  try {
    token = getGithubToken()
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }

  const spinner = ora(`Fetching PR #${number}...`).start()
  const octokit = createGithubClient(token)
  const { data: prData } = await octokit.rest.pulls.get({ owner, repo, pull_number: number })
  spinner.succeed(`PR #${number}  ·  ${prData.title}`)

  const config = loadConfig(opts.config)
  const steps = resolveRepoWorkflowSteps(config, owner, repo, loadWorkflow(process.cwd()))

  const historySpinner = ora('Reading workflow history...').start()
  const history = await fetchStepHistory(owner, repo, number, token)
  historySpinner.stop()

  const currentSha = prData.head.sha
  const nextResult = identifyNextWorkflowStep(history, steps, currentSha)

  if (opts.json) {
    console.log(JSON.stringify({
      pr: { number, title: prData.title, headSha: currentSha, base: prData.base.ref },
      history: history.map(r => ({
        type: r.type,
        verdict: r.verdict,
        sha: r.sha,
        pushedSha: r.pushedSha,
        source: r.source,
        round: r.round,
        commentId: r.commentId,
        createdAt: r.createdAt,
        reviewer: r.reviewer,
        model: r.model,
        next_step: r.next_step,
      })),
      next: nextResult.step
        ? {
            step: nextResult.step.type,
            stepName: nextResult.step.name,
            round: nextResult.round,
            reviewCommentId: nextResult.reviewComment?.id,
          }
        : null,
    }, null, 2))
    return
  }

  console.log()
  console.log(chalk.dim(`  HEAD   ${currentSha.slice(0, 7)}  ·  base: ${prData.base.ref}`))
  console.log(chalk.dim(`  workflow steps: ${steps.map(s => s.name).join(' → ')}`))
  console.log()

  const divider = chalk.dim('─'.repeat(70))
  console.log(`  ${chalk.bold('Step history')}  ${chalk.dim(`(${history.length} entr${history.length === 1 ? 'y' : 'ies'})`)}\n  ${divider}`)
  printHistory(history)
  console.log(`  ${divider}`)
  console.log()

  if (nextResult.step === null) {
    const lastVerdict = [...history].reverse().find(r => r.verdict)?.verdict
    console.log(`  ${chalk.green('✓')} Workflow complete${lastVerdict ? ` — last verdict: ${verdictColor(lastVerdict)}` : ''}`)
  } else {
    const nextLabel = chalk.bold(nextResult.step.type)
    const roundLabel = nextResult.round > 1 ? chalk.dim(` (round ${nextResult.round})`) : ''
    console.log(`  Next step:  ${nextLabel}${roundLabel}`)
    if (nextResult.reviewComment) {
      const commentUrl = `https://github.com/${owner}/${repo}/pull/${number}#issuecomment-${nextResult.reviewComment.id}`
      console.log(`  Context:    review comment #${nextResult.reviewComment.id}  ·  ${chalk.dim(commentUrl)}`)
    }
  }
  console.log()

}
