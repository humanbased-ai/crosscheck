import { execSync } from 'child_process'
import { existsSync, writeFileSync, readFileSync, mkdirSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { getWebhookSecret, getWebhookSecretPath, detectGitHubLogin, patchAllowedAuthors, loadConfig, resolveConfigPath } from '../config/loader.js'

export interface CheckResult {
  label: string
  ok: boolean
  detail: string
  fix?: string
}

export async function runChecks(): Promise<{ results: CheckResult[]; aiCliCount: number }> {
  const results: CheckResult[] = []
  let aiCliCount = 0

  // Check codex CLI
  try {
    const version = execSync('codex --version 2>&1', { encoding: 'utf8' }).trim()
    const auth = await checkCodexAuth()
    if (auth.ok) aiCliCount++
    results.push({ label: 'codex CLI', ok: auth.ok, detail: `${version} — ${auth.detail}`, fix: auth.ok ? undefined : 'Run: codex login --device-auth' })
  } catch {
    results.push({ label: 'codex CLI', ok: false, detail: 'not found', fix: 'Install: npm install -g @openai/codex' })
  }

  // Check claude CLI
  try {
    const auth = await checkClaudeAuth()
    if (auth.ok) aiCliCount++
    results.push({ label: 'claude CLI', ok: auth.ok, detail: auth.detail, fix: auth.ok ? undefined : 'Run: claude auth login' })
  } catch {
    results.push({ label: 'claude CLI', ok: false, detail: 'not found', fix: 'Install: npm install -g @anthropic-ai/claude-code' })
  }

  // Check gh CLI — authenticated if stored credentials OR GITHUB_TOKEN env var is set
  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  let ghAuthed = false
  try {
    const version = execSync('gh --version 2>&1', { encoding: 'utf8' }).split('\n')[0]
    // gh auth status exits non-zero when GITHUB_TOKEN env var is set — handle separately
    let authOutput = ''
    try { authOutput = execSync('gh auth status 2>&1', { encoding: 'utf8' }) } catch { /* GITHUB_TOKEN in use */ }
    const keyringAuthed = authOutput.includes('Logged in')
    ghAuthed = keyringAuthed || !!envToken
    const detail = !!envToken && !keyringAuthed
      ? `${version} — authenticated via GITHUB_TOKEN`
      : version
    results.push({ label: 'gh CLI', ok: ghAuthed, detail, fix: ghAuthed ? undefined : 'Run: gh auth login' })
  } catch {
    results.push({ label: 'gh CLI', ok: false, detail: 'not found', fix: 'Install: brew install gh && gh auth login' })
  }
  // Token is resolvable if env var is set OR if gh keyring has a token (getGithubToken() falls back to `gh auth token`)
  const tokenResolvable = !!envToken || ghAuthed
  const tokenDetail = envToken ? 'set via env' : ghAuthed ? 'via gh auth login' : 'missing'
  results.push({ label: 'GITHUB_TOKEN', ok: tokenResolvable, detail: tokenDetail, fix: tokenResolvable ? undefined : 'Set GITHUB_TOKEN or run: gh auth login' })

  // Check admin:org_hook scope — needed for org-level webhook registration in watch/serve
  if (ghAuthed) {
    try {
      const statusOutput = execSync('gh auth status 2>&1', {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
      })
      const scopeMatch = statusOutput.match(/Token scopes:\s*(.+)/)
      if (scopeMatch) {
        const scopes = scopeMatch[1]
        const hasOrgHook = /admin:org_hook|'admin:org'|"admin:org"/.test(scopes)
        results.push({
          label: 'org webhook scope',
          ok: hasOrgHook,
          detail: hasOrgHook ? 'admin:org_hook present' : `not granted (scopes: ${scopes.trim()})`,
          fix: hasOrgHook ? undefined : 'gh auth refresh -s admin:org_hook  (required for org-level webhooks)',
        })
      }
    } catch { /* gh not available or scope line absent — skip silently */ }
  }

  // Check WEBHOOK_SECRET — auto-generated if missing, so always ok
  const fromEnv = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  const secretDetail = fromEnv
    ? 'set via env'
    : `auto-managed at ${getWebhookSecretPath()}`
  getWebhookSecret() // ensure it's generated/persisted
  results.push({ label: 'WEBHOOK_SECRET', ok: true, detail: secretDetail })

  return { results, aiCliCount }
}

function printCheck({ label, ok, detail, fix }: CheckResult) {
  const icon = ok ? chalk.green('✓') : chalk.red('✗')
  const labelStr = chalk.bold(label.padEnd(20))
  console.log(`  ${icon} ${labelStr} ${detail}`)
  if (!ok && fix) console.log(`      ${chalk.dim('→')} ${chalk.yellow(fix)}`)
}

export async function runInit(configPath?: string) {
  console.log(chalk.bold('\ncrosscheck — environment check\n'))

  const { results: checks, aiCliCount } = await runChecks()
  for (const check of checks) printCheck(check)

  // AI CLI checks: only BOTH missing is a hard blocker. One CLI = single-vendor mode (still usable).
  const aiChecks = checks.filter(c => c.label === 'codex CLI' || c.label === 'claude CLI')
  const nonAiFailures = checks.filter(c => !aiChecks.includes(c) && !c.ok && c.fix)

  if (aiCliCount === 0) {
    // Neither AI CLI is authenticated — hard failure
    console.log(chalk.red(`\nAt least one AI CLI (codex or claude) must be authenticated before crosscheck can run.\n`))
    if (nonAiFailures.length > 0) {
      console.log(chalk.yellow(`${nonAiFailures.length} other issue(s) also need attention.\n`))
    }
  } else if (nonAiFailures.length > 0) {
    console.log(chalk.yellow(`\n${nonAiFailures.length} issue(s) need attention before crosscheck can run fully.\n`))
    if (aiCliCount === 1) {
      const missing = aiChecks.find(c => !c.ok)?.label ?? 'one AI CLI'
      console.log(chalk.dim(`Note: ${missing} is not available — running in single-vendor mode (cross-vendor review disabled).\n`))
    }
  } else {
    if (aiCliCount === 1) {
      const missing = aiChecks.find(c => !c.ok)?.label ?? 'one AI CLI'
      console.log(chalk.yellow(`\nNote: ${missing} is not available — running in single-vendor mode (cross-vendor review disabled).\n`))
    } else {
      console.log(chalk.green('\nAll checks passed.\n'))
    }
  }

  // Write config if none exists, pre-filling allowed_authors with the detected GitHub login.
  // Prefer the active config (local project file or explicit path) before falling back to
  // the global default, so `crosscheck init` patches the same file that `watch` reads.
  const dest = configPath ?? resolveConfigPath() ?? join(homedir(), '.crosscheck', 'config.yml')
  mkdirSync(join(homedir(), '.crosscheck'), { recursive: true })
  if (!existsSync(dest)) {
    const examplePath = new URL('../../crosscheck.config.example.yml', import.meta.url).pathname
    if (existsSync(examplePath)) {
      let content = readFileSync(examplePath, 'utf8')
      const login = detectGitHubLogin()
      if (login) {
        // Uncomment allowed_authors placeholder
        content = content.replace(
          / {2}# allowed_authors:\n( {2}#[^\n]*\n)+/,
          `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
        )
        // author_routes is intentionally left commented out. In cross-vendor mode with
        // both vendors enabled (the default), routes for an author who uses both
        // agents are structurally wrong — attribution detection + fallback_reviewer
        // are the correct path. `crosscheck onboard` writes the route only when the
        // user picks a single authorVendor.
      }
      writeFileSync(dest, content)
      const hint = login ? `allowed_authors set to ${chalk.cyan(login)}` : 'edit to customize'
      console.log(chalk.dim(`Config written to ${dest} — ${hint}.\n`))
    }
  } else {
    // Config exists — patch allowed_authors if still empty.
    // author_routes is intentionally not auto-patched: `crosscheck onboard` writes it
    // only when the user picks a single authorVendor, since cross-vendor + both
    // enabled bypasses the route (see detector.ts).
    const existing = loadConfig(resolveConfigPath(configPath) ?? dest)
    const login = detectGitHubLogin()
    let patched = false
    if (login) {
      if (existing.routing.allowed_authors.length === 0) {
        patched = patchAllowedAuthors(dest, login) || patched
      }
    }
    if (patched) {
      console.log(chalk.green(`  ✓ routing updated for ${chalk.cyan(login ?? 'unknown')} in ${dest}\n`))
    } else {
      console.log(chalk.dim(`Config already exists at ${dest}\n`))
    }
  }

  // Smee-client is optional but improves watch mode reliability.
  // Check if it's installed and show a one-line tip if not.
  try {
    execSync('smee --version', { stdio: 'ignore' })
  } catch {
    console.log(chalk.dim('Tip: install smee-client for reliable webhook delivery (events queued while offline):'))
    console.log(chalk.dim('  npm install -g smee-client'))
    console.log(chalk.dim('  Then set tunnel: backend: smee in your config.\n'))
  }

  console.log(chalk.dim('  Run  crosscheck onboard  to configure scope and persona.\n'))
}
