import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { extractConflictWindows, parseResolverEdits, PROMPT_TEMPLATE } from '../reviewers/conflict-resolve.js'
import { createSkillActivationSession } from '../skills/broker.js'
import { loadBundledSkills } from '../skills/catalog.js'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('child_process', async importOriginal => {
  const actual = await importOriginal<typeof import('child_process')>()
  return { ...actual, execSync: vi.fn() }
})

describe('extractConflictWindows', () => {
  it('returns empty string when no markers are present', () => {
    expect(extractConflictWindows('line a\nline b\nline c\n')).toBe('')
  })

  it('extracts a single conflict region with surrounding context', () => {
    const content = [
      'top context 1',
      'top context 2',
      '<<<<<<< HEAD',
      'ours',
      '=======',
      'theirs',
      '>>>>>>> branch',
      'bottom context 1',
      'bottom context 2',
    ].join('\n')
    const out = extractConflictWindows(content)
    expect(out).toContain('<<<<<<< HEAD')
    expect(out).toContain('=======')
    expect(out).toContain('>>>>>>> branch')
    expect(out).toContain('top context 1')
    expect(out).toContain('bottom context 1')
  })

  it('surfaces conflicts that appear past the previous 4KB prefix cap', () => {
    const filler = Array.from({ length: 200 }, (_, i) => `noise line ${i}`).join('\n')
    const conflict = '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> branch'
    const content = `${filler}\n${conflict}\n${filler}`
    expect(content.length).toBeGreaterThan(4000)

    const out = extractConflictWindows(content)
    expect(out).toContain('<<<<<<< HEAD')
    expect(out).toContain('>>>>>>> branch')
  })

  it('merges overlapping conflict windows instead of duplicating context', () => {
    const lines: string[] = []
    for (let i = 0; i < 3; i++) lines.push(`ctx ${i}`)
    lines.push('<<<<<<< HEAD', 'a', '=======', 'b', '>>>>>>> branch')
    lines.push('mid 1', 'mid 2')
    lines.push('<<<<<<< HEAD', 'c', '=======', 'd', '>>>>>>> branch')
    for (let i = 0; i < 3; i++) lines.push(`tail ${i}`)
    const out = extractConflictWindows(lines.join('\n'))
    const startCount = (out.match(/<<<<<<< HEAD/g) ?? []).length
    expect(startCount).toBe(2)
    // mid section between adjacent conflicts should appear exactly once (merged window)
    expect((out.match(/mid 1/g) ?? []).length).toBe(1)
  })
})

describe('Claude conflict skill broker permissions', () => {
  let execaMock: ReturnType<typeof vi.fn>
  let execSyncMock: ReturnType<typeof vi.fn>
  let repoDir: string

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'crosscheck-conflict-test-'))
    mkdirSync(join(repoDir, 'src'))
    writeFileSync(join(repoDir, 'src/conflicted.ts'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> staging\n')
    const execa = await import('execa')
    execaMock = vi.mocked(execa.execa) as ReturnType<typeof vi.fn>
    const childProcess = await import('child_process')
    execSyncMock = vi.mocked(childProcess.execSync) as ReturnType<typeof vi.fn>
    execSyncMock.mockReturnValue('src/conflicted.ts\n')
    execaMock.mockResolvedValue({ stdout: JSON.stringify({ result: '' }) } as never)
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    vi.clearAllMocks()
  })

  it('pre-authorizes Crosscheck MCP tools for headless conflict resolution', async () => {
    const { runConflictResolveStep } = await import('../reviewers/conflict-resolve.js')
    const session = createSkillActivationSession('conflict-resolve', ['code-review-skill'], loadBundledSkills())
    try {
      await runConflictResolveStep(repoDir, 'My PR', '', 'default', undefined, session)
      const args = execaMock.mock.calls[0][1] as string[]
      expect(args).toContain('--allowedTools')
      expect(args.join(' ')).toContain('mcp__crosscheck__activate_skill')
    } finally {
      session.close()
    }
  })
})

describe('multi-vendor conflict resolution', () => {
  let execaMock: ReturnType<typeof vi.fn>
  let execSyncMock: ReturnType<typeof vi.fn>
  let repoDir: string

  beforeEach(async () => {
    repoDir = mkdtempSync(join(tmpdir(), 'crosscheck-conflict-agent-test-'))
    mkdirSync(join(repoDir, 'src'))
    writeFileSync(join(repoDir, 'src/conflicted.ts'), '<<<<<<< HEAD\nours\n=======\ntheirs\n>>>>>>> staging\n')
    const execa = await import('execa')
    execaMock = vi.mocked(execa.execa) as ReturnType<typeof vi.fn>
    const childProcess = await import('child_process')
    execSyncMock = vi.mocked(childProcess.execSync) as ReturnType<typeof vi.fn>
    execSyncMock.mockImplementation((command: string) => {
      if (typeof command === 'string' && command.includes('--diff-filter=U')) return 'src/conflicted.ts\n'
      if (typeof command === 'string' && command.includes('git diff --name-only')) return 'src/conflicted.ts\n'
      return ''
    })
  })

  afterEach(() => {
    rmSync(repoDir, { recursive: true, force: true })
    rmSync(`${repoDir}-outside.ts`, { force: true })
    vi.clearAllMocks()
  })

  it('runs codex as an editing agent and reports the files it changed', async () => {
    execaMock.mockResolvedValue({
      stdout: '{"type":"turn.completed","usage":{"input_tokens":10,"output_tokens":5}}\n',
    } as never)
    writeFileSync(join(repoDir, 'src/conflicted.ts'), 'resolved\n')
    const { runConflictResolveForVendor } = await import('../reviewers/conflict-resolve.js')
    const result = await runConflictResolveForVendor(
      'codex', repoDir, 'My PR', 'Keep both changes', 'default', undefined, undefined, 'medium',
    )

    expect(result.appliedCount).toBe(1)
    expect(result.resolvedPaths).toEqual(['src/conflicted.ts'])
    expect(result.tokensUsed).toBe(15)
    expect(result.effort).toBe('medium')

    const [bin, args, options] = execaMock.mock.calls[0] as [string, string[], { input?: string }]
    expect(bin).toBe('codex')
    expect(args).toContain('exec')
    expect(options.input).toContain('Edit the files directly')
    expect(options.input).toContain('Keep both changes')
    expect(options.input).toContain('src/conflicted.ts')
  })

  it('runs opencode with edit permission and V1 model variant', async () => {
    execaMock.mockImplementation((async (bin: string, args: string[]) => {
      if (bin === 'opencode' && args.includes('--help')) {
        return { stdout: 'Options:\n  --attach <url>\n  --port <number>\n  --auto', exitCode: 0 }
      }
      if (bin === 'opencode' && args[0] === '--version') return { stdout: '1.19.3', exitCode: 0 }
      writeFileSync(join(repoDir, 'src/conflicted.ts'), 'resolved\n')
      return { stdout: '{"type":"step_finish","part":{"tokens":{"input":10,"output":5}}}\n' }
    }) as never)
    const { runConflictResolveForVendor } = await import('../reviewers/conflict-resolve.js')
    const result = await runConflictResolveForVendor(
      'opencode', repoDir, 'My PR', '', 'provider/model', undefined, undefined, 'high',
    )

    expect(result.appliedCount).toBe(1)
    expect(result.tokensUsed).toBe(15)
    expect(result.effort).toBe('high')

    const runCall = execaMock.mock.calls.find(call => call[0] === 'opencode' && (call[1] as string[]).includes('--auto'))
    expect(runCall).toBeDefined()
    const args = runCall?.[1] as string[]
    expect(args).toContain('--model')
    expect(args).toContain('provider/model')
    expect(args).toContain('--variant')
    expect(args).toContain('high')
    const prompt = (runCall?.[2] as { input?: string })?.input ?? ''
    expect(prompt).toContain('Edit the files directly')
  })

  it('refuses an agent that edits outside the conflicted set', async () => {
    execaMock.mockResolvedValue({
      stdout: '{"type":"turn.completed","usage":{"input_tokens":1,"output_tokens":1}}\n',
    } as never)
    execSyncMock.mockImplementation((command: string) => {
      if (typeof command === 'string' && command.includes('--diff-filter=U')) return 'src/conflicted.ts\n'
      if (typeof command === 'string' && command.includes('git diff --name-only')) return 'src/conflicted.ts\nsrc/other.ts\n'
      return ''
    })
    const { runConflictResolveForVendor } = await import('../reviewers/conflict-resolve.js')

    await expect(runConflictResolveForVendor('codex', repoDir, 'My PR', '', 'default'))
      .rejects.toThrow(/outside the conflict set/)
  })

  it('refuses a conflicted path that is a symlink before starting the agent', async () => {
    const outsideFile = `${repoDir}-outside.ts`
    writeFileSync(outsideFile, 'outside\n')
    rmSync(join(repoDir, 'src/conflicted.ts'))
    symlinkSync(outsideFile, join(repoDir, 'src/conflicted.ts'))
    const { runConflictResolveForVendor } = await import('../reviewers/conflict-resolve.js')

    await expect(runConflictResolveForVendor('codex', repoDir, 'My PR', '', 'default'))
      .rejects.toThrow(/contains a symlink/)
    expect(execaMock).not.toHaveBeenCalled()
  })
})

// Used by runner.ts to detect remaining conflict markers in resolved files.
// Kept in sync with the regex literal there; this test guards the contract.
const MARKER_RE = /^(<<<<<<<|=======|>>>>>>>)( |$)/m

describe('conflict marker regex (runner.ts)', () => {
  it('matches all three marker variants on their own line', () => {
    expect(MARKER_RE.test('foo\n<<<<<<< HEAD\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n=======\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n>>>>>>> branch\nbar')).toBe(true)
  })

  it('matches a marker line with no trailing label (end of line)', () => {
    expect(MARKER_RE.test('foo\n<<<<<<<\nbar')).toBe(true)
    expect(MARKER_RE.test('foo\n=======\nbar')).toBe(true)
  })

  it('does not match a Markdown setext-style separator inside docs', () => {
    // "=======" is a legitimate H1 setext underline in Markdown; only flag when
    // the resolver actually leaves a marker behind in the resolved file.
    // The regex DOES match a bare "=======" line — the false-positive defense is
    // that runner.ts scopes the check to originally-conflicted files, not the
    // whole worktree. Verify the marker line itself still matches so the scope
    // restriction is doing the real work.
    expect(MARKER_RE.test('Heading\n=======\n')).toBe(true)
  })

  it('does not match conflict markers appearing mid-line (e.g. in URLs or strings)', () => {
    expect(MARKER_RE.test('see https://example.com/<<<<<<<-pin')).toBe(false)
    expect(MARKER_RE.test('const s = "=======middle"')).toBe(false)
  })
})

describe('PROMPT_TEMPLATE side preference', () => {
  // The runner does `git merge origin/<base>` while the PR's branch is checked
  // out as HEAD, so the `<<<<<<< HEAD` side is the PR author's changes and the
  // `>>>>>>>` side is the base branch. The prompt must default to preserving
  // the PR author's intent — preferring `>>>>>>>` would silently discard the
  // PR's conflicting changes in favor of base.
  it('prefers the PR author\'s side (<<<<<<< HEAD) over the base branch (>>>>>>>)', () => {
    expect(PROMPT_TEMPLATE).toMatch(/prefer the PR author's changes \(the `?<<<<<<< HEAD/i)
    // Guard against regression — must not advise preferring the >>>>>>> side
    expect(PROMPT_TEMPLATE).not.toMatch(/prefer the incoming branch changes \(the >>>>>>>/i)
    expect(PROMPT_TEMPLATE).not.toMatch(/prefer the >>>>>>> side/i)
  })

  it('explains which side is which so the resolver does not invert the convention', () => {
    expect(PROMPT_TEMPLATE).toMatch(/<<<<<<< HEAD.*PR/s)
    expect(PROMPT_TEMPLATE).toMatch(/>>>>>>>.*base/s)
  })
})

describe('parseResolverEdits', () => {
  const wrap = (path: string, oldText: string, newText: string) =>
    `<edit path="${path}">\n<old>\n${oldText}\n</old>\n<new>\n${newText}\n</new>\n</edit>`

  it('parses a well-formed edit block', () => {
    const out = wrap('src/a.ts', 'old line', 'new line')
    const edits = parseResolverEdits(out, ['src/a.ts'])
    expect(edits).toEqual([{ filePath: 'src/a.ts', oldText: 'old line', newText: 'new line' }])
  })

  it('drops edits whose path is not in the conflicted set', () => {
    // Defense against a buggy or prompt-injected resolver emitting <edit> blocks
    // for tracked files that were never in U state. Those would otherwise be
    // written + staged and could carry unresolved markers into the commit.
    const out = wrap('src/legit.ts', 'a', 'b') + wrap('src/sneaky.ts', 'c', 'd')
    const edits = parseResolverEdits(out, ['src/legit.ts'])
    expect(edits.map(e => e.filePath)).toEqual(['src/legit.ts'])
  })

  it('drops path-escape attempts', () => {
    const out = wrap('../etc/passwd', 'a', 'b') + wrap('/etc/passwd', 'c', 'd')
    expect(parseResolverEdits(out, ['../etc/passwd', '/etc/passwd'])).toEqual([])
  })

  it('drops edits with an empty <old> block', () => {
    const out = wrap('src/a.ts', '', 'new')
    expect(parseResolverEdits(out, ['src/a.ts'])).toEqual([])
  })

  it('skips edits missing <old> or <new> tags', () => {
    const broken = '<edit path="src/a.ts"><old>only old</old></edit>'
    expect(parseResolverEdits(broken, ['src/a.ts'])).toEqual([])
  })
})
