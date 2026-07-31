import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs'
import { execSync } from 'child_process'
import { createInterface } from 'readline'
import { resolve, join, dirname } from 'path'
import { homedir } from 'os'
import { randomBytes } from 'crypto'
import yaml from 'js-yaml'
import { ConfigSchema, type Config, type LinearAuthConfig } from './schema.js'
import { listUserOrgs } from '../github/client.js'
import type { LinearCredentials } from '../linear/identity.js'

const CONFIG_FILENAME = 'crosscheck.config.yml'

function findConfigFile(): string | null {
  // Home is searched first: crosscheck is a user-level tool (it reviews PRs across
  // all the user's repos/orgs), so ~/.crosscheck/config.yml is the natural source of
  // truth. A cwd file is treated as a deliberate per-project override.
  const candidates = [
    join(homedir(), '.crosscheck', 'config.yml'),
    resolve(process.cwd(), CONFIG_FILENAME),
    resolve(process.cwd(), '.crosscheck.yml'),
  ]
  return candidates.find(existsSync) ?? null
}

export function resolveConfigPath(explicitPath?: string): string | null {
  return explicitPath ?? findConfigFile()
}

export function loadConfig(explicitPath?: string): Config {
  const configPath = resolveConfigPath(explicitPath)
  if (!configPath) return ConfigSchema.parse({})

  const raw = yaml.load(readFileSync(configPath, 'utf8'))
  return ConfigSchema.parse(raw)
}

// Shared by getGithubToken() and status.ts so both resolve through identical logic.
export function getGithubTokenSource(): { token: string; source: 'gh-keyring' | 'env' } | null {
  // Strip GITHUB_TOKEN / GH_TOKEN from the subprocess env before calling
  // `gh auth token`. When those vars are present (even invalid/expired), gh
  // treats them as the active credential and echoes them back — bypassing the
  // keyring entirely.
  try {
    const t = execSync('gh auth token 2>/dev/null', {
      encoding: 'utf8',
      env: { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined },
    }).trim()
    if (t) return { token: t, source: 'gh-keyring' }
  } catch { /* gh not available or no keyring session */ }

  // Fall back to env var — useful in CI where gh is not set up
  const env = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  if (env) return { token: env, source: 'env' }

  return null
}

export function getGithubToken(): string {
  const result = getGithubTokenSource()
  if (result) return result.token
  throw new Error(
    'No GitHub token found.\n' +
    '  Option 1: run: gh auth login\n' +
    '  Option 2: set GITHUB_TOKEN in your shell profile or .env file'
  )
}

// Linear credentials. Env var NAMES come from config; the values are read here and
// nowhere else, so no other module touches process.env for secrets.
export function getLinearCredentials(auth: LinearAuthConfig): LinearCredentials {
  const read = (name: string): string | undefined => {
    const value = process.env[name]
    return value && value.trim() ? value.trim() : undefined
  }
  return {
    apiKey: read(auth.api_key_env),
    clientId: read(auth.client_id_env),
    clientSecret: read(auth.client_secret_env),
  }
}

const SECRET_FILE = join(homedir(), '.crosscheck', 'webhook-secret')

export function getWebhookSecret(): string {
  // Env var takes precedence
  const fromEnv = process.env.CROSSCHECK_WEBHOOK_SECRET ?? process.env.GITHUB_WEBHOOK_SECRET
  if (fromEnv) return fromEnv

  // Persist and reuse an auto-generated secret
  if (existsSync(SECRET_FILE)) {
    return readFileSync(SECRET_FILE, 'utf8').trim()
  }

  const generated = randomBytes(32).toString('hex')
  mkdirSync(join(homedir(), '.crosscheck'), { recursive: true })
  writeFileSync(SECRET_FILE, generated, { mode: 0o600 })
  return generated
}

export function getWebhookSecretPath(): string {
  return SECRET_FILE
}

// Read once here per the "env vars only in loader" rule. Returns undefined when
// unset — issue enrichment treats that as "skip", never an error.
export function getLinearApiKey(): string | undefined {
  return process.env.LINEAR_API_KEY ?? undefined
}

export function detectGitHubLogin(): string | null {
  const envVariants = [
    { ...process.env, GITHUB_TOKEN: undefined, GH_TOKEN: undefined }, // keyring first
    process.env,                                                         // env token fallback
  ]
  for (const env of envVariants) {
    try {
      const login = execSync("gh api user --jq '.login' 2>/dev/null", { encoding: 'utf8', env }).trim()
      if (login && !login.includes('\n')) return login
    } catch { /* try next */ }
  }
  return null
}

export function patchAllowedAuthors(configPath: string, login: string): boolean {
  let content = readFileSync(configPath, 'utf8')

  // Guard: if allowed_authors already has real (non-comment) entries, nothing to do.
  // Entries appear as `    - value` lines after the key, optionally preceded by comment lines.
  if (/  allowed_authors:\s*\n(?:  #[^\n]*\n)*    - /.test(content)) return false

  // Case 1: commented-out placeholder block from the example config
  const uncommented = content.replace(
    /  # allowed_authors:\n(  #[^\n]*\n)+/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (uncommented !== content) {
    writeFileSync(configPath, uncommented)
    return true
  }

  // Case 2: key exists but list is empty (no entries under it, only optional comment lines)
  const filledEmpty = content.replace(
    /(  allowed_authors:\s*\n)((?:  #[^\n]*\n)*)/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (filledEmpty !== content) {
    writeFileSync(configPath, filledEmpty)
    return true
  }

  // Case 3: key exists as inline empty array — `allowed_authors: []` or `allowed_authors: [ ]`
  const filledInlineEmpty = content.replace(
    /( {2}allowed_authors:\s*\[\s*\]\s*\n)/,
    `  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (filledInlineEmpty !== content) {
    writeFileSync(configPath, filledInlineEmpty)
    return true
  }

  // Case 4: routing: section exists but allowed_authors is absent — append after routing:
  const appended = content.replace(
    /(routing:\s*\n)/,
    `$1  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`,
  )
  if (appended !== content) {
    writeFileSync(configPath, appended)
    return true
  }

  // Case 5: no routing: section at all — append a new routing block
  if (!/^routing:/m.test(content)) {
    const block = `\nrouting:\n  allowed_authors:\n    - ${login}  # auto-detected from gh auth\n`
    writeFileSync(configPath, content.trimEnd() + '\n' + block)
    return true
  }

  return false
}

// Writes routing.author_routes: { [login]: 'claude' } to an existing config file
// using text-based patching to preserve comments and formatting.
// No-op if author_routes already has entries (never overwrites user-set routes).
export function patchAuthorRoutes(configPath: string, login: string): boolean {
  const content = readFileSync(configPath, 'utf8')

  // Use yaml.load only to check current state — text patching does the write.
  const raw = (yaml.load(content) ?? {}) as Record<string, unknown>
  const routing = typeof raw.routing === 'object' && raw.routing !== null
    ? raw.routing as Record<string, unknown>
    : {}
  const current = typeof routing.author_routes === 'object' && routing.author_routes !== null
    ? routing.author_routes as Record<string, unknown>
    : {}
  if (Object.keys(current).length > 0) return false

  const entry = `  author_routes:\n    ${login}: claude  # auto-detected from gh auth\n`

  // Case 1: commented-out placeholder block from the example config
  const uncommented = content.replace(
    /  # author_routes:\n(  #[^\n]*\n)*/,
    entry,
  )
  if (uncommented !== content) { writeFileSync(configPath, uncommented); return true }

  // Case 2: inline empty map — `author_routes: {}` or `author_routes: { }`
  const filledInline = content.replace(/( {2}author_routes:\s*\{\s*\}\s*\n)/, entry)
  if (filledInline !== content) { writeFileSync(configPath, filledInline); return true }

  // Case 3: key exists but map is empty (no entries, only optional comment lines)
  const filledEmpty = content.replace(/(  author_routes:\s*\n)((?:  #[^\n]*\n)*)/, entry)
  if (filledEmpty !== content) { writeFileSync(configPath, filledEmpty); return true }

  // Case 4: routing: section exists but author_routes is absent — insert after routing:
  const appended = content.replace(/(routing:\s*\n)/, `$1${entry}`)
  if (appended !== content) { writeFileSync(configPath, appended); return true }

  // Case 5: no routing: section at all — append a new block
  if (!/^routing:/m.test(content)) {
    writeFileSync(configPath, content.trimEnd() + `\nrouting:\n${entry}`)
    return true
  }

  return false
}

// ── Deployment mode ──────────────────────────────────────────────────────────

export async function promptDeploymentMode(
  current?: 'personal' | 'team',
): Promise<'personal' | 'team'> {
  if (!process.stdin.isTTY) return 'personal'

  return new Promise<'personal' | 'team'>(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    console.log('\nHow are you using crosscheck?\n')
    console.log('  [1] personal  — monitor all your repos and orgs; review only PRs you author')
    console.log('  [2] team      — monitor org repos only; review all PRs from any author')
    if (current) console.log(`\n  Current: ${current}`)
    console.log()
    rl.question('  Choice [1]: ', (answer) => {
      rl.close()
      resolve(answer.trim() === '2' ? 'team' : 'personal')
    })
  })
}

export async function detectScopesForDeployment(
  deployment: 'personal' | 'team',
  token: string,
): Promise<{ login: string; users: string[]; orgs: string[] }> {
  const login = detectGitHubLogin() ?? ''
  const orgs = await listUserOrgs(token)
  return {
    login,
    users: deployment === 'personal' && login ? [login] : [],
    orgs,
  }
}

// Writes deployment, orgs, users, and allowed_authors to the config file.
// If force=false, skips silently when deployment is already set.
// Uses yaml.load/dump so all non-deployment values (quality, budget, etc.) are preserved.
export function patchDeploymentConfig(
  configPath: string,
  deployment: 'personal' | 'team',
  login: string,
  orgs: string[],
  force = false,
): boolean {
  if (!existsSync(configPath)) {
    const obj: Record<string, unknown> = { deployment, orgs }
    if (deployment === 'personal' && login) {
      obj.users = [login]
      obj.routing = {
        allowed_authors: [login],
        author_routes: { [login]: 'claude' },
        fallback_reviewer: 'auto',
      }
    } else {
      obj.routing = { fallback_reviewer: 'auto' }
    }
    writeFileSync(configPath, yaml.dump(obj, { lineWidth: -1, noRefs: true }))
    return true
  }

  const raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
  if (raw.deployment && !force) return false

  raw.deployment = deployment

  // Update orgs unless user has already set non-example values
  const EXAMPLE_ORGS = new Set(['humanbased-ai', 'codatta'])
  const currentOrgs = Array.isArray(raw.orgs) ? (raw.orgs as string[]) : []
  const hasCustomOrgs = currentOrgs.length > 0 && currentOrgs.some(o => !EXAMPLE_ORGS.has(o))
  if (force || !hasCustomOrgs) raw.orgs = orgs

  // Update users
  const currentUsers = Array.isArray(raw.users) ? (raw.users as string[]) : []
  if (deployment === 'personal' && login && (force || currentUsers.length === 0)) {
    raw.users = [login]
  } else if (deployment === 'team' && force) {
    delete raw.users
  }

  // Update routing.allowed_authors, author_routes, fallback_reviewer
  if (!raw.routing || typeof raw.routing !== 'object') raw.routing = {}
  const routing = raw.routing as Record<string, unknown>
  const currentAuthors = Array.isArray(routing.allowed_authors) ? (routing.allowed_authors as string[]) : []
  if (deployment === 'personal' && login && (force || currentAuthors.length === 0)) {
    routing.allowed_authors = [login]
  } else if (deployment === 'team' && force) {
    routing.allowed_authors = []
  }

  // author_routes: in personal mode, map the owner's login → 'claude' as a fallback
  // when no attribution footer or commit trailer is present on their PRs.
  const currentRoutes = typeof routing.author_routes === 'object' && routing.author_routes !== null
    ? routing.author_routes as Record<string, string>
    : {}
  if (deployment === 'personal' && login && (force || Object.keys(currentRoutes).length === 0)) {
    routing.author_routes = { [login]: 'claude' }
  } else if (deployment === 'team' && force) {
    delete routing.author_routes
  }

  // fallback_reviewer: default to 'auto' unless already set
  if (routing.fallback_reviewer === undefined || force) {
    routing.fallback_reviewer = 'auto'
  }

  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
  return true
}

// ── Onboarding ───────────────────────────────────────────────────────────────

export interface OnboardAnswers {
  deployment: 'personal' | 'team'
  login: string
  orgs: string[]
  users: string[]
  repos: Array<{ owner: string; name: string }>
  allowedAuthors: string[]
  authorRoutes: Record<string, 'claude' | 'codex'>
  deliveryMode: 'pull_request' | 'commit' | 'comment'
  brand: { service_name: string; comment_header: string; comment_footer: string; reviewer_attribution: string }
}

// Applies all onboard answers to the config file, preserving unrelated fields.
export function writeOnboardConfig(configPath: string, answers: OnboardAnswers): void {
  let raw: Record<string, unknown> = {}
  if (existsSync(configPath)) {
    try { raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown> }
    catch { /* start fresh if file is unparseable */ }
  }

  raw.deployment = answers.deployment
  raw.orgs = answers.orgs

  if (answers.users.length > 0) raw.users = answers.users
  else delete raw.users

  if (answers.repos.length > 0) raw.repos = answers.repos
  else delete raw.repos

  if (typeof raw.routing !== 'object' || raw.routing === null) raw.routing = {}
  const routing = raw.routing as Record<string, unknown>
  routing.allowed_authors = answers.allowedAuthors
  if (Object.keys(answers.authorRoutes).length > 0) routing.author_routes = answers.authorRoutes
  else delete routing.author_routes
  if (!routing.fallback_reviewer) routing.fallback_reviewer = 'auto'

  if (typeof raw.post_review !== 'object' || raw.post_review === null) raw.post_review = {}
  const postReview = raw.post_review as Record<string, unknown>
  if (typeof postReview.auto_fix !== 'object' || postReview.auto_fix === null) postReview.auto_fix = {}
  const af = postReview.auto_fix as Record<string, unknown>
  // Remove stale fields from old schema — workflow.yml now controls step sequencing
  delete af.enabled
  delete af.trigger
  delete af.fixer
  if (typeof af.delivery !== 'object' || af.delivery === null) af.delivery = {}
  ;(af.delivery as Record<string, unknown>).mode = answers.deliveryMode

  const { service_name, comment_header, comment_footer, reviewer_attribution } = answers.brand
  const hasBrand = service_name !== 'crosscheck' || comment_header !== '' || comment_footer !== '' || reviewer_attribution !== ''
  if (hasBrand) raw.brand = answers.brand
  else delete raw.brand

  mkdirSync(dirname(configPath), { recursive: true })
  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
}

export function patchBrandConfig(
  configPath: string,
  brand: Partial<{ service_name: string; comment_header: string; comment_footer: string; reviewer_attribution: string }>,
): boolean {
  if (!existsSync(configPath)) return false
  const raw = (yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>
  if (typeof raw.brand !== 'object' || raw.brand === null) raw.brand = {}
  Object.assign(raw.brand as Record<string, unknown>, brand)
  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))
  return true
}
