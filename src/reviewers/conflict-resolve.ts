import { execSync } from 'child_process'
import { readFileSync } from 'fs'
import { join } from 'path'
import { execa } from 'execa'
import { applyEdit } from './fix.js'
import { claudeSkillBrokerArgs, renderSkillBrokerInstructions, type SkillActivationSession } from '../skills/broker.js'

interface ClaudeJsonOutput {
  result?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

// Exported so tests can verify the prompt's side-preference guidance stays in
// sync with the merge direction in runner.ts (origin/<base> is merged into HEAD,
// so HEAD is the PR side and the `>>>>>>>` side is the base branch).
export const PROMPT_TEMPLATE = `This pull request has merge conflicts. Resolve all conflict markers in the files listed below.

PR title: {PR_TITLE}

Conflicted files:
{CONFLICTED_FILES}

{EXTRA_INSTRUCTIONS}

Context: the PR's branch is checked out as HEAD, and the base branch was merged into it. That means the \`<<<<<<< HEAD\` side is the PR author's intended changes and the \`>>>>>>>\` side is the base branch. Default to preserving the PR author's intent.

Rules for resolving each conflict:
- Keep ALL meaningful changes from both sides if they are not directly contradictory
- When both sides modify the same line, prefer the PR author's changes (the \`<<<<<<< HEAD\` side) over the base branch (the \`>>>>>>>\` side), unless the PR side clearly breaks existing logic on the base
- Remove ALL conflict markers: <<<<<<<, =======, >>>>>>>

For each file, output ONLY the resolved conflict regions using this format:

<edit path="relative/path/to/file.ext">
<old>
exact conflict region including all markers (copy verbatim from the file)
</old>
<new>
resolved content with no conflict markers
</new>
</edit>

Rules for <edit> blocks:
- <old> must match the file content EXACTLY, including conflict markers and surrounding lines
- <new> must not contain ANY conflict markers
- Include 2–3 context lines around the conflict region to make the match unambiguous
- One block per conflict region; multiple blocks per file are fine
- Output ONLY <edit> blocks. No other text.`

// Returns file paths that have unmerged conflict markers (git status: UU/AA/DD).
export function findConflictedFiles(tmpDir: string): string[] {
  try {
    const out = execSync('git diff --name-only --diff-filter=U', { cwd: tmpDir, encoding: 'utf8' })
    return out.trim().split('\n').filter(Boolean)
  } catch {
    return []
  }
}

// Extract every conflict region in a file with a few context lines on each side.
// Slicing from the file prefix instead would hide conflicts that appear past the
// budget, so the resolver couldn't produce a matching <old> block.
const CONTEXT_LINES = 6
const PER_FILE_MAX = 12_000

export function extractConflictWindows(content: string): string {
  const lines = content.split('\n')
  const starts: number[] = []
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].startsWith('<<<<<<<')) starts.push(i)
  }
  if (starts.length === 0) return ''

  const ranges: Array<[number, number]> = []
  for (const start of starts) {
    let end = start
    for (let i = start; i < lines.length; i++) {
      if (lines[i].startsWith('>>>>>>>')) { end = i; break }
      end = i
    }
    const from = Math.max(0, start - CONTEXT_LINES)
    const to = Math.min(lines.length - 1, end + CONTEXT_LINES)
    const prev = ranges[ranges.length - 1]
    if (prev && from <= prev[1] + 1) {
      prev[1] = Math.max(prev[1], to)
    } else {
      ranges.push([from, to])
    }
  }

  const chunks: string[] = []
  let total = 0
  for (const [from, to] of ranges) {
    const block = lines.slice(from, to + 1).join('\n')
    const header = `... lines ${from + 1}-${to + 1} ...`
    const piece = `${header}\n${block}`
    if (total + piece.length > PER_FILE_MAX) {
      chunks.push('... (remaining conflict regions truncated)')
      break
    }
    chunks.push(piece)
    total += piece.length
  }
  return chunks.join('\n\n')
}

function buildConflictedFilesBlock(tmpDir: string, filePaths: string[]): string {
  return filePaths.map(f => {
    try {
      const content = readFileSync(join(tmpDir, f), 'utf8')
      const windowed = extractConflictWindows(content)
      // No textual conflict markers (binary / modify-delete) — surface the file by name only.
      if (!windowed) {
        return `### ${f}\n(no textual conflict markers — likely a non-text conflict; skip)`
      }
      return `### ${f}\n\`\`\`\n${windowed}\n\`\`\``
    } catch {
      return `### ${f}\n(could not read file)`
    }
  }).join('\n\n')
}

export async function runConflictResolveStep(
  tmpDir: string,
  prTitle: string,
  instructions: string,
  model = 'default',
  timeoutMs?: number,
  skillSession?: SkillActivationSession,
): Promise<{ appliedCount: number; resolvedPaths: string[]; tokensUsed?: number }> {
  const conflictedFiles = findConflictedFiles(tmpDir)
  if (conflictedFiles.length === 0) return { appliedCount: 0, resolvedPaths: [] }

  const filesBlock = buildConflictedFilesBlock(tmpDir, conflictedFiles)
  const prompt = PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{CONFLICTED_FILES}', filesBlock)
    .replace('{EXTRA_INSTRUCTIONS}', [instructions ? `Additional instructions: ${instructions}` : '', skillSession ? renderSkillBrokerInstructions(skillSession) : ''].filter(Boolean).join('\n\n'))

  let output = ''
  let tokensUsed: number | undefined
  try {
    const modelArgs = model !== 'default' ? ['--model', model] : []
    const resolvedTimeout = timeoutMs === undefined ? 180_000 : timeoutMs === 0 ? undefined : timeoutMs
    const { stdout } = await execa('claude', [
      '--print', '--output-format', 'json', ...modelArgs,
      ...claudeSkillBrokerArgs(skillSession),
      ...(skillSession ? ['--allowedTools', [
        'mcp__crosscheck__list_enabled_skills',
        'mcp__crosscheck__activate_skill',
        'mcp__crosscheck__read_skill_file',
      ].join(',')] : []),
    ], {
      input: prompt,
      timeout: resolvedTimeout,
      env: { ...process.env },
    })
    const raw = stdout.trim()
    try {
      const parsed: ClaudeJsonOutput = JSON.parse(raw)
      output = typeof parsed.result === 'string' ? parsed.result : raw
      const inTok = parsed.usage?.input_tokens
      const outTok = parsed.usage?.output_tokens
      tokensUsed = typeof inTok === 'number' && typeof outTok === 'number' ? inTok + outTok : undefined
    } catch {
      output = raw
    }
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|auth|credential/i.test(msg)) {
      throw new Error('claude auth failure during conflict-resolve step — run: claude auth login')
    }
    throw err
  }

  if (!output || output === 'NO_CHANGES') return { appliedCount: 0, resolvedPaths: [], tokensUsed }

  const fileEdits = new Map<string, string>()
  const fileCache = new Map<string, string>()

  for (const { filePath, oldText, newText } of parseResolverEdits(output, conflictedFiles)) {
    const absPath = join(tmpDir, filePath)
    let current = fileEdits.get(filePath) ?? fileCache.get(filePath)
    if (current === undefined) {
      try {
        current = readFileSync(absPath, 'utf8')
        fileCache.set(filePath, current)
      } catch {
        continue
      }
    }
    const updated = applyEdit(current, oldText, newText)
    if (updated === null) continue
    fileEdits.set(filePath, updated)
  }

  const { writeFileSync, mkdirSync } = await import('fs')
  const { dirname } = await import('path')
  let appliedCount = 0
  const resolvedPaths: string[] = []
  for (const [filePath, content] of fileEdits) {
    const absPath = join(tmpDir, filePath)
    try {
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content)
      appliedCount++
      resolvedPaths.push(filePath)
    } catch { /* skip unwritable paths */ }
  }

  return { appliedCount, resolvedPaths, tokensUsed }
}

export interface ResolverEdit {
  filePath: string
  oldText: string
  newText: string
}

// Parses <edit path="…"><old>…</old><new>…</new></edit> blocks from resolver output.
// Filters out anything that escapes tmpDir (`..`, absolute paths) or targets a file
// that wasn't in the original unmerged set — the resolver must only touch the files
// it was asked about, otherwise a buggy or prompt-injected response could land
// arbitrary content (including unresolved markers) in unrelated tracked files.
export function parseResolverEdits(output: string, conflictedFiles: string[]): ResolverEdit[] {
  const conflictedSet = new Set(conflictedFiles)
  const edits: ResolverEdit[] = []
  const editRegex = /<edit path="([^"]+)">([\s\S]*?)<\/edit>/g
  let match: RegExpExecArray | null
  while ((match = editRegex.exec(output)) !== null) {
    const [, filePath, body] = match
    if (filePath.includes('..') || filePath.startsWith('/')) continue
    if (!conflictedSet.has(filePath)) continue

    const oldMatch = body.match(/<old>([\s\S]*?)<\/old>/)
    const newMatch = body.match(/<new>([\s\S]*?)<\/new>/)
    if (!oldMatch || !newMatch) continue

    const oldText = oldMatch[1].replace(/^\n/, '').replace(/\n$/, '')
    const newText = newMatch[1].replace(/^\n/, '').replace(/\n$/, '')
    if (oldText === '') continue

    edits.push({ filePath, oldText, newText })
  }
  return edits
}
