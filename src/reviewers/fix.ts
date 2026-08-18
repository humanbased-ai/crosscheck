import { execSync } from 'child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { execa } from 'execa'
import type { Config } from '../config/schema.js'
import { tierTimeoutMs } from './tier-timeouts.js'
import { claudeEffort } from './claude.js'
import { codexReasoningEffort } from './codex.js'
import { claudeSkillBrokerArgs, codexSkillBrokerArgs, codexSkillsReachable, renderSkillBrokerInstructions, type SkillActivationSession } from '../skills/broker.js'
import { buildCodexEnv } from './codex-env.js'
import { withCredentialFreeOrigin } from '../lib/clone.js'

interface ClaudeJsonOutput {
  result?: unknown
  usage?: { input_tokens?: unknown; output_tokens?: unknown }
}

// Minimum ratio of new lines to original lines before we reject a full-file write.
// Guards against Claude silently truncating large files.
const MIN_SIZE_RATIO = 0.6

const PROMPT_TEMPLATE = `You opened a pull request that received the following code review.

PR title: {PR_TITLE}

Code review comment:
---
{REVIEW_COMMENT}
---

Diff of your changes (base..head):
---
{DIFF}
---

{EXTRA_INSTRUCTIONS}

Please address the issues raised in the review. Rules:
- Only fix what the review explicitly calls out
- Do not refactor unrelated code, rename variables, or add tests unless asked
- If a comment requires deeper understanding of business logic, skip it
- If the review has no actionable code changes, output exactly: NO_CHANGES

For each file you need to change, output ONLY the edited sections using this format:

<edit path="relative/path/to/file.ext">
<old>
exact lines from the file that need to be replaced (copy verbatim — must match exactly)
</old>
<new>
replacement lines
</new>
</edit>

Rules for <edit> blocks:
- <old> must match the file content EXACTLY (whitespace, indentation, line endings)
- Include enough surrounding context lines (2–3) so the match is unambiguous
- One <edit> block per contiguous change; multiple blocks per file are fine
- Never output the entire file — only the sections that change
- If a file needs a new section appended, use an <old> that matches the last few lines before the insertion point
- To create a brand-new file, leave <old> empty and put the complete file content in <new>

Output ONLY <edit> blocks or NO_CHANGES. No other text.`

function isSafePath(filePath: string): boolean {
  return !filePath.includes('..') && !filePath.startsWith('/')
}

// Apply a single edit: find <old> in fileContent and replace with <new>.
// Returns null if the old text is not found or appears more than once (ambiguous).
export function applyEdit(fileContent: string, oldText: string, newText: string): string | null {
  const idx = fileContent.indexOf(oldText)
  if (idx === -1) return null
  // Reject ambiguous matches — if the snippet appears more than once, indexOf and
  // lastIndexOf disagree, so we can't know which occurrence Claude intended to edit.
  if (fileContent.lastIndexOf(oldText) !== idx) return null
  return fileContent.slice(0, idx) + newText + fileContent.slice(idx + oldText.length)
}

export async function runFixStep(
  tmpDir: string,
  baseRef: string,
  prTitle: string,
  reviewComment: string,
  instructions: string,
  config: Config,
  model = 'default',
  timeoutMs?: number,
  skillSession?: SkillActivationSession,
): Promise<{ appliedCount: number; changedFiles: string[]; tokensUsed?: number; effort: string }> {
  const effort = claudeEffort(config.vendors?.claude?.effort)
  let diff = ''
  try {
    diff = execSync(`git diff origin/${baseRef}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
  } catch {
    try {
      diff = execSync('git diff HEAD~1', { cwd: tmpDir, encoding: 'utf8' })
    } catch { /* proceed with empty diff */ }
  }

  const prompt = PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{REVIEW_COMMENT}', reviewComment.slice(0, 8000))
    .replace('{DIFF}', diff.slice(0, 16000))
    .replace('{EXTRA_INSTRUCTIONS}', [instructions ? `Additional instructions: ${instructions}` : '', skillSession ? renderSkillBrokerInstructions(skillSession) : ''].filter(Boolean).join('\n\n'))

  let output = ''
  let tokensUsed: number | undefined
  try {
    const modelArgs = model !== 'default' ? ['--model', model] : []
    const resolvedTimeout = timeoutMs === undefined ? tierTimeoutMs(config.quality.tier) : timeoutMs === 0 ? undefined : timeoutMs
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
      throw new Error('claude auth failure during fix step — run: claude auth login')
    }
    throw err
  }

  if (!output || output === 'NO_CHANGES') return { appliedCount: 0, changedFiles: [], tokensUsed, effort }

  let appliedCount = 0

  // Primary: apply <edit path="..."><old>...</old><new>...</new></edit> blocks.
  // This format only outputs changed sections — structurally prevents truncation.
  const editRegex = /<edit path="([^"]+)">([\s\S]*?)<\/edit>/g
  const fileEdits = new Map<string, string>()   // files with ≥1 successful edit
  const fileCache = new Map<string, string>()   // raw disk reads; never written directly

  let match: RegExpExecArray | null
  while ((match = editRegex.exec(output)) !== null) {
    const [, filePath, body] = match
    if (!isSafePath(filePath)) continue

    const oldMatch = body.match(/<old>([\s\S]*?)<\/old>/)
    const newMatch = body.match(/<new>([\s\S]*?)<\/new>/)
    if (!oldMatch || !newMatch) continue

    // Strip exactly one leading/trailing newline added by the XML-style tags
    const oldText = oldMatch[1].replace(/^\n/, '').replace(/\n$/, '')
    const newText = newMatch[1].replace(/^\n/, '').replace(/\n$/, '')

    const absPath = join(tmpDir, filePath)
    // fileCache holds disk reads; fileEdits holds files that have at least one
    // successful edit applied. Keeping them separate prevents a failed <old> match
    // from adding the unchanged file to fileEdits and inflating appliedCount.
    let current = fileEdits.get(filePath) ?? fileCache.get(filePath)
    const alreadyKnown = current !== undefined

    if (!alreadyKnown) {
      try {
        current = readFileSync(absPath, 'utf8')
        fileCache.set(filePath, current)
      } catch {
        // File doesn't exist on disk — allow new-file creation only when <old> is empty.
        // Any non-empty <old> is meaningless against a non-existent file.
        if (oldText !== '') continue
        fileEdits.set(filePath, newText)
        continue
      }
    }

    // Guard: empty <old> on an existing file is ambiguous — indexOf('') = 0 would
    // silently prepend <new> at the top of the file instead of anchoring to content.
    if (oldText === '') continue

    const updated = applyEdit(current!, oldText, newText)
    if (updated === null) continue  // <old> not found — skip this edit safely
    fileEdits.set(filePath, updated)
  }

  const writtenFiles: string[] = []
  for (const [filePath, content] of fileEdits) {
    const absPath = join(tmpDir, filePath)
    try {
      mkdirSync(dirname(absPath), { recursive: true })
      writeFileSync(absPath, content)
      appliedCount++
      writtenFiles.push(filePath)
    } catch { /* skip unwritable paths */ }
  }

  // Fallback: <file path="...">complete content</file> blocks, with size guard.
  // These are only accepted when the new content is >= MIN_SIZE_RATIO of the original,
  // preventing silent truncation of large files.
  if (appliedCount === 0) {
    const fileRegex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g
    while ((match = fileRegex.exec(output)) !== null) {
      const [, filePath, rawContent] = match
      if (!isSafePath(filePath)) continue
      const absPath = join(tmpDir, filePath)
      const newContent = rawContent.replace(/^\n/, '')
      try {
        let originalLineCount = 0
        try {
          originalLineCount = readFileSync(absPath, 'utf8').split('\n').length
        } catch { /* new file — no size guard needed */ }
        if (originalLineCount > 0) {
          const newLineCount = newContent.split('\n').length
          if (newLineCount < originalLineCount * MIN_SIZE_RATIO) continue  // reject — likely truncated
        }
        writeFileSync(absPath, newContent)
        appliedCount++
        writtenFiles.push(filePath)
      } catch { /* skip unwritable paths */ }
    }
  }

  return { appliedCount, changedFiles: writtenFiles, tokensUsed, effort }
}

// Codex fix: codex is an agentic tool that edits files directly on disk.
// We pass the fix context as a prompt, run codex in full-auto mode, then
// detect how many files changed via git diff rather than parsing edit blocks.
const CODEX_FIX_PROMPT = `You opened a pull request that received the following code review.

PR title: {PR_TITLE}

Code review comment:
---
{REVIEW_COMMENT}
---

Diff of your changes (base..head):
---
{DIFF}
---

{EXTRA_INSTRUCTIONS}

Please address the issues raised in the review. Rules:
- Only fix what the review explicitly calls out
- Do not refactor unrelated code, rename variables, or add tests unless asked
- If a comment requires deeper understanding of business logic, skip it
- If there are no actionable code changes, exit immediately without modifying any files`

export async function runCodexFixStep(
  tmpDir: string,
  baseRef: string,
  prTitle: string,
  reviewComment: string,
  instructions: string,
  model = 'default',
  timeoutMs?: number,
  skillSession?: SkillActivationSession,
  // Reasoning effort from vendors.codex.effort. Was never passed here, so a
  // configured effort applied to the review and then silently dropped for the
  // fix; the posted card now reports this value, so it has to be the real one.
  configuredEffort?: string,
  // skills.codex_full_access — see runCodexReview. The fix step reads the same
  // untrusted review comment and diff, so it is gated identically.
  codexFullAccess = false,
): Promise<{ appliedCount: number; changedFiles: string[]; tokensUsed?: number; effort: string }> {
  const effort = codexReasoningEffort(configuredEffort ?? 'medium')
  let diff = ''
  try {
    diff = execSync(`git diff origin/${baseRef}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
  } catch {
    try {
      diff = execSync('git diff HEAD~1', { cwd: tmpDir, encoding: 'utf8' })
    } catch { /* proceed with empty diff */ }
  }

  const prompt = CODEX_FIX_PROMPT
    .replace('{PR_TITLE}', prTitle)
    .replace('{REVIEW_COMMENT}', reviewComment.slice(0, 8000))
    .replace('{DIFF}', diff.slice(0, 16000))
    .replace('{EXTRA_INSTRUCTIONS}', [instructions ? `Additional instructions: ${instructions}` : '', codexSkillsReachable(skillSession, codexFullAccess) ? renderSkillBrokerInstructions(skillSession) : ''].filter(Boolean).join('\n\n'))

  const resolvedTimeout = timeoutMs === undefined ? 300_000 : timeoutMs === 0 ? undefined : timeoutMs
  const modelArgs = model !== 'default' ? ['-c', `model="${model}"`] : []

  try {
    await withCredentialFreeOrigin(tmpDir, () => execa(
      'codex',
      // --ignore-user-config and the env allowlist for the same reason as the
      // review path: this step reads an untrusted diff, and with
      // skills.codex_full_access it runs unsandboxed.
      ['exec', '--ignore-user-config', ...modelArgs, '-c', `model_reasoning_effort="${effort}"`, ...codexSkillBrokerArgs(skillSession, codexFullAccess), prompt],
      {
        cwd: tmpDir,
        timeout: resolvedTimeout,
        extendEnv: false,
        env: buildCodexEnv({ CODEX_QUIET_MODE: '1' }),
      },
    ))
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|auth|credential/i.test(msg)) {
      throw new Error('codex auth failure during fix step — run: codex login')
    }
    throw err
  }

  // Count all files codex touched: modified/deleted (git diff) + newly created (git ls-files --others)
  const changedOutput = execSync('git diff --name-only', { cwd: tmpDir, encoding: 'utf8' }).trim()
  const untrackedOutput = execSync('git ls-files --others --exclude-standard', { cwd: tmpDir, encoding: 'utf8' }).trim()
  const changedFiles = [
    ...(changedOutput ? changedOutput.split('\n').filter(Boolean) : []),
    ...(untrackedOutput ? untrackedOutput.split('\n').filter(Boolean) : []),
  ]
  return { appliedCount: changedFiles.length, changedFiles, effort }
}
