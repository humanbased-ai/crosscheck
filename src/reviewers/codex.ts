import { execa } from 'execa'
import { mkdirSync, realpathSync, rmSync, writeFileSync } from 'fs'
import { randomUUID } from 'crypto'
import { homedir } from 'os'
import { join } from 'path'
import type { QualityConfig, CodexVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { resolveCodexModel } from '../lib/review-models.js'
import type { ReviewResult } from './claude.js'
import { withTimeoutRetry } from '../lib/with-timeout-retry.js'
import { tierTimeoutMs } from './tier-timeouts.js'
import { codexSkillBrokerArgs, renderSkillBrokerInstructions, type SkillActivationSession } from '../skills/broker.js'
import { loadRepositoryReviewGuidance } from '../lib/repository-guidance.js'

// Codex review command outputs [P0]/[P1]/[P2]/[P3] priority markers but never a VERDICT line.
// Infer the verdict from the highest severity present and append it so parseVerdict() can
// extract it. Only called when the output doesn't already contain a VERDICT: token.
export function inferVerdictFromCodexOutput(text: string): string {
  if (/\[P0\]/i.test(text) || /\[P1\]/i.test(text)) return 'BLOCK'
  if (/\[P2\]/i.test(text) || /\[P3\]/i.test(text)) return 'NEEDS WORK'
  return 'APPROVE'
}

// Codex prints file references as absolute paths inside the temporary clone dir
// (e.g. /private/var/.../crosscheck-repo-XXXX/src/a.ts:12). Strip that prefix so
// posted comments show repo-relative paths. Handles both the dir as given and its
// realpath — on macOS tmpdir() returns a /var symlink but codex resolves /private/var.
export function stripRepoDirPaths(text: string, repoDir: string): string {
  const variants = new Set([repoDir])
  try { variants.add(realpathSync(repoDir)) } catch { /* dir may already be gone */ }
  let out = text
  // Longest first: the realpath contains the symlinked path as a suffix
  // (/private/var/... vs /var/...), so stripping the short one first would
  // leave a /private remnant behind.
  for (const dir of [...variants].sort((a, b) => b.length - a.length)) {
    out = out.split(`${dir}/`).join('')
  }
  return out
}

// vendors.codex.effort matches the codex CLI's model_reasoning_effort values
// 1:1 (low/medium/high/xhigh/max/ultra), so this is a whitelist rather than a
// translation — anything outside it falls back to medium instead of reaching
// the CLI as an arbitrary string.
const REASONING_EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  xhigh: 'xhigh',
  max: 'max',
  ultra: 'ultra',
}

export function codexReasoningEffort(effort: string): string {
  return REASONING_EFFORT_MAP[effort] ?? 'medium'
}

// Detect transient Codex API errors that should be retried (socket disconnects, rate limits)
function isRetryableCodexError(message: string): boolean {
  return /socket.*closed|429|rate limit|connection.*reset|econnreset/i.test(message)
}

const MAX_CODEX_RETRIES = 2
const CODEX_RETRY_DELAY_MS = 5000

// Scans stderr bottom-up for the first fatal/error line, skipping Codex header boilerplate.
function extractErrorSummary(stderr: string): string | undefined {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/^(fatal|error):/i.test(l)) return l
  }
  // Fall back to last non-boilerplate line, excluding log noise that is not an error
  return lines.filter(l =>
    !l.startsWith('---') &&
    !/^(workdir|model|provider|approval|sandbox|reasoning|session\s+id):/i.test(l) &&
    !/^OpenAI Codex/i.test(l) &&
    !/ WARN /i.test(l) &&
    !/^\d{4}-\d{2}-\d{2}T\d/.test(l)
  ).at(-1)
}

export async function runCodexReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: CodexVendorConfig,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
  timeoutMs?: number,
  // Fires once after the first attempt times out, before the delayed retry.
  // Split from onLog so callers (e.g. runner) can stay silent on routine
  // `running: ...` chatter while still surfacing the retry signal live.
  onRetry?: (msg: string) => void,
  // Linked tracker issue rendered as a prompt block (issues/enrich.ts) — anchors
  // the review to the stated goal. Omitted when enrichment is off / unresolved.
  issueContext?: string,
  skillSession?: SkillActivationSession,
): Promise<ReviewResult> {
  const model = resolveCodexModel(quality, vendor)
  const tierTimeout = tierTimeoutMs(quality.tier)
  // timeoutMs: 0 → no cap (crazy/halfcrazy); undefined → tier-based default; positive → user-specified
  const resolvedTimeout = timeoutMs === undefined ? tierTimeout : timeoutMs === 0 ? undefined : timeoutMs

  // --base and [PROMPT] are mutually exclusive in codex review, so deliver
  // Crosscheck's trusted guidance through a temporary Codex profile.
  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}. `
    : ''
  const customNote = quality.custom_prompt ?? ''
  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS
  const repositoryGuidance = loadRepositoryReviewGuidance(repoDir, baseBranch)
  // Skill block ahead of behaviorInstructions — see the note in claude.ts: the
  // behaviour block ends on the verdict rule, so a trailing skill section reads
  // as boilerplate past the end of the prompt. repositoryGuidance stays after
  // it: reference material read during the review, not a first step.
  const instructionsNote = [issueContext ?? '', focusNote, customNote, skillSession ? renderSkillBrokerInstructions(skillSession) : '', behaviorInstructions, repositoryGuidance].filter(Boolean).join('\n\n')
  const codexHome = process.env.CODEX_HOME ?? join(homedir(), '.codex')
  const profileName = `crosscheck-${randomUUID()}`
  const profilePath = join(codexHome, `${profileName}.config.toml`)
  mkdirSync(codexHome, { recursive: true })

  // Retry loop for transient Codex API errors (socket disconnects, rate limits)
  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= MAX_CODEX_RETRIES; attempt++) {
    try {
      const modelArgs = model !== 'default' ? ['-c', `model="${model}"`] : []
      const skillArgs = codexSkillBrokerArgs(skillSession)
      const reasoningEffort = codexReasoningEffort(vendor.effort)
      const effortArgs = ['-c', `model_reasoning_effort="${reasoningEffort}"`]
      onLog?.(`  running: codex review --base ${baseBranch}${model !== 'default' ? ` -c model="${model}"` : ''} -c model_reasoning_effort="${reasoningEffort}"`)

      writeFileSync(profilePath, `developer_instructions = ${JSON.stringify(instructionsNote)}\n`, { mode: 0o600 })
      try {
        const { result, retried } = await withTimeoutRetry(
          resolvedTimeout,
          (t) => execa(
            'codex',
            ['-p', profileName, 'review', '--base', baseBranch, '--title', prTitle, '-c', 'project_doc_max_bytes=0', ...modelArgs, ...effortArgs, ...skillArgs],
            {
              cwd: repoDir,
              timeout: t,
              env: {
                ...process.env,
                // Make local dev tools (tsc, jest, etc.) findable if node_modules exists
                PATH: `${repoDir}/node_modules/.bin:${process.env.PATH ?? ''}`,
              },
            },
          ),
          {
            onRetry: (effectiveMs, delayMs) =>
              (onRetry ?? onLog)?.(`  ⏱ codex timed out at ${effectiveMs / 1000}s — waiting ${delayMs / 1000}s and retrying once`),
          },
        )

        const rawReview = stripRepoDirPaths(result.stdout.trim() || result.stderr.trim(), repoDir)
        const tokensMatch = (result.stderr ?? '').match(/\btokens?:\s*([\d,]+)/i)
        const tokensUsed = tokensMatch ? parseInt(tokensMatch[1].replace(/,/g, ''), 10) : undefined
        // Append inferred VERDICT when Codex didn't include one (its review command
        // uses [P1]/[P2]/[P3] markers but never emits a VERDICT: line on its own).
        const review = rawReview.includes('VERDICT:')
          ? rawReview
          : `${rawReview}\n\nVERDICT: ${inferVerdictFromCodexOutput(rawReview)}`
        return { review, tokensUsed, model, retried }
      } finally {
        rmSync(profilePath, { force: true })
      }
    } catch (err: unknown) {
      const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean; effectiveTimeoutMs?: number; retryDelayMs?: number }
      const rawStderr = execa.stderr ?? ''
      const fullMessage = rawStderr || execa.message || ''

      // Check if this is a retryable error
      if (isRetryableCodexError(fullMessage) && attempt < MAX_CODEX_RETRIES) {
        const delay = CODEX_RETRY_DELAY_MS * attempt // 5s, 10s
        onLog?.(`  codex: transient error (${fullMessage.slice(0, 80)}), retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_CODEX_RETRIES})...`)
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        lastErr = err
        continue
      }

      // Non-retryable error or final attempt — format and throw
      const effectiveMs = execa.effectiveTimeoutMs ?? resolvedTimeout
      const retryNote = execa.retryDelayMs !== undefined ? ' (retried once)' : ''
      const summary = execa.timedOut
        ? `timed out after ${effectiveMs !== undefined ? effectiveMs / 1000 : '?'}s${retryNote} — PR diff may be too large (tier: ${quality.tier})`
        : (extractErrorSummary(rawStderr) ?? execa.message ?? 'unknown error')
      const thrown = Object.assign(new Error(`codex: ${summary}`), {
        exitCode: execa.exitCode,
        timedOut: execa.timedOut,
        stderr: rawStderr,
        effectiveTimeoutMs: effectiveMs,
        retryDelayMs: execa.retryDelayMs,
      })
      throw thrown
    }
  }

  // Should not reach here, but handle the case where all retries were consumed
  if (lastErr) throw lastErr
  throw new Error('codex: unexpected retry loop exit')
}

export async function checkCodexAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('codex', ['login', 'status'], { timeout: 10_000 })
    return { ok: true, detail: stdout.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not authenticated' }
  }
}
