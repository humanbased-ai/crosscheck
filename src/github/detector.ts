import type { Config } from '../config/schema.js'
import { getPRCommits } from './client.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { checkOpenCodeAuth } from '../reviewers/opencode.js'

export type PROrigin = 'claude' | 'codex' | 'opencode' | 'human'

// Crosscheck's own attribution on work crosscheck wrote. Not part of
// routing.*_reviews_patterns on purpose: Zod defaults apply only when a field is
// absent, so an install that pinned its own pattern list would never receive
// these and would keep reading its own fix PRs as human. This is a fact about
// output crosscheck produced — same footing as the annotation contract — not a
// routing preference, so it is always checked.
//
// Authorship only. The 'Reviewed' footer says who looked at the code and the
// 'Attempted' footer marks a fix that failed and produced nothing; neither is
// evidence of authorship, and matching them would route every reviewed PR back
// to the other vendor as if it were agent-authored.
const SELF_AUTHORED_PATTERNS: ReadonlyArray<{ pattern: RegExp; origin: PROrigin }> = [
  // Fix-PR body footer — buildAttributionFooter({ action: 'Fixed', ... }).
  { pattern: /Fixed with \[Claude Code\]/i, origin: 'claude' },
  { pattern: /Fixed with \[OpenAI Codex\]/i, origin: 'codex' },
  { pattern: /Fixed with \[OpenCode\]/i, origin: 'opencode' },
  // Commit trailer — buildCommitTrailers on fix and conflict-resolve commits.
  // Anchored to its own line: the field name is quoted in prose (this repo's
  // changelog and docs do it), and prose is not a trailer.
  { pattern: /^Crosscheck-Reviewer:[^\S\n]*claude[^\S\n]*$/im, origin: 'claude' },
  { pattern: /^Crosscheck-Reviewer:[^\S\n]*codex[^\S\n]*$/im, origin: 'codex' },
  { pattern: /^Crosscheck-Reviewer:[^\S\n]*opencode[^\S\n]*$/im, origin: 'opencode' },
]

// Applies codex_reviews_patterns / claude_reviews_patterns against a single text
// block, then crosscheck's own always-on markers. Configured patterns are
// checked first: they are explicit routing intent and outrank the default.
// Returns the detected origin or null if nothing matched.
function matchPatterns(text: string, config: Config): PROrigin | null {
  for (const pattern of config.routing.codex_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(text)) return 'claude'
  }
  for (const pattern of config.routing.claude_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(text)) return 'codex'
  }
  for (const pattern of config.routing.opencode_reviews_patterns) {
    if (new RegExp(pattern, 'i').test(text)) return 'opencode'
  }
  for (const { pattern, origin } of SELF_AUTHORED_PATTERNS) {
    if (pattern.test(text)) return origin
  }
  return null
}

// Step 1 — PR body patterns
export function detectOriginFromBody(prBody: string, config: Config): PROrigin | null {
  return matchPatterns(prBody ?? '', config)
}

// Step 2 — commit Co-Authored-By trailers (fetched separately, passed in)
export function detectOriginFromCommits(messages: string[], config: Config): PROrigin | null {
  for (const msg of messages) {
    const result = matchPatterns(msg, config)
    if (result !== null) return result
  }
  return null
}

// Step 3 — branch name prefix
export function detectOriginFromBranch(headRef: string, config: Config): PROrigin | null {
  for (const prefix of config.routing.claude_branch_prefixes) {
    if (headRef.startsWith(prefix)) return 'claude'
  }
  for (const prefix of config.routing.codex_branch_prefixes) {
    if (headRef.startsWith(prefix)) return 'codex'
  }
  for (const prefix of config.routing.opencode_branch_prefixes) {
    if (headRef.startsWith(prefix)) return 'opencode'
  }
  return null
}

// Full detection chain: body → commits → branch → author_routes → human
// API failure on the commits fetch is non-fatal; falls through to branch check.
//
// author_routes semantics differ by mode:
//   - single-vendor mode: applies normally (only one vendor reviews anyway, so a wrong
//     guess just means an unwanted review, never a wrong-vendor review).
//   - cross-vendor mode with both vendors enabled: author_routes is demoted — when the
//     user actively uses multiple agents, a static author→vendor map will route the
//     other agent's PRs to the wrong reviewer. We fall through to fallback_reviewer
//     instead, which can be set to a single vendor or 'skip' to handle this case
//     explicitly.
export async function detectOriginFull(
  prBody: string,
  headRef: string,
  owner: string,
  repo: string,
  prNumber: number,
  config: Config,
  token: string,
  author?: string,
): Promise<{ origin: PROrigin; method: string }> {
  const fromBody = detectOriginFromBody(prBody, config)
  if (fromBody !== null) return { origin: fromBody, method: 'body' }

  try {
    const messages = await getPRCommits(owner, repo, prNumber, token)
    const fromCommits = detectOriginFromCommits(messages, config)
    if (fromCommits !== null) return { origin: fromCommits, method: 'commits' }
  } catch { /* API failure — fall through */ }

  const fromBranch = detectOriginFromBranch(headRef, config)
  if (fromBranch !== null) return { origin: fromBranch, method: 'branch' }

  if (author && config.routing.author_routes[author]) {
    // Any two vendors enabled in cross-vendor mode defeat a static author→vendor
    // map (the author may write via either), not just the claude+codex pair.
    const enabledVendors = [config.vendors.claude, config.vendors.codex, config.vendors.opencode]
      .filter(v => v.enabled).length
    const bypassed = config.mode === 'cross-vendor' && enabledVendors >= 2
    if (!bypassed) {
      return { origin: config.routing.author_routes[author], method: 'author_routes' }
    }
    // Cross-vendor with multiple vendors enabled: log the bypass so users can spot
    // it in logs without changing reviewer selection silently.
    return { origin: 'human', method: 'author_routes_bypassed' }
  }

  return { origin: 'human', method: 'none' }
}

// Backward-compatible sync variant (body + author_routes only).
// Use detectOriginFull for the full async chain.
export function detectPROrigin(prBody: string, config: Config, author?: string): PROrigin {
  return detectOriginFromBody(prBody, config)
    ?? (author ? (config.routing.author_routes[author] ?? null) : null)
    ?? 'human'
}

async function resolveFallback(config: Config): Promise<'claude' | 'codex' | 'opencode' | null> {
  const fb = config.routing.fallback_reviewer
  if (fb === null) return null
  if (fb === 'codex') return config.vendors.codex.enabled ? 'codex' : null
  if (fb === 'claude') return config.vendors.claude.enabled ? 'claude' : null
  if (fb === 'opencode') return config.vendors.opencode.enabled ? 'opencode' : null
  // 'auto': use runtime capability checks so a Claude-only install doesn't
  // attempt Codex just because both vendors are enabled in config by default.
  // OpenCode is opt-in, so its auth check alone is not enough — a configured
  // opt-out must never be overridden by an authenticated CLI.
  const [codexAuth, claudeAuth, opencodeAuth] = await Promise.all([checkCodexAuth(), checkClaudeAuth(), checkOpenCodeAuth()])
  if (codexAuth.ok) return 'codex'
  if (claudeAuth.ok) return 'claude'
  if (opencodeAuth.ok && config.vendors.opencode.enabled) return 'opencode'
  return null
}

export async function assignReviewer(origin: PROrigin, config: Config): Promise<'claude' | 'codex' | 'opencode' | null> {
  if (config.mode === 'single-vendor') {
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    if (config.vendors.opencode.enabled) return 'opencode'
    return null
  }
  if (origin === 'claude') {
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.opencode.enabled) return 'opencode'
  }
  if (origin === 'codex') {
    if (config.vendors.claude.enabled) return 'claude'
    if (config.vendors.opencode.enabled) return 'opencode'
  }
  if (origin === 'opencode') {
    if (config.vendors.claude.enabled) return 'claude'
    if (config.vendors.codex.enabled) return 'codex'
  }
  if (origin === 'human') return resolveFallback(config)
  return null
}
