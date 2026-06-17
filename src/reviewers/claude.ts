import { execa } from 'execa'
import type { QualityConfig, VendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { primaryModelFromUsage, resolveClaudeModel } from '../lib/review-models.js'
import { withTimeoutRetry } from '../lib/with-timeout-retry.js'
import { tierTimeoutMs } from './tier-timeouts.js'

const EFFORT_MAP: Record<string, string> = {
  low: 'low',
  medium: 'medium',
  high: 'high',
  max: 'max',
}

export interface ReviewResult {
  review: string
  tokensUsed?: number
  inputTokens?: number
  outputTokens?: number
  model: string
  // Set only when the first attempt timed out and the delayed retry succeeded —
  // signals a transient blip that resolved on its own. The runner surfaces this
  // as a soft banner on the posted review comment.
  retried?: { timeoutMs: number; delayMs: number }
}

interface ClaudeJsonOutput {
  result?: unknown
  usage?: {
    input_tokens?: unknown
    output_tokens?: unknown
  }
  modelUsage?: unknown
}

export async function runClaudeReview(
  repoDir: string,
  baseBranch: string,
  prTitle: string,
  quality: QualityConfig,
  vendor: VendorConfig,
  perReviewBudget: number,
  stepInstructions?: string,
  onLog?: (msg: string) => void,
  timeoutMs?: number,
  noBudgetCap?: boolean,
  // Fires once after the first attempt times out, before the delayed retry.
  // Split from onLog so callers (e.g. runner) can stay silent on routine
  // `running: ...` chatter while still surfacing the retry signal live.
  onRetry?: (msg: string) => void,
): Promise<ReviewResult> {
  const model = resolveClaudeModel(quality, vendor)
  const effort = EFFORT_MAP[vendor.effort] ?? 'medium'
  const focusLine = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const customLine = quality.custom_prompt ?? ''

  const behaviorInstructions = stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS

  const prompt = [
    `You are reviewing a pull request titled: "${prTitle}".`,
    `The branch \`${baseBranch}\` is the base. Review only the changes introduced in this PR.`,
    focusLine,
    customLine,
    behaviorInstructions,
  ].filter(Boolean).join('\n')

  // Omit --max-budget-usd when:
  // 1. No ANTHROPIC_API_KEY → subscription mode (claude.ai plan, budget limits don't apply)
  // 2. noBudgetCap → crazy/halfcrazy mode (explicitly uncapped run; NOT set by --no-timeout alone)
  const applyBudgetCap = !!process.env.ANTHROPIC_API_KEY && !noBudgetCap

  const args = [
    '--print',
    '--output-format', 'json',
    '--model', model,
    '--effort', effort,
    ...(applyBudgetCap ? ['--max-budget-usd', String(perReviewBudget)] : []),
    '--allowedTools', 'Bash(git diff),Bash(git log)',
  ]

  onLog?.(`  running: claude --print --model ${model} --effort ${effort}`)

  // timeoutMs: 0 → no cap (crazy/halfcrazy); undefined → tier-based default (300/600/1200s); positive → user-specified
  const resolvedTimeout = timeoutMs === undefined ? tierTimeoutMs(quality.tier) : timeoutMs === 0 ? undefined : timeoutMs

  try {
    const { result: { stdout }, retried } = await withTimeoutRetry(
      resolvedTimeout,
      (t) => execa('claude', args, { cwd: repoDir, timeout: t, input: prompt, env: { ...process.env } }),
      {
        onRetry: (effectiveMs, delayMs) =>
          (onRetry ?? onLog)?.(`  ⏱ claude timed out at ${effectiveMs / 1000}s — waiting ${delayMs / 1000}s and retrying once`),
      },
    )
    const raw = stdout.trim()
    try {
      const parsed: ClaudeJsonOutput = JSON.parse(raw)
      const review = typeof parsed.result === 'string' ? parsed.result.trim() : raw
      const inputTokens = typeof parsed.usage?.input_tokens === 'number' ? parsed.usage.input_tokens : undefined
      const outputTokens = typeof parsed.usage?.output_tokens === 'number' ? parsed.usage.output_tokens : undefined
      const tokensUsed = inputTokens !== undefined && outputTokens !== undefined ? inputTokens + outputTokens : undefined
      // Report the model that actually served the review, not the requested
      // string: `model` may be an alias ("opus") and the CLI resolves or
      // substitutes it. Fall back to the requested value when absent.
      const actualModel = primaryModelFromUsage(parsed.modelUsage)
      return { review, tokensUsed, inputTokens, outputTokens, model: actualModel ?? model, retried }
    } catch {
      return { review: raw, model, retried }
    }
  } catch (err: unknown) {
    const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean; effectiveTimeoutMs?: number; retryDelayMs?: number }
    const rawStderr = execa.stderr?.trim() ?? ''
    const effectiveMs = execa.effectiveTimeoutMs ?? resolvedTimeout
    const retryNote = execa.retryDelayMs !== undefined ? ' (retried once)' : ''
    const summary = execa.timedOut
      ? `timed out after ${effectiveMs !== undefined ? effectiveMs / 1000 : '?'}s${retryNote} — PR diff may be too large`
      : (rawStderr.split('\n').filter(Boolean).at(-1)) ?? execa.message ?? 'unknown error'
    const thrown = Object.assign(new Error(`claude: ${summary}`), {
      exitCode: execa.exitCode,
      timedOut: execa.timedOut,
      stderr: rawStderr,
      effectiveTimeoutMs: effectiveMs,
      retryDelayMs: execa.retryDelayMs,
    })
    throw thrown
  }
}

export async function checkClaudeAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('claude', ['--version'], { timeout: 10_000 })
    return { ok: true, detail: stdout.trim() }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not found' }
  }
}
