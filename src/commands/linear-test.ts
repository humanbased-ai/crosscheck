// `crosscheck linear-test` — exercise the whole Linear path without writing anything.
//
// Without this, the only way to find out whether Linear write-back is configured
// correctly is to open a PR and wait for a review. This resolves identity, looks up
// a real issue, and builds the exact comment body that would be posted — then prints
// it instead of posting. Every step reports separately, so a failure names itself.

import chalk from 'chalk'
import { loadConfig, getLinearCredentials } from '../config/loader.js'
import { verifyLinearIdentity } from '../linear/verify.js'
import { withWorker, renderIcon, renderSignature } from '../linear/identity.js'
import { findIssueByIdentifier } from '../linear/client.js'
import { buildLinearCommentBody, shouldPostToLinear } from '../linear/comment.js'
import { extractLinearRef } from '../linear/ref.js'

export interface LinearTestOpts {
  config?: string
  /** PR metadata to resolve a ref from, instead of naming an issue directly. */
  branch?: string
  title?: string
  verdict?: string
}

const DEFAULT_VERDICT = 'NEEDS_WORK'

export interface TestRef {
  id: string
  source: string
}

// A named issue wins over anything inferred, and bypasses the team_keys gate that
// guards automatic matching — the user typing `ENG-42` is unambiguous in a way that
// finding `ENG-42` inside a branch name is not.
export function resolveTestRef(
  issueArg: string | undefined,
  pr: { branch?: string; title?: string },
  teamKeys: readonly string[],
): TestRef | null {
  if (issueArg?.trim()) return { id: issueArg.trim().toUpperCase(), source: 'argument' }
  const ref = extractLinearRef({ branch: pr.branch, title: pr.title }, teamKeys)
  return ref ? { id: ref.id, source: ref.source } : null
}

// Wraps on whitespace, keeping tokens intact. A token longer than the width (a URL,
// typically) gets its own line rather than being broken mid-token.
export function softWrap(line: string, width: number): string[] {
  if (line.length <= width) return [line]
  const out: string[] = []
  let current = ''
  for (const word of line.split(' ')) {
    if (!current) { current = word; continue }
    if (current.length + 1 + word.length <= width) current += ` ${word}`
    else { out.push(current); current = word }
  }
  if (current) out.push(current)
  return out
}

export async function runLinearTest(issueRef: string | undefined, opts: LinearTestOpts = {}): Promise<void> {
  const config = loadConfig(opts.config)

  console.log(chalk.bold('\ncrosscheck linear-test\n'))

  if (!config.linear.enabled) {
    console.error(chalk.red('✗ Linear write-back is disabled.'))
    console.error(chalk.dim('  Set linear.enabled: true, or run crosscheck onboard.'))
    process.exit(1)
  }

  // 1 — identity
  const report = await verifyLinearIdentity(config.linear, getLinearCredentials(config.linear.auth))
  if (!report.ok) {
    console.error(chalk.red(`✗ identity      ${report.error}`))
    // A misconfiguration is exit 1; a Linear outage is exit 2, same as everywhere
    // else. verifyLinearIdentity never throws, so classify from the message.
    process.exit(report.error && /HTTP 5\d\d|429|mint failed/.test(report.error) ? 2 : 1)
  }
  const writesAs = report.attribution === 'app'
    ? `${report.actor} ${chalk.dim('(crosscheck itself)')}`
    : `${report.attributesTo ?? 'your Linear account'} ${chalk.dim('(api key)')}`
  console.log(`${chalk.green('✓')} identity      ${report.mode} — writes as ${writesAs}`)
  console.log(`${chalk.green('✓')} workspace     ${report.organization ?? 'unknown'}`)

  // 2 — which issue
  const ref = resolveTestRef(issueRef, { branch: opts.branch, title: opts.title }, config.linear.team_keys)

  if (!ref) {
    console.error(chalk.red('✗ issue         no Linear reference found'))
    console.error(chalk.dim('  Name one directly (crosscheck linear-test ENG-42), or pass --branch/--title.'))
    if (config.linear.team_keys.length === 0) {
      console.error(chalk.dim('  linear.team_keys is empty, so only full linear.app URLs resolve.'))
    }
    process.exit(1)
  }
  console.log(`${chalk.green('✓')} reference     ${ref.id} ${chalk.dim(`(via ${ref.source})`)}`)

  // 3 — does it exist. Reuses the identity the probe already resolved: minting a
  // second token here broke the one-token-per-run contract, and a transient
  // failure on that second mint could fail a dry run whose verification passed.
  const auth = report.auth!
  const issue = await findIssueByIdentifier(auth, ref.id)
  if (!issue) {
    console.error(chalk.red(`✗ lookup        ${ref.id} not found in ${report.organization ?? 'this workspace'}`))
    process.exit(1)
  }
  console.log(`${chalk.green('✓')} lookup        ${issue.url}`)

  // 4 — would this verdict post at all
  const verdict = opts.verdict ?? DEFAULT_VERDICT
  const posts = shouldPostToLinear(verdict, config.linear.comment_on)
  const filterNote = posts
    ? `${chalk.green('✓')} filter        ${verdict} is in comment_on`
    : `${chalk.yellow('!')} filter        ${verdict} is NOT in comment_on ${chalk.dim(`(${config.linear.comment_on.join(', ')})`)} — a real run would skip`
  console.log(filterNote)

  // 5 — the body itself
  const scoped = config.linear.identity.per_step_actor ? withWorker(auth, 'review') : auth
  const signature = renderSignature(scoped.signatureTemplate, {
    actor: scoped.actor,
    product: scoped.product,
    model: 'gpt-5.6-terra',
    reviewer: 'codex',
    icon: renderIcon(config.linear.identity.icon_url),
  })
  const body = buildLinearCommentBody({
    signature,
    verdict,
    reviewer: 'codex',
    origin: 'claude',
    model: 'gpt-5.6-terra',
    prUrl: 'https://github.com/acme/app/pull/42',
    prTitle: 'example: a sample PR',
    sha: 'abc1234',
    summary: 'Example summary — a real run puts the review text here.',
    service: config.brand.service_name,
  })

  // The annotation line runs past 140 chars, so soft-wrap rather than let the
  // terminal hard-wrap it mid-token at whatever width the window happens to be.
  const WRAP = 80
  console.log(chalk.dim('\n  ── comment that would be posted ' + '─'.repeat(44)))
  console.log()
  for (const line of body.split('\n')) {
    for (const chunk of softWrap(line, WRAP)) console.log(`  ${chunk}`)
  }
  console.log()
  console.log(chalk.dim('  ' + '─'.repeat(76)))
  console.log(chalk.green('\n✓ Nothing was posted — this was a dry run.\n'))
}
