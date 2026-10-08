import { execa } from 'execa'
import type { QualityConfig, OpenCodeVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { resolveOpenCodeModel } from '../lib/review-models.js'
import type { ReviewResult } from './claude.js'
import { withTimeoutRetry } from '../lib/with-timeout-retry.js'
import { vendorFailureSummary } from '../lib/vendor-error-summary.js'
import { tierTimeoutMs } from './tier-timeouts.js'
import { buildOpenCodeEnv } from './opencode-env.js'
import type { SkillActivationSession } from '../skills/broker.js'
import { loadRepositoryReviewGuidance } from '../lib/repository-guidance.js'

// OpenCode's reasoning-effort ladder is the `#variant` suffix on
// `--model provider/model#variant`. Variants are provider-defined, not one
// global ladder like claude/codex: deepseek-v4-* (the opencode models
// crosscheck ships policy for) expose none / high / max, with no low/medium.
// Whitelist rather than translation — anything outside this vocabulary falls
// back to `high` instead of reaching the CLI as an unsupported variant.
const OPENCODE_EFFORT_MAP: Record<string, string> = {
  none: 'none',
  high: 'high',
  max: 'max',
}

export function opencodeEffort(effort?: string): string {
  return (effort && OPENCODE_EFFORT_MAP[effort]) ?? 'high'
}

// OpenCode emits a JSONL stream under `--format json`. Each line is one event:
// `step_start` / `text` / `step_finish` (plus tool/step events). The review
// text lives in `part.text` on `text` lines, and token telemetry lives in the
// `part.tokens` object on the final `step_finish` line (nested under `part`,
// not a top-level field). There is no single JSON envelope like claude's
// `--output-format json` — parse line-by-line.
interface OpenCodeEvent {
  type?: string
  part?: {
    type?: string
    text?: string
    tokens?: { input?: number; output?: number; reasoning?: number }
  }
}

export function parseOpenCodeOutput(raw: string): { review: string; tokensUsed?: number } {
  let review = ''
  let inputTokens: number | undefined
  let outputTokens: number | undefined
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue
    let event: OpenCodeEvent
    try {
      event = JSON.parse(line) as OpenCodeEvent
    } catch {
      // Non-JSON line (progress/log noise) — skip, never fail the whole parse.
      continue
    }
    if (event.type === 'text' && event.part?.text) review += event.part.text
    if (event.type === 'step_finish' && event.part?.tokens) {
      inputTokens = event.part.tokens.input
      outputTokens = event.part.tokens.output
    }
  }
  const tokensUsed =
    inputTokens !== undefined && outputTokens !== undefined
      ? inputTokens + outputTokens
      : undefined
  return { review, tokensUsed }
}

// OpenCode follows the same VERDICT rule as claude (the behaviour block ends
// with "the very last line MUST be VERDICT: …"), so a run that ignores it is
// the rare path. Fall back to APPROVE — never a BLOCK invented from prose, which
// would be a claim about the diff nobody made.
export function inferVerdictFromOpenCodeOutput(_text: string): string {
  return 'APPROVE'
}

// Detect transient OpenCode errors that should be retried (rate limits, socket
// disconnects). OpenCode reports these through the same shapes as codex.
function isRetryableOpenCodeError(message: string): boolean {
  return /socket.*closed|429|rate limit|connection.*reset|econnreset/i.test(message)
}

const MAX_OPENCODE_RETRIES = 2
const OPENCODE_RETRY_DELAY_MS = 5000

// Scans stderr bottom-up for the first fatal/error line, skipping OpenCode
// header/log boilerplate.
function extractOpenCodeErrorSummary(stderr: string): string | undefined {
  const lines = stderr.split('\n').map(l => l.trim()).filter(Boolean)
  for (let i = lines.length - 1; i >= 0; i--) {
    const l = lines[i]
    if (/^(fatal|error):/i.test(l)) return l
  }
  return lines.filter(l =>
    !l.startsWith('---') &&
    !/^\d{4}-\d{2}-\d{2}T\d/.test(l) &&
    !/ WARN /i.test(l)
  ).at(-1)
}

export async function runOpenCodeReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: OpenCodeVendorConfig,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
  timeoutMs?: number,
  onRetry?: (msg: string) => void,
  issueContext?: string,
  _skillSession?: SkillActivationSession,
): Promise<ReviewResult> {
  const model = resolveOpenCodeModel(quality, vendor)
  const effort = opencodeEffort(vendor.effort)
  const tierTimeout = tierTimeoutMs(quality.tier)
  // timeoutMs: 0 → no cap (crazy/halfcrazy); undefined → tier-based default; positive → user-specified
  const resolvedTimeout = timeoutMs === undefined ? tierTimeout : timeoutMs === 0 ? undefined : timeoutMs

  const focusLine = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const customLine = quality.custom_prompt ?? ''

  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS
  const repositoryGuidance = loadRepositoryReviewGuidance(repoDir, baseBranch)

  // Same block order as runClaudeReview/runCodexReview, so the same PR gets the
  // same brief whichever vendor draws it: behaviour block ends on the verdict
  // rule, repository guidance after it (reference material, not a first step).
  const prompt = [
    `You are reviewing a pull request titled: "${prTitle}".`,
    `The branch \`${baseBranch}\` is the base. Review only the changes introduced in this PR.`,
    issueContext ?? '',
    focusLine,
    customLine,
    behaviorInstructions,
    repositoryGuidance,
  ].filter(Boolean).join('\n\n')

  // OpenCode takes the prompt on stdin (like claude/codex): `opencode run` with
  // no message argument reads stdin, and keeping the prompt out of argv stops
  // repository guidance from reaching the process list. `--standalone` runs a
  // private server, so a review of untrusted code never shares a session with
  // the operator's interactive work. `--auto` is required even for a read-only
  // review: a headless run auto-rejects permission requests otherwise, and
  // reviewing a diff can trip `external_directory` (the clone lives outside the
  // agent's workspace root) which is fatal without it. The env allowlist and
  // the throwaway clone bound the blast radius of the widened permissions.
  //
  // OpenCode has no separate effort flag — reasoning effort is the `#variant`
  // suffix on `--model provider/model#variant`. Without a pinned model there is
  // nowhere to hang the suffix, so `vendors.opencode.effort` is honoured only
  // when `vendors.opencode.model` is set; otherwise OpenCode's configured
  // default model AND its default variant run, and `effort` is reported but
  // not applied (it is not a claim the CLI was given).
  const modelArgs = model ? ['--model', `${model}#${effort}`] : []
  const args = ['run', '--format', 'json', '--auto', '--standalone', ...modelArgs]

  onLog?.(`  running: opencode run --format json --auto --standalone${model ? ` --model ${model}#${effort}` : ''}`)

  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= MAX_OPENCODE_RETRIES; attempt++) {
    try {
      const { result: { stdout }, retried } = await withTimeoutRetry(
        resolvedTimeout,
        (t) => execa('opencode', args, {
          cwd: repoDir,
          timeout: t,
          input: prompt,
          // extendEnv: false or execa merges process.env back in and the
          // allowlist means nothing.
          extendEnv: false,
          env: buildOpenCodeEnv({
            // Make local dev tools findable if node_modules exists.
            PATH: `${repoDir}/node_modules/.bin:${process.env.PATH ?? ''}`,
          }),
        }),
        {
          onRetry: (effectiveMs, delayMs) =>
            (onRetry ?? onLog)?.(`  ⏱ opencode timed out at ${effectiveMs / 1000}s — waiting ${delayMs / 1000}s and retrying once`),
        },
      )

      const { review: parsedReview, tokensUsed } = parseOpenCodeOutput(stdout ?? '')
      const rawReview = parsedReview.trim()
      const review = rawReview.includes('VERDICT:')
        ? rawReview
        : `${rawReview}\n\nVERDICT: ${inferVerdictFromOpenCodeOutput(rawReview)}`
      return { review, tokensUsed, model: model ?? 'default', effort, retried }
    } catch (err: unknown) {
      const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean; effectiveTimeoutMs?: number; retryDelayMs?: number }
      const rawStderr = execa.stderr ?? ''
      const fullMessage = rawStderr || execa.message || ''

      if (isRetryableOpenCodeError(fullMessage) && attempt < MAX_OPENCODE_RETRIES) {
        const delay = OPENCODE_RETRY_DELAY_MS * attempt // 5s, 10s
        onLog?.(`  opencode: transient error (${fullMessage.slice(0, 80)}), retrying in ${delay / 1000}s (attempt ${attempt}/${MAX_OPENCODE_RETRIES})...`)
        await new Promise<void>(resolve => setTimeout(resolve, delay))
        lastErr = err
        continue
      }

      const effectiveMs = execa.effectiveTimeoutMs ?? resolvedTimeout
      const retryNote = execa.retryDelayMs !== undefined ? ' (retried once)' : ''
      const summary = execa.timedOut
        ? `timed out after ${effectiveMs !== undefined ? effectiveMs / 1000 : '?'}s${retryNote} — PR diff may be too large (tier: ${quality.tier})`
        : vendorFailureSummary(execa, extractOpenCodeErrorSummary)
      const thrown = Object.assign(new Error(`opencode: ${summary}`), {
        exitCode: execa.exitCode,
        timedOut: execa.timedOut,
        stderr: rawStderr,
        effectiveTimeoutMs: effectiveMs,
        retryDelayMs: execa.retryDelayMs,
      })
      throw thrown
    }
  }

  if (lastErr) throw lastErr
  throw new Error('opencode: unexpected retry loop exit')
}

export async function checkOpenCodeAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    // `opencode --version` only proves the CLI is installed, not that a provider
    // is configured — a review against an unconfigured opencode fails at run
    // time. `opencode auth list` lists stored provider credentials, so a non-empty
    // list is the availability signal onboarding/status/init report.
    const { stdout } = await execa('opencode', ['auth', 'list'], { timeout: 10_000 })
    const providers = stdout.trim().split('\n').map(l => l.trim()).filter(Boolean)
    if (providers.length === 0) {
      return { ok: false, detail: 'no providers configured — run: opencode auth login' }
    }
    return { ok: true, detail: `${providers.length} provider(s) configured` }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not found' }
  }
}
