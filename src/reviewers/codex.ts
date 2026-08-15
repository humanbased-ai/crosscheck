import { execa } from 'execa'
import { readFileSync, realpathSync, rmSync } from 'fs'
import { randomUUID } from 'crypto'
import { tmpdir } from 'os'
import { join } from 'path'
import type { QualityConfig, CodexVendorConfig } from '../config/schema.js'
import { DEFAULT_REVIEW_INSTRUCTIONS } from '../lib/workflow.js'
import { resolveCodexModel } from '../lib/review-models.js'
import type { ReviewResult } from './claude.js'
import { withTimeoutRetry } from '../lib/with-timeout-retry.js'
import { tierTimeoutMs } from './tier-timeouts.js'
import { codexSkillBrokerArgs, codexSkillsReachable, renderSkillBrokerInstructions, type SkillActivationSession } from '../skills/broker.js'
import { buildCodexEnv } from './codex-env.js'
import { withCredentialFreeOrigin } from '../lib/clone.js'
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

export interface CodexReviewPromptInput {
  prTitle: string
  baseBranch: string
  /** Linked tracker issue, rendered as a prompt block by issues/enrich.ts. */
  issueContext?: string
  focusLine?: string
  customPrompt?: string
  /** renderSkillBrokerInstructions output; empty when skills are off. */
  skillInstructions?: string
  /** The step's own instructions — ends with the machine-parsed verdict rule. */
  behaviorInstructions: string
  repositoryGuidance?: string
}

// `codex review --base` scoped the diff by itself; `codex exec` does not, so the
// prompt has to name the range. It gives the exact command rather than the branch
// name: the clone creates `refs/remotes/origin/<base>` and no local `<base>`
// branch, so `git diff <base>...HEAD` — the obvious reading of a bare branch name
// — fails outright on any non-default base and can leave the agent reviewing an
// empty diff. `codex exec review --base` is not the alternative it appears to be:
// there `--base` and a custom prompt are mutually exclusive, so it cannot carry
// the verdict rule or the skill instructions. Block order matches runClaudeReview
// exactly, so the same PR gets the same brief whichever vendor draws it:
// skills before the behaviour block (activation must happen before the review
// starts, and the behaviour block ends on the verdict rule, so anything after it
// reads as boilerplate past the end of the prompt), repository guidance after it
// (reference material consulted while reviewing, not a first step).
export function buildCodexReviewPrompt(input: CodexReviewPromptInput): string {
  return [
    `You are reviewing a pull request titled: "${input.prTitle}".`,
    `The branch \`${input.baseBranch}\` is the base. Review only the changes introduced in this PR.`,
    `Read them with \`git diff origin/${input.baseBranch}...HEAD\` — this checkout has the remote-tracking ref \`origin/${input.baseBranch}\`, not a local \`${input.baseBranch}\` branch.`,
    input.issueContext ?? '',
    input.focusLine ?? '',
    input.customPrompt ?? '',
    input.skillInstructions ?? '',
    input.behaviorInstructions,
    input.repositoryGuidance ?? '',
  ].filter(Boolean).join('\n\n')
}

// `codex exec` prints usage as a "tokens used" heading with the count beneath it;
// `codex review` used an inline "tokens: N". Both are read so the move between
// subcommands did not silently drop token telemetry. Anchored to the start of a
// line so the word "tokens" in review prose cannot be mistaken for a usage
// report, and takes the last match because a retried run reports more than once.
export function parseCodexTokensUsed(output: string): number | undefined {
  const matches = [...output.matchAll(/^[^\S\n]*tokens(?:\s+used\s*\n|\s*:)[^\S\n]*([\d,]+)/gim)]
  const last = matches.at(-1)
  if (!last) return undefined
  const parsed = parseInt(last[1].replace(/,/g, ''), 10)
  return Number.isNaN(parsed) ? undefined : parsed
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
  // skills.codex_full_access. Codex reaches the broker only with the sandbox off,
  // so this is what decides whether skills are offered to codex at all.
  codexFullAccess = false,
): Promise<ReviewResult> {
  const model = resolveCodexModel(quality, vendor)
  const tierTimeout = tierTimeoutMs(quality.tier)
  // timeoutMs: 0 → no cap (crazy/halfcrazy); undefined → tier-based default; positive → user-specified
  const resolvedTimeout = timeoutMs === undefined ? tierTimeout : timeoutMs === 0 ? undefined : timeoutMs

  // `codex exec`, not `codex review`: the review subcommand starts no MCP
  // servers at all — not the ones passed with -c, not the ones in
  // ~/.codex/config.toml — so the skill broker was unreachable and the prompt's
  // "call list_enabled_skills first" named a tool that did not exist in the
  // session. `exec` takes both a prompt and MCP config, which also retires the
  // temporary Codex profile that only existed because `--base` and [PROMPT] are
  // mutually exclusive in `codex review`.
  const focusNote = quality.focus.length > 0
    ? `Focus areas: ${quality.focus.join(', ')}.`
    : ''
  const prompt = buildCodexReviewPrompt({
    prTitle,
    baseBranch,
    issueContext,
    focusLine: focusNote,
    customPrompt: quality.custom_prompt,
    // Gated, not merely unused: telling codex to call a tool it cannot reach is
    // how this failed before — 244 runs obliged to call `list_enabled_skills`,
    // every call cancelled, 0 activations.
    skillInstructions: codexSkillsReachable(skillSession, codexFullAccess)
      ? renderSkillBrokerInstructions(skillSession)
      : undefined,
    behaviorInstructions: stepInstructions ?? DEFAULT_REVIEW_INSTRUCTIONS,
    repositoryGuidance: loadRepositoryReviewGuidance(repoDir, baseBranch),
  })

  // Retry loop for transient Codex API errors (socket disconnects, rate limits)
  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= MAX_CODEX_RETRIES; attempt++) {
    try {
      const modelArgs = model !== 'default' ? ['-c', `model="${model}"`] : []
      const skillArgs = codexSkillBrokerArgs(skillSession, codexFullAccess)
      const reasoningEffort = codexReasoningEffort(vendor.effort)
      const effortArgs = ['-c', `model_reasoning_effort="${reasoningEffort}"`]
      // The agent's final message is the review. Reading it from a file rather
      // than stdout keeps session chatter out of the posted comment, and leaves
      // stdout free to carry the usage line quiet mode would suppress.
      const lastMessagePath = join(tmpdir(), `crosscheck-codex-review-${randomUUID()}.md`)
      onLog?.(`  running: codex exec --base ${baseBranch}${model !== 'default' ? ` -c model="${model}"` : ''} -c model_reasoning_effort="${reasoningEffort}"`)

      try {
        const { result, retried } = await withCredentialFreeOrigin(repoDir, () => withTimeoutRetry(
          resolvedTimeout,
          (t) => execa(
            'codex',
            // Prompt on stdin (`-`), not argv: it carries repository guidance and
            // tracker-issue context, which the retired profile file kept out of
            // the process list. runClaudeReview feeds its prompt the same way.
            //
            // --ignore-user-config: `codex exec` reads ~/.codex/config.toml, which
            // `codex review` never did. That would hand a review of untrusted code
            // the operator's own MCP servers and plugins — every connected service
            // reachable from a prompt injection. Crosscheck passes everything it
            // needs with -c, so there is nothing to lose by ignoring the rest.
            // Auth is unaffected: it lives in auth.json, not config.toml.
            ['exec', '--ignore-user-config', '-c', 'project_doc_max_bytes=0', ...modelArgs, ...effortArgs, ...skillArgs, '--output-last-message', lastMessagePath, '-'],
            {
              cwd: repoDir,
              timeout: t,
              input: prompt,
              // extendEnv: false or execa merges process.env back in and the
              // allowlist means nothing. Verified: with this, a shell command run
              // by codex finds neither GITHUB_TOKEN nor any other export.
              extendEnv: false,
              env: buildCodexEnv({
                // Make local dev tools (tsc, jest, etc.) findable if node_modules exists
                PATH: `${repoDir}/node_modules/.bin:${process.env.PATH ?? ''}`,
              }),
            },
          ),
          {
            onRetry: (effectiveMs, delayMs) =>
              (onRetry ?? onLog)?.(`  ⏱ codex timed out at ${effectiveMs / 1000}s — waiting ${delayMs / 1000}s and retrying once`),
          },
        ))

        // Fall back to stdout only if the agent wrote no final message — an
        // aborted run leaves the file empty and stdout is then all there is.
        let lastMessage = ''
        try { lastMessage = readFileSync(lastMessagePath, 'utf8').trim() } catch { /* no final message */ }
        const rawReview = stripRepoDirPaths(lastMessage || result.stdout.trim() || result.stderr.trim(), repoDir)
        const tokensUsed = parseCodexTokensUsed(`${result.stdout ?? ''}\n${result.stderr ?? ''}`)
        // Safety net for a run that ignored the verdict rule. `codex exec` follows
        // it (unlike `codex review`, whose own format emits [P0]-[P3] markers and
        // never a VERDICT line), so this should now be the rare path.
        const review = rawReview.includes('VERDICT:')
          ? rawReview
          : `${rawReview}\n\nVERDICT: ${inferVerdictFromCodexOutput(rawReview)}`
        return { review, tokensUsed, model, effort: reasoningEffort, retried }
      } finally {
        rmSync(lastMessagePath, { force: true })
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
