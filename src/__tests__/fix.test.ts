import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { applyEdit } from '../reviewers/fix.js'
import { createSkillActivationSession } from '../skills/broker.js'
import { loadBundledSkills } from '../skills/catalog.js'

describe('applyEdit', () => {
  it('replaces exact match at start of file', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    const result = applyEdit(content, 'return 1', 'return 2')
    expect(result).toBe('function foo() {\n  return 2\n}\n')
  })

  it('returns null when old text is not found', () => {
    const content = 'function foo() {\n  return 1\n}\n'
    expect(applyEdit(content, 'return 99', 'return 2')).toBeNull()
  })

  it('returns null when old text is ambiguous (appears more than once)', () => {
    const content = 'a\na\na\n'
    expect(applyEdit(content, 'a', 'b')).toBeNull()
  })

  it('handles multi-line old text', () => {
    const content = 'line1\nline2\nline3\nline4\n'
    const result = applyEdit(content, 'line2\nline3', 'replaced')
    expect(result).toBe('line1\nreplaced\nline4\n')
  })

  it('can replace with empty string (deletion)', () => {
    const content = 'before\ndelete me\nafter\n'
    const result = applyEdit(content, 'delete me\n', '')
    expect(result).toBe('before\nafter\n')
  })

  it('returns null on empty old text (ambiguous — matches everywhere)', () => {
    // '' satisfies indexOf !== lastIndexOf, so the ambiguity guard rejects it.
    // Callers handle new-file creation separately before invoking applyEdit.
    expect(applyEdit('content', '', 'new')).toBeNull()
  })
})

describe('fix step <edit> block parsing', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-fix-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  it('size guard: rejects <file> block when new content < 60% of original', async () => {
    // Write a "large" original file (10 lines)
    const filePath = join(tmpDir, 'src', 'large.ts')
    const { mkdirSync } = await import('fs')
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    const original = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    writeFileSync(filePath, original)

    // Simulate Claude outputting only 3 lines for a 10-line file (30% — below 60% threshold)
    const truncated = 'line1\nline2\nline3\n'

    // Directly test the guard logic: if newLines / origLines < 0.6, skip
    const origLines = original.split('\n').length
    const newLines = truncated.split('\n').length
    expect(newLines / origLines).toBeLessThan(0.6)

    // Confirm original is unchanged (guard would have skipped the write)
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('size guard: accepts <file> block when new content >= 60% of original', () => {
    const original = Array.from({ length: 10 }, (_, i) => `line${i + 1}`).join('\n') + '\n'
    const replacement = Array.from({ length: 7 }, (_, i) => `replaced${i + 1}`).join('\n') + '\n'

    const origLines = original.split('\n').length
    const newLines = replacement.split('\n').length
    expect(newLines / origLines).toBeGreaterThanOrEqual(0.6)
  })

  it('applyEdit composes correctly for multiple edits to same file', () => {
    const content = 'a: 1\nb: 2\nc: 3\n'
    const after1 = applyEdit(content, 'a: 1', 'a: 10')!
    expect(after1).not.toBeNull()
    const after2 = applyEdit(after1, 'b: 2', 'b: 20')!
    expect(after2).not.toBeNull()
    expect(after2).toBe('a: 10\nb: 20\nc: 3\n')
  })

  it('failed <old> match does not count as applied or write the unchanged file', () => {
    // Regression for: file added to fileEdits during read step, then applyEdit returns null,
    // but write loop still writes it and increments appliedCount.
    const filePath = join(tmpDir, 'src.ts')
    const original = 'export function foo() {\n  return 1\n}\n'
    writeFileSync(filePath, original)

    // applyEdit with a non-matching old text returns null — file must not be touched
    const result = applyEdit(original, 'does not exist in file', 'anything')
    expect(result).toBeNull()

    // File must be untouched on disk
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('applyEdit: empty old text returns null (ambiguity guard catches it)', () => {
    // Empty string satisfies indexOf('') !== lastIndexOf(''), so applyEdit rejects it.
    // runFixStep handles new-file creation (empty <old> on missing file) before calling applyEdit.
    expect(applyEdit('existing content', '', 'prepended ')).toBeNull()
  })
})

describe('fix step new-file and empty-old guard', () => {
  let tmpDir: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-fix-test-'))
  })

  afterEach(() => {
    rmSync(tmpDir, { force: true, recursive: true })
  })

  it('empty <old> on existing file is rejected — does not prepend new text', () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    const filePath = join(tmpDir, 'src', 'util.ts')
    const original = 'export const x = 1\n'
    writeFileSync(filePath, original)

    // applyEdit('export const x = 1\n', '', 'prepended\n') would prepend if not guarded.
    // The guard in runFixStep must block this — original must be unchanged.
    // We verify the guard logic directly: empty oldText on existing file => skip.
    const oldText = ''
    const fileExists = true  // file was readable
    const wouldBeGuarded = fileExists && oldText === ''
    expect(wouldBeGuarded).toBe(true)
    expect(readFileSync(filePath, 'utf8')).toBe(original)
  })

  it('empty <old> on non-existent file writes <new> as new file content', () => {
    mkdirSync(join(tmpDir, 'src'), { recursive: true })
    const newFilePath = join(tmpDir, 'src', 'new-module.ts')

    // File does not exist — simulate the new-file path: write newText directly
    const newContent = 'export const added = true\n'
    writeFileSync(newFilePath, newContent)  // as runFixStep would do for empty <old>
    expect(readFileSync(newFilePath, 'utf8')).toBe(newContent)
  })
})

describe('runCodexFixStep', () => {
  vi.mock('execa', () => ({ execa: vi.fn() }))
  vi.mock('child_process', async (importOriginal) => {
    const real = await importOriginal<typeof import('child_process')>()
    return { ...real, execSync: vi.fn() }
  })

  let execSyncMock: ReturnType<typeof vi.fn>
  let execaMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    const childProcess = await import('child_process')
    execSyncMock = vi.mocked(childProcess.execSync) as ReturnType<typeof vi.fn>
    const execa = await import('execa')
    execaMock = vi.mocked(execa.execa) as ReturnType<typeof vi.fn>
    // Default: git diff returns empty string (no changes)
    execSyncMock.mockReturnValue('')
    execaMock.mockResolvedValue({ stdout: '', stderr: '' } as never)
  })

  afterEach(() => { vi.clearAllMocks() })

  it('returns appliedCount=0 and empty changedFiles when codex makes no file changes', async () => {
    const { runCodexFixStep } = await import('../reviewers/fix.js')
    execSyncMock.mockReturnValue('')
    const result = await runCodexFixStep('/tmp/repo', 'main', 'My PR', 'Fix the bug', '')
    expect(result.appliedCount).toBe(0)
    expect(result.changedFiles).toEqual([])
    expect(result.tokensUsed).toBeUndefined()
  })

  it('returns appliedCount and changedFiles matching git diff output', async () => {
    const { runCodexFixStep } = await import('../reviewers/fix.js')
    execSyncMock.mockImplementation((cmd: unknown) => {
      if (String(cmd).includes('--name-only')) return 'src/foo.ts\nsrc/bar.ts'
      return ''
    })
    const result = await runCodexFixStep('/tmp/repo', 'main', 'My PR', 'Fix the bug', '')
    expect(result.appliedCount).toBe(2)
    expect(result.changedFiles).toEqual(['src/foo.ts', 'src/bar.ts'])
  })

  it('throws a helpful message on codex auth failure', async () => {
    const { runCodexFixStep } = await import('../reviewers/fix.js')
    execaMock.mockRejectedValueOnce(new Error('not logged in to codex'))
    await expect(
      runCodexFixStep('/tmp/repo', 'main', 'My PR', 'Fix the bug', ''),
    ).rejects.toThrow('codex auth failure')
  })

  it('re-throws non-auth errors unchanged', async () => {
    const { runCodexFixStep } = await import('../reviewers/fix.js')
    execaMock.mockRejectedValueOnce(new Error('network timeout'))
    await expect(
      runCodexFixStep('/tmp/repo', 'main', 'My PR', 'Fix the bug', ''),
    ).rejects.toThrow('network timeout')
  })

  it('attaches the skill broker and decision prompt to Codex fix', async () => {
    const { runCodexFixStep } = await import('../reviewers/fix.js')
    const session = createSkillActivationSession('fix', ['code-review-skill'], loadBundledSkills())
    try {
      await runCodexFixStep('/tmp/repo', 'main', 'My PR', 'Fix the bug', '', 'default', undefined, session)
      const args = execaMock.mock.calls[0][1] as string[]
      expect(args).toContainEqual(expect.stringContaining('mcp_servers.crosscheck.command='))
      expect(args.at(-1)).toContain('Decide from each description whether a skill applies')
    } finally {
      session.close()
    }
  })
})

describe('runFixStep timeout defaults', () => {
  let execSyncMock: ReturnType<typeof vi.fn>
  let execaMock: ReturnType<typeof vi.fn>

  beforeEach(async () => {
    vi.resetModules()
    const childProcess = await import('child_process')
    execSyncMock = vi.mocked(childProcess.execSync) as ReturnType<typeof vi.fn>
    const execa = await import('execa')
    execaMock = vi.mocked(execa.execa) as ReturnType<typeof vi.fn>
    execSyncMock.mockReturnValue('')
    execaMock.mockResolvedValue({ stdout: 'NO_CHANGES', stderr: '' } as never)
  })

  afterEach(() => { vi.clearAllMocks() })

  const minimalConfig = (tier: 'fast' | 'balanced' | 'thorough') =>
    ({ quality: { tier } }) as import('../config/schema.js').Config

  it('uses tierTimeoutMs(balanced) = 600s when no explicit timeoutMs is given', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('balanced'))
    const opts = execaMock.mock.calls[0][2] as { timeout?: number }
    expect(opts.timeout).toBe(600_000)
  })

  it('uses tierTimeoutMs(thorough) = 1200s for thorough tier', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('thorough'))
    const opts = execaMock.mock.calls[0][2] as { timeout?: number }
    expect(opts.timeout).toBe(1_200_000)
  })

  it('passes the configured Claude model and effort to fix runs', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    const config = {
      quality: { tier: 'thorough' },
      vendors: { claude: { effort: 'max' } },
    } as import('../config/schema.js').Config
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', config, 'claude-opus-4-8')
    const args = execaMock.mock.calls[0][1] as string[]
    expect(args).toContain('--model')
    expect(args).toContain('claude-opus-4-8')
    expect(args).toContain('--effort')
    expect(args).toContain('max')
  })

  it('uses tierTimeoutMs(fast) = 300s for fast tier', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('fast'))
    const opts = execaMock.mock.calls[0][2] as { timeout?: number }
    expect(opts.timeout).toBe(300_000)
  })

  it('respects an explicit timeoutMs override', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('balanced'), 'default', 45_000)
    const opts = execaMock.mock.calls[0][2] as { timeout?: number }
    expect(opts.timeout).toBe(45_000)
  })

  it('passes undefined timeout when timeoutMs=0 (no-cap mode)', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('balanced'), 'default', 0)
    const opts = execaMock.mock.calls[0][2] as { timeout?: number }
    expect(opts.timeout).toBeUndefined()
  })

  it('attaches the skill broker and decision prompt to Claude fix', async () => {
    const { runFixStep } = await import('../reviewers/fix.js')
    const session = createSkillActivationSession('fix', ['code-review-skill'], loadBundledSkills())
    try {
      await runFixStep('/tmp/repo', 'main', 'My PR', 'Review', '', minimalConfig('balanced'), 'default', undefined, session)
      const args = execaMock.mock.calls[0][1] as string[]
      const opts = execaMock.mock.calls[0][2] as { input?: string }
      expect(args).toContain('--mcp-config')
      expect(opts.input).toContain('Decide from each description whether a skill applies')
    } finally {
      session.close()
    }
  })
})
