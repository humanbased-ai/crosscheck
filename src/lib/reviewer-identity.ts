import type { Config } from '../config/schema.js'
import { detectGitHubLogin, resolveGithubAppKey } from '../config/loader.js'
import {
  createGithubClient,
  getAppInfo,
  getBranchProtection,
  getDefaultBranch,
  probeGithubApp,
  readCodeowners,
} from '../github/client.js'

/** Who review comments are authored by, for the board and identity rows. */
export interface ReviewerIdentity {
  label: string
  kind: 'app' | 'user'
  appId?: number
}

export interface ReviewerIdentityReport {
  /** false only when an app is configured but cannot post. */
  ok: boolean
  detail: string
  fix?: string
  /** Non-failing remarks: self-review, or an advisory-only approval. */
  notes: string[]
}

const MAX_PROTECTION_REPOS = 5

/**
 * Display identity. Never throws: a broken app still has a name, and a board
 * that cannot resolve its own slug should not take the daemon down.
 */
export async function resolveReviewerIdentity(config: Config): Promise<ReviewerIdentity> {
  const app = config.github.app
  if (app.app_id === null) {
    const login = detectGitHubLogin()
    return { label: login ? `@${login}` : 'your GitHub token', kind: 'user' }
  }
  try {
    const key = resolveGithubAppKey(config)
    if (key) {
      const info = await getAppInfo({ appId: key.appId, privateKey: key.privateKey })
      return { label: `${info.slug}[bot]`, kind: 'app', appId: app.app_id }
    }
  } catch {
    // Fall through to the numeric label — the fix lives in ck auth app.
  }
  return { label: `app ${app.app_id}`, kind: 'app', appId: app.app_id }
}

/**
 * Whether reviews can be posted, and whether an app approval can actually
 * unblock a PR. The second part is the one that used to be learned the hard way:
 * a GitHub App cannot be a code owner, so `require_code_owner_reviews` makes
 * every bot approval advisory.
 */
export async function inspectReviewerIdentity(
  config: Config,
  options: { token?: string | null } = {},
): Promise<ReviewerIdentityReport> {
  const app = config.github.app
  const notes: string[] = []

  if (app.app_id === null) {
    const login = detectGitHubLogin()
    return {
      ok: true,
      detail: `${login ? `@${login}` : 'your GitHub token'} — comments post as you`,
      notes: ['reviews on your own PRs read as self-reviews — ck auth app --app-id <id> --key <pem>'],
    }
  }

  let key
  try {
    key = resolveGithubAppKey(config)
  } catch (err) {
    return {
      ok: false,
      detail: err instanceof Error ? err.message : String(err),
      fix: 'Diagnose with: ck auth app --check',
      notes,
    }
  }
  if (key === null) {
    return { ok: true, detail: 'your GitHub token', notes }
  }

  const firstRepo = config.repos[0]
  const probe = await probeGithubApp({
    key: { appId: key.appId, privateKey: key.privateKey },
    installationId: app.installation_id,
    ...(firstRepo ? { owner: firstRepo.owner, repo: firstRepo.name } : {}),
  })

  if (!probe.ok) {
    const failed = probe.checks.find(check => !check.ok)
    return {
      ok: false,
      detail: `${failed?.step ?? 'identity'}: ${failed?.detail ?? 'not usable'}`,
      ...(failed?.fix !== undefined && { fix: failed.fix }),
      notes,
    }
  }

  const report: ReviewerIdentityReport = {
    ok: true,
    detail: `${probe.login ?? `app ${app.app_id}`} — app ${app.app_id}`,
    notes,
  }
  if (options.token) {
    const advisory = await branchProtectionAdvisory(config, options.token)
    if (advisory) notes.push(advisory)
  }
  return report
}

/**
 * One-line warning for the first configured repo whose default branch requires a
 * code-owner approval, or null when nothing is protected that way or protection
 * cannot be read (no admin). Advisory only — never a failure.
 */
export async function branchProtectionAdvisory(config: Config, token: string): Promise<string | null> {
  const octokit = createGithubClient(token)
  const repos = config.repos.slice(0, MAX_PROTECTION_REPOS)

  const findings = await Promise.all(repos.map(async ({ owner, name }) => {
    const branch = await getDefaultBranch(octokit, owner, name)
    if (!branch) return null
    const protection = await getBranchProtection(octokit, owner, name, branch)
    if (!protection?.requiresCodeOwnerReview) return null
    const owners = await readCodeowners(octokit, owner, name, branch)
    return { repo: `${owner}/${name}`, branch, owners }
  }))

  const hits = findings.filter((finding): finding is NonNullable<typeof finding> => finding !== null)
  const first = hits[0]
  if (!first) return null

  const who = first.owners.length > 0 ? ` (CODEOWNERS: ${first.owners.slice(0, 3).join(' ')})` : ''
  const more = hits.length > 1 ? ` and ${hits.length - 1} more repo(s)` : ''
  return `${first.repo}@${first.branch} needs a code-owner approval${who}${more} — app approvals are advisory; a human must approve`
}
