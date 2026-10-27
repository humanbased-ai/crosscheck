import { execSync } from 'child_process'
import { lstatSync, readFileSync, realpathSync } from 'fs'
import { isAbsolute, join, relative, resolve, sep } from 'path'
import { execa } from 'execa'
import { applyEdit } from './fix.js'
import { claudeEffort } from './claude.js'
import { codexReasoningEffort, parseCodexTokensUsed } from './codex.js'
import { isolateCheckoutOpenCodeConfig, opencodeEffort, opencodeSupportsStandalone, parseOpenCodeOutput } from './opencode.js'
import { codexModelRejection, codexTurnFailureMessage, withCodexJsonlOutput, withCodexModelFallback } from '../lib/codex-model-fallback.js'
import { buildCodexEnv } from './codex-env.js'
import { buildOpenCodeEnv } from './opencode-env.js'
import { withCredentialFreeOrigin } from '../lib/clone.js'
import { claudeSkillBrokerArgs, codexSkillBrokerArgs, codexSkillsReachable, renderSkillBrokerInstructions, type SkillActivationSession } from '../skills/broker.js'
import type { Vendor } from '../lib/vendor.js'

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

function isMissingPath(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT'
}

// Conflicted paths come from an untrusted checkout. Never read or write through
// symlinks: a PR can make a conflicted path point outside the temporary clone.
function assertConflictedPathsStayInCheckout(tmpDir: string, filePaths: string[]): void {
  const root = realpathSync(tmpDir)
  for (const filePath of filePaths) {
    const candidate = resolve(root, filePath)
    const relativePath = relative(root, candidate)
    if (!relativePath || relativePath === '..' || relativePath.startsWith(`..${sep}`) || isAbsolute(relativePath)) {
      throw new Error(`conflict path escapes the temporary checkout: ${filePath}`)
    }
    let current = root
    for (const part of relativePath.split(sep)) {
      current = join(current, part)
      try {
        if (lstatSync(current).isSymbolicLink()) {
          throw new Error(`conflict path contains a symlink: ${filePath}`)
        }
      } catch (error) {
        if (isMissingPath(error)) break
        throw error
      }
    }
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

// Agentic vendors (Codex, OpenCode) edit the working tree directly, so their
// prompt asks for file edits instead of Claude's machine-parsed <edit> blocks.
// The rules mirror PROMPT_TEMPLATE so every vendor gets the same side
// preference and the same marker hygiene.
export const AGENT_PROMPT_TEMPLATE = `This pull request has merge conflicts. Resolve every conflict marker in the files listed below by editing the files in place.

PR title: {PR_TITLE}

Conflicted files:
{CONFLICTED_FILES}

{EXTRA_INSTRUCTIONS}

Context: the PR's branch is checked out as HEAD, and the base branch was merged into it. That means the \`<<<<<<< HEAD\` side is the PR author's intended changes and the \`>>>>>>>\` side is the base branch. Default to preserving the PR author's intent.

Rules for resolving each conflict:
- Edit the files directly. Do not output patches, diffs, or <edit> blocks.
- Only touch the files listed above.
- Keep ALL meaningful changes from both sides if they are not directly contradictory
- When both sides modify the same line, prefer the PR author's changes (the \`<<<<<<< HEAD\` side) over the base branch (the \`>>>>>>>\` side), unless the PR side clearly breaks existing logic on the base
- Remove ALL conflict markers: <<<<<<<, =======, >>>>>>>

When you are done, reply with a one-line summary of the files you resolved.`

export interface ConflictResolveResult {
  appliedCount: number
  resolvedPaths: string[]
  tokensUsed?: number
  effort?: string
}

// Backwards-compatible entry point: the Claude edit-block resolver.
export async function runConflictResolveStep(
  tmpDir: string,
  prTitle: string,
  instructions: string,
  model?: string,
  timeoutMs?: number,
  skillSession?: SkillActivationSession,
  configuredEffort?: string,
): Promise<ConflictResolveResult> {
  return runConflictResolveForVendor('claude', tmpDir, prTitle, instructions, model, timeoutMs, skillSession, configuredEffort)
}

export async function runConflictResolveForVendor(
  vendor: Vendor,
  tmpDir: string,
  prTitle: string,
  instructions: string,
  model?: string,
  timeoutMs?: number,
  skillSession?: SkillActivationSession,
  configuredEffort?: string,
  codexFullAccess = false,
): Promise<ConflictResolveResult> {
  const conflictedFiles = findConflictedFiles(tmpDir)
  if (conflictedFiles.length === 0) return { appliedCount: 0, resolvedPaths: [] }
  assertConflictedPathsStayInCheckout(tmpDir, conflictedFiles)

  if (vendor === 'claude') {
    return runClaudeConflictResolve(tmpDir, prTitle, instructions, conflictedFiles, model, timeoutMs, skillSession, configuredEffort)
  }
  return runAgenticConflictResolve(vendor, tmpDir, prTitle, instructions, conflictedFiles, model, timeoutMs, skillSession, configuredEffort, codexFullAccess)
}

async function runClaudeConflictResolve(
  tmpDir: string,
  prTitle: string,
  instructions: string,
  conflictedFiles: string[],
  model: string | undefined,
  timeoutMs: number | undefined,
  skillSession: SkillActivationSession | undefined,
  configuredEffort: string | undefined,
): Promise<ConflictResolveResult> {
  const effort = claudeEffort(configuredEffort)
  const filesBlock = buildConflictedFilesBlock(tmpDir, conflictedFiles)
  const prompt = PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{CONFLICTED_FILES}', filesBlock)
    .replace('{EXTRA_INSTRUCTIONS}', [instructions ? `Additional instructions: ${instructions}` : '', skillSession ? renderSkillBrokerInstructions(skillSession) : ''].filter(Boolean).join('\n\n'))

  let output = ''
  let tokensUsed: number | undefined
  try {
    const modelArgs = model && model !== 'default' ? ['--model', model] : []
    const resolvedTimeout = timeoutMs === undefined ? 180_000 : timeoutMs === 0 ? undefined : timeoutMs
    const { stdout } = await execa('claude', [
      '--print', '--output-format', 'json', ...modelArgs, '--effort', effort,
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

  if (!output || output === 'NO_CHANGES') return { appliedCount: 0, resolvedPaths: [], tokensUsed, effort }

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

  return { appliedCount, resolvedPaths, tokensUsed, effort }
}

async function runAgenticConflictResolve(
  vendor: 'codex' | 'opencode',
  tmpDir: string,
  prTitle: string,
  instructions: string,
  conflictedFiles: string[],
  model: string | undefined,
  timeoutMs: number | undefined,
  skillSession: SkillActivationSession | undefined,
  configuredEffort: string | undefined,
  codexFullAccess: boolean,
): Promise<ConflictResolveResult> {
  const effort = vendor === 'codex' ? codexReasoningEffort(configuredEffort ?? 'medium') : opencodeEffort(configuredEffort ?? 'high')
  const fileList = conflictedFiles.map(file => `- ${file}`).join('\n')
  const skillInstructions = vendor === 'codex' && codexSkillsReachable(skillSession, codexFullAccess)
    ? renderSkillBrokerInstructions(skillSession)
    : ''
  const prompt = AGENT_PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{CONFLICTED_FILES}', fileList)
    .replace('{EXTRA_INSTRUCTIONS}', [instructions ? `Additional instructions: ${instructions}` : '', skillInstructions].filter(Boolean).join('\n\n'))

  const resolvedTimeout = timeoutMs === undefined ? 180_000 : timeoutMs === 0 ? undefined : timeoutMs
  // The index already holds the merge result. Snapshot each staged blob so an
  // agent that edits and stages an outside path cannot hide it from the
  // worktree diff below.
  const indexSnapshot = (): Map<string, string> => {
    const entries = execSync('git ls-files -s -z', { cwd: tmpDir, encoding: 'utf8' }).split('\0')
    const snapshot = new Map<string, string>()
    for (const entry of entries) {
      const tab = entry.indexOf('\t')
      if (tab === -1) continue
      snapshot.set(entry.slice(tab + 1), entry.slice(0, tab).split(' ')[1] ?? '')
    }
    return snapshot
  }
  const indexBefore = indexSnapshot()
  let tokensUsed: number | undefined
  try {
    if (vendor === 'codex') {
      const result = await withCodexModelFallback(model ?? 'default', 'conflict-resolve', usedModel => withCredentialFreeOrigin(tmpDir, () => withCodexJsonlOutput(() => execa(
        'codex',
        ['exec', '--json', '--ignore-user-config', ...(usedModel !== 'default' ? ['-c', `model="${usedModel}"`] : []), '-c', `model_reasoning_effort="${effort}"`, ...codexSkillBrokerArgs(skillSession, codexFullAccess), '-'],
        {
          cwd: tmpDir,
          timeout: resolvedTimeout,
          input: prompt,
          extendEnv: false,
          env: buildCodexEnv({ CODEX_QUIET_MODE: '1' }),
        },
      ))))
      tokensUsed = parseCodexTokensUsed(result.stdout ?? '')
    } else {
      const modelArgs = model ? ['--model', `${model}#${effort}`] : []
      const standaloneSupported = await opencodeSupportsStandalone()
      const policyFormat = standaloneSupported ? 'v2' : 'v1'
      const standaloneArgs = standaloneSupported ? ['--standalone'] : []
      const result = await withCredentialFreeOrigin(tmpDir, () => {
        // Resolve conflicts with edit permission, but hide any project config
        // the untrusted checkout carries while the agent runs.
        const restoreConfig = isolateCheckoutOpenCodeConfig(tmpDir, true, policyFormat)
        return execa(
          'opencode',
          ['run', '--format', 'json', '--auto', ...standaloneArgs, ...modelArgs],
          {
            cwd: tmpDir,
            timeout: resolvedTimeout,
            input: prompt,
            extendEnv: false,
            env: buildOpenCodeEnv({}),
          },
        ).finally(restoreConfig)
      })
      tokensUsed = parseOpenCodeOutput(result.stdout ?? '').tokensUsed
    }
  } catch (err) {
    if (vendor === 'codex') {
      const rejection = codexModelRejection(err)
      if (rejection) throw new Error(`codex rejected the configured model during conflict-resolve step — ${rejection}`)
      const msg = codexTurnFailureMessage((err as { codexJsonl?: unknown })?.codexJsonl) ?? ''
      if (/not logged in|auth|credential/i.test(msg)) {
        throw new Error('codex auth failure during conflict-resolve step — run: codex login')
      }
      throw err
    }
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|auth|credential/i.test(msg)) {
      throw new Error('opencode auth failure during conflict-resolve step — run: opencode auth login')
    }
    throw err
  }

  assertConflictedPathsStayInCheckout(tmpDir, conflictedFiles)
  const gitPaths = (args: string[]): string[] => {
    const out = execSync(`git ${args.join(' ')}`, { cwd: tmpDir, encoding: 'utf8' }).trim()
    return out ? out.split('\n').filter(Boolean) : []
  }
  const touched = new Set([
    ...gitPaths(['diff', '--name-only']),
    ...gitPaths(['ls-files', '--others', '--exclude-standard']),
  ])
  // The agent only had the conflicted paths in its brief. An edit elsewhere is
  // either a prompt-injection attempt or a tool writing scratch files; refuse
  // it rather than letting runner.ts stage paths it never reviewed. Staged
  // paths matter too: the runner commits the index, so an outside `git add`
  // would otherwise ride along without appearing in the worktree diff.
  const conflictedSet = new Set(conflictedFiles)
  const indexAfter = indexSnapshot()
  for (const [file, sha] of indexAfter) {
    if (!conflictedSet.has(file) && indexBefore.get(file) !== sha) touched.add(file)
  }
  for (const file of indexBefore.keys()) {
    if (!conflictedSet.has(file) && !indexAfter.has(file)) touched.add(file)
  }
  const outside = [...touched].filter(file => !conflictedSet.has(file))
  if (outside.length > 0) {
    throw new Error(`${vendor} edited files outside the conflict set during conflict-resolve: ${outside.join(', ')}`)
  }

  // A resolved file may have been staged (gone from the worktree diff) or
  // chosen as "ours" (byte-identical to HEAD), so decide by markers rather
  // than by diff. Binary/modify-delete conflicts fail the read and are left to
  // runner.ts's unmerged-path check.
  const resolvedPaths = conflictedFiles.filter(file => {
    try {
      return !/^(<<<<<<<|=======|>>>>>>>)( |$)/m.test(readFileSync(join(tmpDir, file), 'utf8'))
    } catch {
      return true
    }
  })

  return {
    appliedCount: resolvedPaths.length,
    resolvedPaths,
    tokensUsed,
    // OpenCode only carries effort as the #variant suffix on a pinned model.
    effort: vendor === 'opencode' && !model ? undefined : effort,
  }
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
