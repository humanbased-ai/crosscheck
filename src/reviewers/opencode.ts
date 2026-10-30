import { execa } from 'execa'
import { rmSync, mkdtempSync, renameSync, existsSync, writeFileSync, accessSync, statSync, constants } from 'fs'
import { join, delimiter } from 'path'
import { tmpdir } from 'os'
import { stripVTControlCharacters } from 'util'
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
import { withCredentialFreeOrigin } from '../lib/clone.js'

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
  let inputTokens = 0
  let outputTokens = 0
  let reasoningTokens = 0
  let sawTokens = false
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
      // Each model step emits its own payload; accumulate rather than overwrite,
      // and include reasoning so a multi-step run is not undercounted.
      const t = event.part.tokens
      if (typeof t.input === 'number') inputTokens += t.input
      if (typeof t.output === 'number') outputTokens += t.output
      if (typeof t.reasoning === 'number') reasoningTokens += t.reasoning
      sawTokens = true
    }
  }
  const tokensUsed = sawTokens ? inputTokens + outputTokens + reasoningTokens : undefined
  return { review, tokensUsed }
}

// OpenCode follows the same VERDICT rule as claude/codex, so a well-behaved run
// ends with the line. Match it case-insensitively: a `Verdict: BLOCK` that the
// old exact-match check missed then received an appended APPROVE, which the
// parser read as the final verdict. When no verdict was stated at all, default
// to NEEDS WORK — never APPROVE, which would clear a PR on a verdict nobody
// gave (an empty or refusing body is caught earlier by detectInconclusiveReview).
export function inferVerdictFromOpenCodeOutput(text: string): string {
  return /\bVERDICT\s*:/i.test(text) ? text : `${text}\n\nVERDICT: NEEDS WORK`
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

// OpenCode auto-discovers a project's own opencode.json / .opencode directory
// from the working directory upward, and loads any plugin they register. In an
// untrusted checkout that is an arbitrary-code channel independent of the
// prompt, and OpenCode v2 has no `--pure` / config override flag to suppress it.
// Remove them before the run so only the operator's global config applies. The
// clone is a throwaway and a review reads the diff, not these files.
// A restrictive permission policy for the untrusted run. OpenCode has no
// sandbox flag, so this is the tool-denial layer: a review inspects the diff by
// running read-only git, so allow exactly those shell commands and deny every
// other one. `--auto` auto-approves `ask` but cannot widen a `deny`.
// `allowEdit` is left for the fix step, which must write files.
//
// The schema changed in v2: v1 uses a `permission` object keyed by tool name
// with the last matching pattern winning, while v2 uses a `permissions` array
// of `{ action, resource, effect }` rules. A v1 CLI rejects the v2 key outright
// ("V2 permissions are not supported by OpenCode V1"), so the caller must pass
// the format of the installed binary. v1's shell tool ID is `bash` (the older
// docs call it `shell`); keying the rule as `shell` leaves it unmatched.
export type OpenCodePolicyFormat = 'v1' | 'v2'

export function opencodePolicy(allowEdit: boolean, format: OpenCodePolicyFormat): unknown {
  if (format === 'v1') {
    return {
      permission: {
        // Conflict resolution edits untrusted paths. Keep OpenCode from
        // following a path the checkout redirects outside its own workspace.
        external_directory: 'deny',
        bash: {
          '*': 'deny',
          // A `verb *` pattern may not match the bare command, so allow both.
          'git status': 'allow',
          'git status *': 'allow',
          'git diff': 'allow',
          'git diff *': 'allow',
          'git log': 'allow',
          'git log *': 'allow',
          'git show': 'allow',
          'git show *': 'allow',
          // Keep the read-only allowlist from turning git diff into a file write.
          'git diff --output*': 'deny',
          'git diff -o*': 'deny',
        },
        ...(allowEdit ? {} : { edit: 'deny' }),
      },
    }
  }
  return {
    permissions: [
      { action: 'external_directory', resource: '*', effect: 'deny' },
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'git status *', effect: 'allow' },
      { action: 'shell', resource: 'git diff *', effect: 'allow' },
      { action: 'shell', resource: 'git log *', effect: 'allow' },
      { action: 'shell', resource: 'git show *', effect: 'allow' },
      // The final matching rule wins: do not let git diff output to a file.
      { action: 'shell', resource: 'git diff --output*', effect: 'deny' },
      { action: 'shell', resource: 'git diff -o*', effect: 'deny' },
      ...(allowEdit ? [] : [{ action: 'edit', resource: '*', effect: 'deny' }]),
    ],
  }
}

export function isolateCheckoutOpenCodeConfig(
  repoDir: string,
  allowEdit: boolean,
  format: OpenCodePolicyFormat,
): () => void {
  const backupDir = mkdtempSync(join(tmpdir(), 'crosscheck-oc-config-'))
  const moved: Array<{ from: string; to: string }> = []
  for (const rel of ['opencode.json', 'opencode.jsonc', '.opencode']) {
    const from = join(repoDir, rel)
    if (!existsSync(from)) continue
    const to = join(backupDir, rel.replace(/[/\\]/g, '_'))
    try { renameSync(from, to); moved.push({ from, to }) } catch { /* best effort */ }
  }
  // Install the policy as the project config this run will load; remove it on
  // restore so a later fix's `git add -A` cannot stage it.
  let policyWritten = false
  try {
    writeFileSync(join(repoDir, 'opencode.json'), JSON.stringify(opencodePolicy(allowEdit, format), null, 2))
    policyWritten = true
  } catch { /* best effort */ }
  // Restore the checkout's own config so a later fix step does not stage these
  // tracked deletions as changed files (git add -A would then commit and push).
  return () => {
    if (policyWritten) { try { rmSync(join(repoDir, 'opencode.json'), { force: true }) } catch { /* best effort */ } }
    const failed: string[] = []
    for (const { from, to } of moved.reverse()) {
      try { renameSync(to, from) } catch { failed.push(from) }
    }
    // Delete the backup only when every path was restored. If the agent recreated
    // a conflicting path, keep the backup and fail loudly so the original tracked
    // configuration is never silently lost.
    if (failed.length > 0) {
      throw new Error(`could not restore OpenCode config: ${failed.join(', ')} (backup kept at ${backupDir})`)
    }
    try { rmSync(backupDir, { recursive: true, force: true }) } catch { /* best effort */ }
  }
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
  // repository guidance from reaching the process list. `--auto` is required
  // even for a read-only review: a headless run auto-rejects permission
  // requests otherwise, and reviewing a diff can trip `external_directory`
  // (the clone lives outside the agent's workspace root) which is fatal
  // without it. The env allowlist and the throwaway clone bound the blast
  // radius of the widened permissions. `--standalone` (a private server, so a
  // review never shares a session with the operator) is v2-only and is added
  // only when the installed CLI accepts it; a CLI without `--auto` is refused
  // up front (see requireOpenCodeRun).
  //
  // OpenCode has no separate effort flag — reasoning effort is the `#variant`
  // suffix on `--model provider/model#variant`. Without a pinned model there is
  // nowhere to hang the suffix, so `vendors.opencode.effort` is honoured only
  // when `vendors.opencode.model` is set; otherwise OpenCode's configured
  // default model AND its default variant run, and `effort` is reported but
  // not applied (it is not a claim the CLI was given).
  const modelArgs = model ? ['--model', `${model}#${effort}`] : []
  const { baseArgs, policyFormat } = await requireOpenCodeRun()
  const args = [...baseArgs, ...modelArgs]

  onLog?.(`  running: opencode ${args.join(' ')}`)

  let lastErr: unknown = undefined
  for (let attempt = 1; attempt <= MAX_OPENCODE_RETRIES; attempt++) {
    try {
      const { result: { stdout }, retried } = await withCredentialFreeOrigin(repoDir, () => {
        // Hide any OpenCode config the untrusted checkout carries while the agent
        // runs; restore it after so a later fix step cannot stage the deletion.
        const restoreConfig = isolateCheckoutOpenCodeConfig(repoDir, false, policyFormat)
        return withTimeoutRetry(
          resolvedTimeout,
          (t) => execa('opencode', args, {
            cwd: repoDir,
            timeout: t,
            input: prompt,
            // extendEnv: false or execa merges process.env back in and the
            // allowlist means nothing.
            extendEnv: false,
            // No `${repoDir}/node_modules/.bin` on PATH: the checkout is untrusted
            // and a committed `node_modules/.bin/opencode` would shadow the real
            // executable. A review only reads the diff, so repo-local tools are
            // not needed the way codex.ts assumed they were.
            env: buildOpenCodeEnv(),
          }),
          {
            onRetry: (effectiveMs, delayMs) =>
              (onRetry ?? onLog)?.(`  ⏱ opencode timed out at ${effectiveMs / 1000}s — waiting ${delayMs / 1000}s and retrying once`),
          },
        ).finally(restoreConfig)
      })

      const { review: parsedReview, tokensUsed } = parseOpenCodeOutput(stdout ?? '')
      const rawReview = parsedReview.trim()
      const review = inferVerdictFromOpenCodeOutput(rawReview)
      // Report effort only when a pinned model actually carried the #variant;
      // with no model there is no suffix, so claiming a level would be false.
      return { review, tokensUsed, model: model ?? 'default', effort: model ? effort : undefined, retried }
    } catch (err: unknown) {
      const execa = err as { stdout?: string; stderr?: string; message?: string; exitCode?: number; timedOut?: boolean; effectiveTimeoutMs?: number; retryDelayMs?: number }
      const rawStderr = execa.stderr ?? ''
      const fullMessage = rawStderr || execa.message || ''

      const usageRejected = isOpenCodeUsageOutput(rawStderr)
      if (!usageRejected && isRetryableOpenCodeError(fullMessage) && attempt < MAX_OPENCODE_RETRIES) {
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
        : usageRejected
          ? OPENCODE_USAGE_SUMMARY
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

// The installed `opencode` is probed from `run --help` for each invocation
// rather than assumed from its version, because the CLI surface differs between
// installs: `--standalone` exists only in the v2 CLI (v1 rejects it before
// reading stdin), and `--auto` is missing from older v1 releases such as 1.2.x.
// A CLI that rejects an unknown flag prints yargs usage and exits 1, so every
// review and fix would fail with help text. The probe is deliberately not
// cached: a long-lived crosscheck process can outlive an OpenCode upgrade, and
// either cached answer would then be wrong.
//
// On v2, omitting `--standalone` would attach to the operator's shared
// background server, so an unreadable probe must fail the run rather than
// guess "unsupported". The v1 CLI has no shared server: its `run` starts an
// in-process server unless the caller passes `--attach` (opencode v1.19.3,
// cli/cmd/run.ts:129-131), and Crosscheck never passes `--attach`. Accept the
// flagless path only for a help listing with the v1 shape — an `Options:`
// section plus the opt-in `--attach` and the local server's `--port`.
export interface OpenCodeRunHelp {
  supportsAuto: boolean
  supportsStandalone: boolean
  /** An `Options:` section with the v1 `--attach` and `--port` flags. */
  v1Shape: boolean
}

export function parseOpenCodeRunHelp(helpOutput: string): OpenCodeRunHelp {
  const help = stripVTControlCharacters(helpOutput)
  // `(?![\w-])` so a longer flag such as `--auto-approve` does not count.
  const lists = (flag: string): boolean => new RegExp(`(?:^|\\s)--${flag}(?![\\w-])`, 'm').test(help)
  return {
    supportsAuto: lists('auto'),
    supportsStandalone: lists('standalone'),
    v1Shape: /(?:^|\n)[ \t]*Options:[ \t]*(?:\n|$)/.test(help) && /--attach\b/.test(help) && /--port\b/.test(help),
  }
}

export interface OpenCodeCliInfo {
  version?: string
  path?: string
  supportsAuto: boolean
  supportsStandalone: boolean
  policyFormat: OpenCodePolicyFormat
}

// First executable named `opencode` on the PATH the subprocess will see, so the
// reported path is the one a review would actually run.
function resolveOpenCodePath(pathEnv: string | undefined): string | undefined {
  const names = process.platform === 'win32' ? ['opencode.exe', 'opencode.cmd', 'opencode'] : ['opencode']
  for (const dir of (pathEnv ?? '').split(delimiter)) {
    if (!dir) continue
    for (const name of names) {
      const candidate = join(dir, name)
      try {
        if (!statSync(candidate).isFile()) continue
        accessSync(candidate, constants.X_OK)
        return candidate
      } catch { /* not here — keep walking */ }
    }
  }
  return undefined
}

async function readOpenCodeVersion(env: Record<string, string>): Promise<string | undefined> {
  try {
    const { stdout } = await execa('opencode', ['--version'], { timeout: 10_000, extendEnv: false, env })
    return /\d+\.\d+\.\d+\S*/.exec(stdout ?? '')?.[0]
  } catch {
    return undefined // best effort: only used to make an error message specific
  }
}

export async function probeOpenCodeCli(): Promise<OpenCodeCliInfo> {
  const env = buildOpenCodeEnv()
  const [helpAttempt, version] = await Promise.all([
    execa('opencode', ['run', '--help'], {
      timeout: 10_000,
      reject: false,
      extendEnv: false,
      env,
    }).then(
      result => ({ result }),
      (error: unknown) => ({ error }),
    ),
    readOpenCodeVersion(env),
  ])
  if ('error' in helpAttempt) {
    const detail = helpAttempt.error instanceof Error ? helpAttempt.error.message : String(helpAttempt.error)
    throw new Error(`opencode: CLI capability probe failed (${detail}); refusing to run without session isolation`)
  }
  const { stdout, stderr, exitCode } = helpAttempt.result
  const parsed = parseOpenCodeRunHelp(`${stdout ?? ''}\n${stderr ?? ''}`)
  if (!parsed.supportsStandalone && (exitCode !== 0 || !parsed.v1Shape)) {
    throw new Error(`opencode: could not read 'opencode run --help' (exit ${exitCode ?? 'unknown'}); refusing to run without session isolation`)
  }
  return {
    version,
    path: resolveOpenCodePath(env.PATH),
    supportsAuto: parsed.supportsAuto,
    supportsStandalone: parsed.supportsStandalone,
    policyFormat: parsed.supportsStandalone ? 'v2' : 'v1',
  }
}

// Why this CLI cannot be driven, or undefined when it can. `--auto` is required
// for every headless run (see runOpenCodeReview), so a CLI without it is
// unusable rather than degraded.
export function openCodeIncompatibility(info: OpenCodeCliInfo): string | undefined {
  if (info.supportsAuto) return undefined
  const who = `opencode${info.version ? ` ${info.version}` : ''}${info.path ? ` at ${info.path}` : ''}`
  return `${who} does not support 'run --auto' — upgrade it, or a newer install is shadowed on PATH (check: which -a opencode)`
}

// The args every headless `opencode run` shares, from an already-probed CLI.
// Throws the incompatibility message instead of letting the CLI print usage.
export function opencodeRunBaseArgs(info: OpenCodeCliInfo): string[] {
  const incompatibility = openCodeIncompatibility(info)
  if (incompatibility) throw new Error(`opencode: ${incompatibility}`)
  return ['run', '--format', 'json', '--auto', ...(info.supportsStandalone ? ['--standalone'] : [])]
}

/** Probes the installed CLI and returns the shared run args plus the policy format it accepts. */
export async function requireOpenCodeRun(): Promise<{ baseArgs: string[]; policyFormat: OpenCodePolicyFormat }> {
  const info = await probeOpenCodeCli()
  return { baseArgs: opencodeRunBaseArgs(info), policyFormat: info.policyFormat }
}

// What a CLI prints (to stderr) when yargs rejects the arguments: the full
// usage for the command. A real run failure never looks like this.
export function isOpenCodeUsageOutput(stderr: string): boolean {
  const text = stripVTControlCharacters(stderr)
  return /^[ \t]*opencode run \[message\.\.\]/m.test(text)
    || (/^[ \t]*Positionals:/m.test(text) && /^[ \t]*Options:/m.test(text))
}

export const OPENCODE_USAGE_SUMMARY =
  'opencode CLI rejected the arguments (printed usage) — incompatible opencode version; check: which -a opencode'

// Auth failures the fix step should relabel. Matched against stderr only, never
// against usage text: the usage listing mentions "basic auth password", which
// the old `/auth/` test mistook for a login problem on every CLI mismatch.
const OPENCODE_AUTH_FAILURE =
  /not logged in|no (?:providers|credentials)|unauthori[sz]ed|\b401\b|invalid api key|auth(?:entication)? (?:failed|error|required)|run: opencode auth login/i

export function isOpenCodeAuthFailure(stderr: string | undefined, message: string): boolean {
  const text = stderr && stderr.trim() ? stderr : message
  if (isOpenCodeUsageOutput(text)) return false
  return OPENCODE_AUTH_FAILURE.test(stripVTControlCharacters(text))
}

// opencode 1.x (1.2 and 1.19) has no machine-readable `auth list`: `--format json`,
// `--format=json`, and `--json` all exit 1 and print help. The previous probe
// passed `--format json`, so even a logged-in install failed readiness with the
// help text as its "error". Parse the plain listing instead (2.x does accept
// `--format json`; text parsing is kept so one path covers both majors). Strip ANSI escapes first — opencode styles the table even
// when stdout is not a TTY.
export function parseOpenCodeAuthList(raw: string): number | null {
  const clean = stripVTControlCharacters(raw)
  // Anchor to the summary row. Provider labels and other table text can contain
  // a `<n> credential(s)` sequence earlier in the listing; an unanchored first
  // match would report that number as the total.
  const match = clean.match(/└\s+(\d+)\s+credentials?\b/i)
  if (match) {
    const count = Number(match[1])
    return Number.isFinite(count) ? count : null
  }
  // opencode 2.x prints no frame or summary row: "No authenticated integrations"
  // when empty, otherwise one line per stored credential ending in its status.
  // Any other listing stays unreadable (null).
  if (/^\s*No authenticated integrations\s*$/im.test(clean)) return 0
  const storedRows = clean.split('\n').filter((line) => /^\S.*\s+stored\s*$/i.test(line))
  return storedRows.length > 0 ? storedRows.length : null
}

export async function checkOpenCodeAuth(): Promise<{ ok: boolean; detail: string }> {
  try {
    const { stdout } = await execa('opencode', ['auth', 'list'], { timeout: 10_000 })
    const providerCount = parseOpenCodeAuthList(stdout ?? '')
    // Fail closed on unrecognised output: an unreadable listing must not claim
    // authentication, and it must not silently look like a logged-out install.
    if (providerCount === null) {
      return { ok: false, detail: 'could not read opencode auth list output — run: opencode auth list' }
    }
    if (providerCount === 0) {
      return { ok: false, detail: 'no providers configured — run: opencode auth login' }
    }
    // A readiness check, not only an auth check: a logged-in CLI that cannot run
    // headless (no `--auto`) must not be assigned reviews, and the reason should
    // show up in `status`/`init`.
    try {
      const incompatibility = openCodeIncompatibility(await probeOpenCodeCli())
      if (incompatibility) return { ok: false, detail: incompatibility }
    } catch (probeErr: unknown) {
      return { ok: false, detail: probeErr instanceof Error ? probeErr.message : String(probeErr) }
    }
    return { ok: true, detail: `${providerCount} provider(s) configured` }
  } catch (err: unknown) {
    const error = err as { stderr?: string; message?: string }
    return { ok: false, detail: error.stderr ?? error.message ?? 'not found' }
  }
}
