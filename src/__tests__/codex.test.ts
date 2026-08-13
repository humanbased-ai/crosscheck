import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, rmSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { buildCodexReviewPrompt, codexReasoningEffort, inferVerdictFromCodexOutput, parseCodexTokensUsed, stripRepoDirPaths } from '../reviewers/codex.js'

const CODEX_FOOTER = '\n\n---\n_Reviewed with [OpenAI Codex](https://openai.com/codex)_'

describe('inferVerdictFromCodexOutput', () => {
  it('returns BLOCK when P0 is present alone', () => {
    const text = `Release-blocking issue.\n\n- [P0] Data loss bug — src/db.ts:5\n  Fix this.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns BLOCK when P0 present alongside lower levels', () => {
    const text = `Issues found.\n\n- [P0] Critical\n- [P2] Minor${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns BLOCK when P1 is present', () => {
    const text = `Critical issue found.\n\n- [P1] Broken auth — src/auth.ts:12\n  Fix this.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns BLOCK when P1 present alongside P2/P3', () => {
    const text = `Issues found.\n\n- [P1] Security issue\n- [P2] Minor issue\n- [P3] Nit${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('BLOCK')
  })

  it('returns NEEDS WORK when only P2 is present', () => {
    const text = `Issues found.\n\n- [P2] Missing validation — src/api.ts:45\n  Add this.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns NEEDS WORK when only P3 is present', () => {
    const text = `Minor issue.\n\n- [P3] Rename variable — src/util.ts:10${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns NEEDS WORK when P2 and P3 present, no P1', () => {
    const text = `Issues.\n\n- [P2] Fix bug\n- [P3] Nit${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('NEEDS WORK')
  })

  it('returns APPROVE when no priority markers present', () => {
    const text = `The changes look correct and complete.${CODEX_FOOTER}`
    expect(inferVerdictFromCodexOutput(text)).toBe('APPROVE')
  })

  it('does not double-append when VERDICT already present', () => {
    // The caller guards against re-appending — verify inference is case-insensitive
    expect(inferVerdictFromCodexOutput('[p1] issue')).toBe('BLOCK')
    expect(inferVerdictFromCodexOutput('[P2] issue')).toBe('NEEDS WORK')
  })

  it('is case-insensitive for [p0]/[p1]/[p2]/[p3]', () => {
    expect(inferVerdictFromCodexOutput('[p1] issue')).toBe('BLOCK')
    expect(inferVerdictFromCodexOutput('[P2] issue')).toBe('NEEDS WORK')
  })

  it('infers correctly from real Codex output shape (motivation-form PR #90)', () => {
    const realOutput = `The added guidance contains copy-paste survey templates that default to form mode.

Full review comments:

- [P2] Keep survey examples in survey mode — /tmp/repo/agent-guide.mdx:431-433
  Add \`type: survey\` near the top of each template.

- [P3] Move detached media-url row back into table — /tmp/repo/agent-guide.mdx:686-686
  This row renders as a stray paragraph.

---
_Reviewed with [OpenAI Codex](https://openai.com/codex)_`
    expect(inferVerdictFromCodexOutput(realOutput)).toBe('NEEDS WORK')
  })
})

describe('stripRepoDirPaths', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'crosscheck-repo-'))
  })

  afterEach(() => {
    rmSync(repoDir, { force: true, recursive: true })
  })

  it('strips the repo dir prefix, leaving repo-relative paths', () => {
    const text = `[P2] Preserve the payer — ${repoDir}/services/executor/store.go:428-428\nFix it.`
    expect(stripRepoDirPaths(text, repoDir)).toBe(
      '[P2] Preserve the payer — services/executor/store.go:428-428\nFix it.',
    )
  })

  it('strips the realpath variant of the repo dir (macOS /var → /private/var)', () => {
    // mkdtempSync returns the symlinked path on macOS; codex prints the resolved one
    const resolved = realpathSync(repoDir)
    const text = `[P2] Guard settled rows — ${resolved}/internal/store.go:523-523`
    expect(stripRepoDirPaths(text, repoDir)).toBe('[P2] Guard settled rows — internal/store.go:523-523')
  })

  it('strips every occurrence, not just the first', () => {
    const text = `${repoDir}/a.ts:1 and ${repoDir}/b.ts:2`
    expect(stripRepoDirPaths(text, repoDir)).toBe('a.ts:1 and b.ts:2')
  })

  it('leaves unrelated absolute paths untouched', () => {
    const text = 'See /etc/hosts and /usr/local/bin/codex'
    expect(stripRepoDirPaths(text, repoDir)).toBe(text)
  })

  it('does not throw when the repo dir no longer exists', () => {
    const gone = join(repoDir, 'deleted-subdir')
    expect(stripRepoDirPaths(`${gone}/x.ts:1`, gone)).toBe('x.ts:1')
  })
})

describe('codexReasoningEffort', () => {
  it('passes every codex CLI tier through unchanged', () => {
    expect(codexReasoningEffort('low')).toBe('low')
    expect(codexReasoningEffort('medium')).toBe('medium')
    expect(codexReasoningEffort('high')).toBe('high')
    expect(codexReasoningEffort('xhigh')).toBe('xhigh')
    expect(codexReasoningEffort('max')).toBe('max')
    expect(codexReasoningEffort('ultra')).toBe('ultra')
  })

  it('falls back to medium for values outside the whitelist', () => {
    expect(codexReasoningEffort('turbo')).toBe('medium')
    expect(codexReasoningEffort('')).toBe('medium')
  })
})

describe('buildCodexReviewPrompt', () => {
  const base = {
    prTitle: 'feat: add lineage drawer',
    baseBranch: 'staging',
    behaviorInstructions: 'Structure your output as: ## Summary.\nVERDICT: APPROVE',
  }

  // `codex review --base` scoped the diff itself. `codex exec` does not, so the
  // prompt has to say what to review — same two opening lines claude gets, so a
  // PR reviewed by either vendor is given the same brief.
  it('names the PR and the base branch, and scopes the review to the PR', () => {
    const prompt = buildCodexReviewPrompt(base)
    expect(prompt).toContain('feat: add lineage drawer')
    expect(prompt).toContain('`staging` is the base')
    expect(prompt).toContain('Review only the changes introduced in this PR')
  })

  it('always ends with the behaviour block so the verdict rule is last', () => {
    // The verdict rule is the final line of behaviorInstructions and is
    // machine-parsed. Repository guidance is reference material, so it is the
    // one block allowed after it.
    const prompt = buildCodexReviewPrompt({ ...base, skillInstructions: '## Agent Skills\nCall list_enabled_skills.' })
    expect(prompt.indexOf('## Agent Skills')).toBeLessThan(prompt.indexOf('VERDICT: APPROVE'))
  })

  it('places skill instructions before the behaviour block', () => {
    // Activation has to happen before the review starts; after the verdict rule
    // it reads as boilerplate past the end of the prompt.
    const prompt = buildCodexReviewPrompt({
      ...base,
      skillInstructions: '## Agent Skills\nCall list_enabled_skills.',
      repositoryGuidance: '## Repo guidance\nPrefer X.',
    })
    expect(prompt.indexOf('## Agent Skills')).toBeLessThan(prompt.indexOf('## Summary'))
    expect(prompt.indexOf('## Repo guidance')).toBeGreaterThan(prompt.indexOf('VERDICT: APPROVE'))
  })

  it('includes focus, custom prompt and issue context when supplied', () => {
    const prompt = buildCodexReviewPrompt({
      ...base,
      issueContext: 'Tracker: IN-3243 — show lineage.',
      focusLine: 'Focus areas: security, types.',
      customPrompt: 'Be concise.',
    })
    expect(prompt).toContain('IN-3243')
    expect(prompt).toContain('Focus areas: security, types.')
    expect(prompt).toContain('Be concise.')
  })

  it('omits absent blocks without leaving blank runs', () => {
    const prompt = buildCodexReviewPrompt(base)
    expect(prompt).not.toMatch(/\n{3,}/)
  })
})

describe('parseCodexTokensUsed', () => {
  // `codex exec` reports usage as a "tokens used" heading with the count on the
  // next line; `codex review` used an inline "tokens: N". Both are accepted so
  // the telemetry survived the move between subcommands.
  it('reads the codex exec two-line form', () => {
    expect(parseCodexTokensUsed('codex\nreview text\ntokens used\n15,646\n')).toBe(15646)
  })

  it('reads the inline form', () => {
    expect(parseCodexTokensUsed('some output\ntokens: 4,200')).toBe(4200)
  })

  it('is case-insensitive and tolerates no thousands separator', () => {
    expect(parseCodexTokensUsed('Tokens Used\n900')).toBe(900)
  })

  it('returns undefined when no usage line is present', () => {
    expect(parseCodexTokensUsed('just a review, no usage line')).toBeUndefined()
  })

  it('returns undefined rather than reading an unrelated number', () => {
    // "tokens" appearing in review prose must not be mistaken for usage.
    expect(parseCodexTokensUsed('The parser splits tokens by whitespace, all 12 of them.')).toBeUndefined()
  })

  it('takes the last report when a run retried', () => {
    expect(parseCodexTokensUsed('tokens used\n100\nretry\ntokens used\n250')).toBe(250)
  })
})
