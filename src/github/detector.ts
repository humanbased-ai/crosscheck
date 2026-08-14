import type { Config } from '../config/schema.js'
import { getPRCommits } from './client.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'

export type PROrigin = 'claude' | 'codex' | 'human'

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
  // Commit trailer — buildCommitTrailers on fix and conflict-resolve commits.
  // Anchored to its own line: the field name is quoted in prose (this repo's
  // changelog and docs do it), and prose is not a trailer.
  { pattern: /^Crosscheck-Reviewer:[^\S\n]*claude[^\S\n]*$/im, origin: 'claude' },
  { pattern: /^Crosscheck-Reviewer:[^\S\n]*codex[^\S\n]*$/im, origin: 'codex' },
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
    const bothEnabled = config.mode === 'cross-vendor'
      && config.vendors.claude.enabled
      && config.vendors.codex.enabled
    if (!bothEnabled) {
      return { origin: config.routing.author_routes[author], method: 'author_routes' }
    }
    // Cross-vendor with both vendors enabled: log the bypass so users can spot it
    // in logs without changing reviewer selection silently.
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

async function resolveFallback(config: Config): Promise<'claude' | 'codex' | null> {
  const fb = config.routing.fallback_reviewer
  if (fb === null) return null
  if (fb === 'codex') return config.vendors.codex.enabled ? 'codex' : null
  if (fb === 'claude') return config.vendors.claude.enabled ? 'claude' : null
  // 'auto': use runtime capability checks so a Claude-only install doesn't
  // attempt Codex just because both vendors are enabled in config by default.
  const [codexAuth, claudeAuth] = await Promise.all([checkCodexAuth(), checkClaudeAuth()])
  if (codexAuth.ok) return 'codex'
  if (claudeAuth.ok) return 'claude'
  return null
}

export async function assignReviewer(origin: PROrigin, config: Config): Promise<'claude' | 'codex' | null> {
  if (config.mode === 'single-vendor') {
    if (config.vendors.codex.enabled) return 'codex'
    if (config.vendors.claude.enabled) return 'claude'
    return null
  }
  if (origin === 'claude' && config.vendors.codex.enabled) return 'codex'
  if (origin === 'codex' && config.vendors.claude.enabled) return 'claude'
  if (origin === 'human') return resolveFallback(config)
  return null
}
