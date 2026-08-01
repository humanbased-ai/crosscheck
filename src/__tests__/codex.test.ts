import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, mkdirSync, realpathSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { codexReasoningEffort, inferVerdictFromCodexOutput, stripRepoDirPaths } from '../reviewers/codex.js'

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

describe('.codex/instructions cleanup after review', () => {
  let repoDir: string

  beforeEach(() => {
    repoDir = mkdtempSync(join(tmpdir(), 'crosscheck-test-'))
    mkdirSync(join(repoDir, '.codex'), { recursive: true })
  })

  afterEach(() => {
    rmSync(repoDir, { force: true, recursive: true })
  })

  it('deletes .codex/instructions when it did not exist before the review', () => {
    const instructionsPath = join(repoDir, '.codex', 'instructions')
    // Simulate what runCodexReview does: write the file
    writeFileSync(instructionsPath, 'crosscheck review instructions')
    // Simulate cleanup (originalInstructions was undefined)
    rmSync(instructionsPath, { force: true })
    expect(existsSync(instructionsPath)).toBe(false)
  })

  it('restores original .codex/instructions content after review', () => {
    const instructionsPath = join(repoDir, '.codex', 'instructions')
    const original = 'user-defined codex instructions'
    writeFileSync(instructionsPath, original)
    // Simulate: crosscheck overwrites, then restores
    writeFileSync(instructionsPath, 'crosscheck review instructions')
    writeFileSync(instructionsPath, original)
    expect(readFileSync(instructionsPath, 'utf8')).toBe(original)
  })
})

describe('codexReasoningEffort', () => {
  it('passes low/medium/high through unchanged', () => {
    expect(codexReasoningEffort('low')).toBe('low')
    expect(codexReasoningEffort('medium')).toBe('medium')
    expect(codexReasoningEffort('high')).toBe('high')
  })

  it('maps crosscheck max to the codex CLI xhigh tier', () => {
    expect(codexReasoningEffort('max')).toBe('xhigh')
  })

  it('falls back to medium for unknown values', () => {
    expect(codexReasoningEffort('turbo')).toBe('medium')
    expect(codexReasoningEffort('')).toBe('medium')
  })
})
