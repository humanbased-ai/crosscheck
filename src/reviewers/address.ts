import { execSync, execFileSync } from 'child_process'
import { writeFileSync } from 'fs'
import { join } from 'path'
import type { Config } from '../config/schema.js'

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

For each file you need to change, output the complete new file content using this format:

<file path="relative/path/to/file.ext">
[complete file content]
</file>

Output ONLY <file> blocks or NO_CHANGES. No other text.`

export async function runAddressStep(
  tmpDir: string,
  baseRef: string,
  prTitle: string,
  reviewComment: string,
  instructions: string,
  _config: Config,
): Promise<{ appliedCount: number }> {
  let diff = ''
  try {
    diff = execSync(`git diff ${baseRef}...HEAD`, { cwd: tmpDir, encoding: 'utf8' })
  } catch {
    try {
      diff = execSync('git diff HEAD~1', { cwd: tmpDir, encoding: 'utf8' })
    } catch { /* proceed with empty diff */ }
  }

  const prompt = PROMPT_TEMPLATE
    .replace('{PR_TITLE}', prTitle)
    .replace('{REVIEW_COMMENT}', reviewComment.slice(0, 8000))
    .replace('{DIFF}', diff.slice(0, 16000))
    .replace('{EXTRA_INSTRUCTIONS}', instructions ? `Additional instructions: ${instructions}` : '')

  let output = ''
  try {
    // Pass prompt via stdin — same pattern as optimize.ts
    output = execFileSync('claude', ['--print', '--output-format', 'text'], {
      input: prompt,
      encoding: 'utf8',
      timeout: 180_000,
      env: { ...process.env },
      maxBuffer: 10 * 1024 * 1024,
    }).trim()
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err)
    if (/not logged in|auth|credential/i.test(msg)) {
      throw new Error('claude auth failure during address step — run: claude auth login')
    }
    throw err
  }

  if (!output || output === 'NO_CHANGES') return { appliedCount: 0 }

  // Parse <file path="...">content</file> blocks
  const fileRegex = /<file path="([^"]+)">([\s\S]*?)<\/file>/g
  let match: RegExpExecArray | null
  let appliedCount = 0

  while ((match = fileRegex.exec(output)) !== null) {
    const [, filePath, rawContent] = match
    // Reject paths that escape the repo (e.g. ../../etc/passwd)
    if (filePath.includes('..') || filePath.startsWith('/')) continue
    const absPath = join(tmpDir, filePath)
    try {
      writeFileSync(absPath, rawContent.replace(/^\n/, ''))
      appliedCount++
    } catch { /* skip unwritable paths */ }
  }

  return { appliedCount }
}
