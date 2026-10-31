import chalk from 'chalk'
import { existsSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import {
  loadConfig,
  resolveConfigPath,
  resolveGithubAppKey,
  writeGithubAppConfig,
  clearGithubAppConfig,
  detectGitHubLogin,
  type ResolvedGithubAppKey,
} from '../config/loader.js'
import { clearGithubAppCache, probeGithubApp, type AppProbeResult } from '../github/client.js'
import { ConfigSchema, type Config } from '../config/schema.js'

export interface AuthAppOptions {
  config?: string
  appId?: string
  key?: string
  installationId?: string
  repo?: string
  check?: boolean
  clear?: boolean
}

function row(label: string, value: string, ok?: boolean): void {
  const indicator = ok === undefined ? ' ' : ok ? chalk.green('✓') : chalk.red('✗')
  console.log(`  ${indicator} ${chalk.bold(label.padEnd(20))} ${value}`)
}

function printProbe(result: AppProbeResult): void {
  for (const check of result.checks) {
    const icon = check.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${chalk.bold(check.step.padEnd(20))} ${check.detail}`)
    if (!check.ok && check.fix) console.log(`      ${chalk.dim('→')} ${chalk.yellow(check.fix)}`)
  }
}

function parsePositiveInt(raw: string | undefined, flag: string): number | undefined {
  if (raw === undefined) return undefined
  const value = Number(raw)
  if (!Number.isInteger(value) || value <= 0) {
    console.error(chalk.red(`✗ ${flag} must be a positive integer (got "${raw}")`))
    process.exit(1)
  }
  return value
}

function parseRepo(raw: string | undefined): { owner: string; repo: string } | undefined {
  if (raw === undefined) return undefined
  const match = raw.match(/^([^/]+)\/([^/]+)$/)
  if (!match) {
    console.error(chalk.red(`✗ --repo must be owner/name (got "${raw}")`))
    process.exit(1)
  }
  return { owner: match[1], repo: match[2] }
}

function defaultConfigPath(explicit?: string): string {
  return resolveConfigPath(explicit) ?? join(homedir(), '.crosscheck', 'config.yml')
}

// `ck auth app` is how a config file gets its github.app block, so a missing
// explicit path is an empty config — not the ENOENT that loadConfig throws.
function loadConfigForAuth(configPath?: string): Config {
  const path = resolveConfigPath(configPath)
  return path && existsSync(path) ? loadConfig(path) : ConfigSchema.parse({})
}

// ── ck auth ──────────────────────────────────────────────────────────────────

export async function runAuthStatus(configPath?: string): Promise<void> {
  const config = loadConfigForAuth(configPath)
  const activeConfigPath = resolveConfigPath(configPath)

  console.log(chalk.bold('\ncrosscheck auth\n'))

  const actor = detectGitHubLogin()
  row('actor', actor ? `@${actor} ${chalk.dim('(gh auth login)')}` : chalk.red('not signed in — run: gh auth login'), actor !== null)

  const app = config.github.app
  if (app.app_id === null) {
    row('reviewer', actor ? `@${actor} ${chalk.dim('(your GitHub token)')}` : 'your GitHub token', true)
    console.log(chalk.dim('    comments on your own PRs read as self-reviews'))
    console.log(chalk.dim('    post as a bot instead:  ck auth app --app-id <id> --key <pem>'))
    console.log()
    return
  }

  let key: ResolvedGithubAppKey | null = null
  try {
    key = resolveGithubAppKey(config)
  } catch (err) {
    row('reviewer', chalk.red(err instanceof Error ? err.message : String(err)), false)
    console.log()
    return
  }
  if (key === null) return
  const result = await probeGithubApp({
    key: { appId: key.appId, privateKey: key.privateKey },
    installationId: app.installation_id,
  })
  row('reviewer', `${result.login ?? `app ${key.appId}`} ${chalk.dim(`(app ${key.appId})`)}`, result.ok)
  printProbe(result)
  if (!result.ok) console.log(chalk.dim('\n  fix the checks above, then run: ck auth app --check'))
  console.log(chalk.dim(`\n  config: ${activeConfigPath ?? 'defaults only'}\n`))
}

// ── ck auth app ──────────────────────────────────────────────────────────────

export async function runAuthApp(opts: AuthAppOptions): Promise<void> {
  const configPath = defaultConfigPath(opts.config)

  if (opts.clear) {
    const removed = clearGithubAppConfig(configPath)
    clearGithubAppCache()
    if (removed) {
      console.log(chalk.green(`✓ GitHub App identity removed from ${configPath}`))
      console.log(chalk.dim('  reviews will be posted with your GitHub token'))
    } else {
      console.log(chalk.dim(`No GitHub App identity configured in ${configPath}`))
    }
    return
  }

  const config = loadConfigForAuth(configPath)
  const repo = parseRepo(opts.repo)
  const appId = parsePositiveInt(opts.appId, '--app-id') ?? config.github.app.app_id
  const installationId = parsePositiveInt(opts.installationId, '--installation-id') ?? config.github.app.installation_id

  if (appId === null) {
    console.error(chalk.red('✗ No GitHub App configured. Pass --app-id <id> --key <pem>.'))
    console.error(chalk.dim('  Create one: https://github.com/settings/apps/new'))
    process.exit(1)
  }

  // Validate the candidate identity before persisting it, so a broken key or a
  // missing installation never lands in config.yml.
  const candidate: Config = {
    ...config,
    github: {
      app: {
        ...config.github.app,
        app_id: appId,
        installation_id: installationId,
        ...(opts.key !== undefined ? { private_key_path: opts.key } : {}),
      },
    },
  }

  let key: ResolvedGithubAppKey | null = null
  try {
    key = resolveGithubAppKey(candidate)
  } catch (err) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
  if (key === null) process.exit(1)
  console.log(chalk.bold('\ncrosscheck auth — GitHub App\n'))
  const result = await probeGithubApp({
    key: { appId, privateKey: key.privateKey },
    installationId,
    ...(repo ?? {}),
  })
  printProbe(result)

  if (!result.ok) {
    console.log(chalk.red('\n✗ identity not saved — fix the checks above and re-run.\n'))
    process.exit(1)
  }

  if (opts.check) {
    console.log(chalk.green(`\n✓ ${result.login} can post reviews.\n`))
    return
  }

  writeGithubAppConfig(configPath, {
    appId,
    installationId: result.installation?.id ?? installationId,
    privateKeyPath: opts.key ?? null,
  })
  clearGithubAppCache()
  console.log(chalk.green(`\n✓ Config written to ${configPath}`))
  console.log(chalk.dim(`  reviews will be posted as ${result.login}\n`))
}
