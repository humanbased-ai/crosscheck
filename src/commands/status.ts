import { execSync } from 'child_process'
import { existsSync, statSync } from 'fs'
import chalk from 'chalk'
import { loadConfig, getGithubTokenSource, getWebhookSecretPath, resolveConfigPath } from '../config/loader.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { getLogDir, getTodayLogPath } from '../lib/logger.js'
import { buildImpactReport } from './impact.js'

function row(label: string, value: string, ok?: boolean) {
  const indicator = ok === undefined ? ' ' : ok ? chalk.green('✓') : chalk.red('✗')
  console.log(`  ${indicator} ${chalk.bold(label.padEnd(22))} ${value}`)
}

export async function runStatus(configPath?: string) {
  const config = loadConfig(configPath)
  const activeConfigPath = resolveConfigPath(configPath)

  console.log(chalk.bold('\ncrosscheck status\n'))

  // Auth
  console.log(chalk.dim('  Auth'))
  const [codexAuth, claudeAuth] = await Promise.all([checkCodexAuth(), checkClaudeAuth()])
  row('codex', codexAuth.detail || 'authenticated', codexAuth.ok)
  row('claude', claudeAuth.detail || 'authenticated', claudeAuth.ok)

  const tokenResult = getGithubTokenSource()
  const ghTokenDetail = tokenResult
    ? `set (${tokenResult.source === 'gh-keyring' ? 'gh auth login' : 'env'})`
    : 'missing'
  row('GITHUB_TOKEN', ghTokenDetail, tokenResult !== null)

  const webhookSecret = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  const webhookSecretPath = getWebhookSecretPath()
  const webhookSecretDetail = webhookSecret
    ? 'set (env)'
    : existsSync(webhookSecretPath)
      ? `auto-managed at ${webhookSecretPath}`
      : `auto-managed on first watch at ${webhookSecretPath}`
  row('WEBHOOK_SECRET', webhookSecretDetail, true)

  // Config
  console.log()
  console.log(chalk.dim('  Config'))
  row('config path', activeConfigPath ?? 'defaults only')
  row('mode', config.mode)
  row('quality tier', config.quality.tier)
  row('codex auth', config.vendors.codex.auth)
  row('codex model', config.vendors.codex.model ?? 'auto (by tier)')
  row('claude model', config.vendors.claude.model ?? 'default')
  row('per-review budget', config.vendors.codex.auth === 'subscription'
    ? 'subscription (unlimited)'
    : `$${config.budget.per_review_usd.toFixed(2)}`)

  if (config.repos.length > 0) {
    row('repos', config.repos.map(r => `${r.owner}/${r.name}`).join(', '))
  }

  if (config.quality.focus.length > 0) {
    row('focus', config.quality.focus.join(', '))
  }

  // Logs
  console.log()
  console.log(chalk.dim('  Logs'))
  row('enabled', String(config.logs.enabled), config.logs.enabled)
  row('retention', `${config.logs.retention_days} days`)
  row('log dir', getLogDir())
  const todayLog = getTodayLogPath()
  if (existsSync(todayLog)) {
    const bytes = statSync(todayLog).size
    const kb = (bytes / 1024).toFixed(1)
    row('today', `${kb} KB — ${todayLog}`)
  } else {
    row('today', 'no log yet today')
  }

  // Impact summary
  console.log()
  console.log(chalk.dim('  Impact'))
  const impact = buildImpactReport(config.impact)
  if (impact.reviews_total === 0) {
    row('summary', 'no data yet — run crosscheck watch to start collecting')
  } else {
    row('summary', `${impact.reviews_total} reviews · ~${Math.round(impact.total_hours_saved)}h saved · ${impact.issues_caught} issues caught  ${chalk.dim('(run crosscheck impact for details)')}`)
  }

  // CLI versions
  console.log()
  console.log(chalk.dim('  CLIs'))
  try {
    const codexVer = execSync('codex --version 2>&1', { encoding: 'utf8' }).trim()
    row('codex', codexVer)
  } catch {
    row('codex', 'not found', false)
  }
  try {
    const claudeVer = execSync('claude --version 2>&1', { encoding: 'utf8' }).trim()
    row('claude', claudeVer)
  } catch {
    row('claude', 'not found', false)
  }

  console.log()
}
