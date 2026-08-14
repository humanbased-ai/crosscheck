import { describe, it, expect, vi } from 'vitest'
import * as detector from '../github/detector.js'
import { detectOriginFromBody, detectOriginFromBranch, detectOriginFromCommits, detectOriginFull, assignReviewer } from '../github/detector.js'
import { ConfigSchema, type Config } from '../config/schema.js'
import { buildAttributionFooter } from '../lib/comment-bodies.js'
import { buildCommitTrailers } from '../lib/annotation.js'

function buildConfig(overrides: Record<string, unknown> = {}): Config {
  return ConfigSchema.parse({
    mode: 'cross-vendor',
    vendors: { claude: { enabled: true }, codex: { enabled: true } },
    ...overrides,
  })
}

vi.mock('../github/client.js', () => ({
  getPRCommits: vi.fn(async () => []),
}))

describe('detectOriginFromBody', () => {
  it('detects claude origin from PR body footer', () => {
    expect(detectOriginFromBody('Generated with [Claude Code]', buildConfig())).toBe('claude')
  })

  it('detects codex origin from PR body footer', () => {
    expect(detectOriginFromBody('Generated with [OpenAI Codex]', buildConfig())).toBe('codex')
  })

  it('returns null when no pattern matches', () => {
    expect(detectOriginFromBody('just a normal PR body', buildConfig())).toBeNull()
  })
})

// Crosscheck was blind to the PRs and commits it writes itself: its fix-PR body
// says "Fixed with [Claude Code]", not "Generated with [Claude Code]", and its
// commits carry Crosscheck-* trailers rather than Co-Authored-By. Such a PR
// detected as origin:human, which skipped conflict-resolve for want of a vendor.
// These build their fixtures with the real producers so the patterns cannot
// drift away from the strings crosscheck actually emits.
describe('origin detection recognises crosscheck-authored work', () => {
  const fixPrBody = (vendor: 'claude' | 'codex'): string => [
    'Auto-fix by crosscheck for CR issues found in #2444.',
    '',
    'Review: https://github.com/owner/repo/pull/2444',
    '',
    buildAttributionFooter({ action: 'Fixed', vendor, model: 'claude-sonnet-5', effort: 'high' }),
  ].join('\n')

  it('detects claude origin from a crosscheck fix-PR body', () => {
    expect(detectOriginFromBody(fixPrBody('claude'), buildConfig())).toBe('claude')
  })

  it('detects codex origin from a crosscheck fix-PR body', () => {
    expect(detectOriginFromBody(fixPrBody('codex'), buildConfig())).toBe('codex')
  })

  it('detects claude origin from a crosscheck commit trailer', () => {
    const message = [
      '[crosscheck] fix: apply CR fixes from review of PR #2444',
      '',
      buildCommitTrailers({ reviewer: 'claude', model: 'claude-sonnet-5', step: 'fix', service: 'crosscheck' }),
    ].join('\n')
    expect(detectOriginFromCommits([message], buildConfig())).toBe('claude')
  })

  it('detects codex origin from a crosscheck commit trailer', () => {
    const message = [
      '[crosscheck] fix: apply CR fixes from review of PR #2444',
      '',
      buildCommitTrailers({ reviewer: 'codex', model: 'gpt-5.6-sol', step: 'fix', service: 'crosscheck' }),
    ].join('\n')
    expect(detectOriginFromCommits([message], buildConfig())).toBe('codex')
  })

  // The load-bearing negative: reviewing a PR says nothing about who wrote it.
  // A pattern loose enough to match "Reviewed with [Claude Code]" would route
  // every claude-reviewed PR back to codex as if claude had authored it.
  it('does not treat a review attribution as authorship', () => {
    const reviewFooter = buildAttributionFooter({ action: 'Reviewed', vendor: 'claude', model: 'opus' })
    expect(detectOriginFromBody(reviewFooter, buildConfig())).toBeNull()
  })

  // 'Attempted' is the footer on a fix that failed — no code was produced, so it
  // is no evidence of authorship either.
  it('does not treat a failed fix attribution as authorship', () => {
    const attemptedFooter = buildAttributionFooter({ action: 'Attempted', vendor: 'claude', model: 'opus' })
    expect(detectOriginFromBody(attemptedFooter, buildConfig())).toBeNull()
  })

  it('leaves an ordinary human PR body undetected', () => {
    expect(detectOriginFromBody('Fixed the crosscheck config so the reviewer picks up.', buildConfig())).toBeNull()
  })

  // Recognising crosscheck's own output is a fact about that output, not a
  // routing preference, so it does not live in routing.*_reviews_patterns: Zod
  // defaults apply only when a field is absent, so an install that pinned its
  // own pattern list would never receive these and would keep reading its own
  // fix PRs as human — the exact misclassification this fixes.
  const pinnedPatterns = buildConfig({
    routing: { codex_reviews_patterns: ['^ONLY-THIS$'], claude_reviews_patterns: ['^ONLY-THAT$'] },
  })

  it('recognises its own fix-PR body even when the pattern lists are pinned', () => {
    expect(detectOriginFromBody(fixPrBody('claude'), pinnedPatterns)).toBe('claude')
    expect(detectOriginFromBody(fixPrBody('codex'), pinnedPatterns)).toBe('codex')
  })

  it('recognises its own commit trailer even when the pattern lists are pinned', () => {
    const message = (vendor: 'claude' | 'codex'): string => [
      '[crosscheck] fix: apply CR fixes from review of PR #2444',
      '',
      buildCommitTrailers({ reviewer: vendor, model: 'm', step: 'fix', service: 'crosscheck' }),
    ].join('\n')
    expect(detectOriginFromCommits([message('claude')], pinnedPatterns)).toBe('claude')
    expect(detectOriginFromCommits([message('codex')], pinnedPatterns)).toBe('codex')
  })

  it('still lets a configured pattern win over the self-attribution', () => {
    // A user's own pattern is explicit routing intent and is checked first.
    const cfg = buildConfig({ routing: { claude_reviews_patterns: ['Auto-fix by crosscheck'] } })
    expect(detectOriginFromBody(fixPrBody('claude'), cfg)).toBe('codex')
  })

  it('does not read a Crosscheck-Reviewer mention inside prose as a trailer', () => {
    // The trailer is a line of its own. Quoting the field name in a PR body —
    // this repo's own docs and changelog do exactly that — must not attribute it.
    expect(detectOriginFromBody(
      'The commit carries a Crosscheck-Reviewer: claude trailer, which we now read.',
      buildConfig(),
    )).toBeNull()
  })
})

describe('detectOriginFromBranch', () => {
  it('detects claude origin from claude/ branch prefix', () => {
    expect(detectOriginFromBranch('claude/feat-foo', buildConfig())).toBe('claude')
  })

  it('detects codex origin from codex/ branch prefix', () => {
    expect(detectOriginFromBranch('codex/feat-foo', buildConfig())).toBe('codex')
  })

  it('returns null when no prefix matches', () => {
    expect(detectOriginFromBranch('feature/foo', buildConfig())).toBeNull()
  })
})

describe('detectOriginFull — author_routes behavior', () => {
  it('cross-vendor mode with both vendors enabled: bypasses author_routes', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('human')
    expect(result.method).toBe('author_routes_bypassed')
  })

  it('single-vendor mode: applies author_routes normally', async () => {
    const cfg = buildConfig({
      mode: 'single-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: false } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('claude')
    expect(result.method).toBe('author_routes')
  })

  it('cross-vendor with only one vendor enabled: applies author_routes normally', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: false } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('claude')
    expect(result.method).toBe('author_routes')
  })

  it('cross-vendor with both enabled: attribution signals still win over author_routes', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: { beingzy: 'claude' } },
    })
    const result = await detectOriginFull('', 'codex/feat', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('codex')
    expect(result.method).toBe('branch')
  })

  it('cross-vendor without author_routes: falls through to human', async () => {
    const cfg = buildConfig({
      mode: 'cross-vendor',
      vendors: { claude: { enabled: true }, codex: { enabled: true } },
      routing: { author_routes: {} },
    })
    const result = await detectOriginFull('', 'feature/foo', 'owner', 'repo', 1, cfg, 'token', 'beingzy')
    expect(result.origin).toBe('human')
    expect(result.method).toBe('none')
  })
})

describe('assignReviewer', () => {
  it('is the sole exported reviewability decision helper', () => {
    expect('shouldReview' in detector).toBe(false)
  })

  it('cross-vendor: claude origin → codex reviewer', async () => {
    expect(await assignReviewer('claude', buildConfig())).toBe('codex')
  })

  it('cross-vendor: codex origin → claude reviewer', async () => {
    expect(await assignReviewer('codex', buildConfig())).toBe('claude')
  })

  it('cross-vendor: explicit fallback_reviewer is honored for human origin', async () => {
    const cfg = buildConfig({
      routing: { fallback_reviewer: 'claude' },
    })
    expect(await assignReviewer('human', cfg)).toBe('claude')
  })

  it('cross-vendor: fallback_reviewer=null skips human-origin PRs', async () => {
    const cfg = buildConfig({
      routing: { fallback_reviewer: null },
    })
    expect(await assignReviewer('human', cfg)).toBeNull()
  })
})
