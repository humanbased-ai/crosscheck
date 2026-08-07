import { z } from 'zod'

export const VendorConfigSchema = z.object({
  enabled: z.boolean().default(true),
  model: z.string().nullable().default(null),
  auth: z.enum(['subscription', 'api-key']).default('subscription'),
  effort: z.enum(['low', 'medium', 'high', 'max']).default('medium'),
  // Max wall-clock seconds for a single CLI invocation before it is killed.
  // null = use the reviewer's built-in default, which is tier-based for both
  // claude and codex: 300s (fast) / 600s (balanced) / 1200s (thorough).
  // Raise this for large PRs that legitimately need longer to finish.
  timeout_sec: z.number().int().positive().nullable().default(null),
})

// Codex-specific vendor config. The `quality` field is retained for
// backwards compat but is no longer passed as --quality (removed from codex CLI).
export const CodexVendorConfigSchema = VendorConfigSchema.extend({
  quality: z.enum(['low', 'medium', 'high']).default('medium'),
  // Codex exposes two tiers above the shared vocabulary: xhigh (Extra High) and
  // ultra. Ultra is only available on terra/sol; pre-5.6 models stop at xhigh —
  // the CLI rejects unsupported combinations at call time.
  effort: z.enum(['low', 'medium', 'high', 'xhigh', 'max', 'ultra']).default('medium'),
  // Optional per-tier model overrides, honored under both auth modes. When unset:
  // api-key auth falls back to the built-in tier mapping, subscription auth lets
  // the Codex CLI pick its default model.
  // Example: { fast: 'gpt-5.6-luna', balanced: 'gpt-5.6-terra', thorough: 'gpt-5.6-sol' }
  model_tiers: z.object({
    fast: z.string().optional(),
    balanced: z.string().optional(),
    thorough: z.string().optional(),
  }).optional(),
})

export const QualityConfigSchema = z.object({
  // The tier when `mode: fixed`, and the fallback under `mode: smart` whenever a
  // PR's file list cannot be read (one-shot commands, API failures).
  tier: z.enum(['fast', 'balanced', 'thorough']).default('balanced'),
  // smart (default): dynamically adjust model + effort based on task type. The PR
  //   is classified from its changed-file list against the versioned policy in
  //   config/review-strategy.json — a lockfile-only PR is skipped, a docs PR gets
  //   review with no fix loop, a PR touching auth or a migration is promoted to
  //   `thorough`. Escalation is evidence-driven, never predicted: round 2 raises
  //   effort, round 3 switches vendor, then it hands off to a human.
  // fixed: every agent call uses `tier` above, regardless of what changed.
  mode: z.enum(['fixed', 'smart']).default('smart'),
  focus: z.array(z.string()).default([]),
  custom_prompt: z.string().optional(),
})

export const SkillsConfigSchema = z.object({
  enabled: z.array(z.string()).default([]),
})

export const BudgetConfigSchema = z.object({
  codex_monthly_usd: z.number().nullable().default(null),
  per_review_usd: z.number().default(2.0),
})

export const RepoWorkflowStepSchema = z.enum(['review', 'fix', 'recheck'])
export type RepoWorkflowStep = z.infer<typeof RepoWorkflowStepSchema>

// Canonical execution order of the three workflow steps. A per-repo override may
// enable any subset, subject to three rules:
//   1. it must include `review` — the step every later step builds on,
//   2. steps must appear in this order (review, then fix, then recheck),
//   3. no step may repeat.
// That yields exactly: review, review+fix, review+recheck, review+fix+recheck.
export const REPO_WORKFLOW_STEP_ORDER: readonly RepoWorkflowStep[] = ['review', 'fix', 'recheck']

export const RepoWorkflowStepsSchema = z.array(RepoWorkflowStepSchema).min(1).superRefine((steps, ctx) => {
  const fail = (message: string): void => {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message })
  }
  if (new Set(steps).size !== steps.length) {
    fail('repo workflow steps must not repeat a step')
    return
  }
  if (!steps.includes('review')) {
    fail('repo workflow steps must include review')
    return
  }
  const canonical = REPO_WORKFLOW_STEP_ORDER.filter(step => steps.includes(step))
  if (steps.join(',') !== canonical.join(',')) {
    fail('repo workflow steps must be ordered review, then fix, then recheck')
  }
})

export const RepoConfigSchema = z.object({
  owner: z.string(),
  name: z.string(),
  // Per-repo workflow depth is NOT stored here. It lives in a standalone file at
  // ~/.crosscheck/workflows/<owner>__<repo>.yml (written by `crosscheck alter`),
  // so pipeline shape stays out of the infra config and is live-reloaded per PR.
})

export const RoutingConfigSchema = z.object({
  codex_reviews_patterns: z.array(z.string()).default([
    'Generated with \\[Claude Code\\]',  // PR body attribution footer
    'Co-Authored-By: Claude',            // commit trailer added by Claude Code
  ]),
  claude_reviews_patterns: z.array(z.string()).default([
    'Generated with \\[OpenAI Codex\\]', // PR body attribution footer
    'Co-Authored-By: codex',             // commit trailer added by Codex
  ]),
  // Branch prefix routing — checked when body and commit patterns don't match.
  // Agents should branch with these prefixes so crosscheck can identify origin
  // even without attribution text in the PR body.
  claude_branch_prefixes: z.array(z.string()).default(['claude/']),
  codex_branch_prefixes: z.array(z.string()).default(['codex/']),
  // Only review PRs opened by these GitHub logins.
  // Empty list = no restriction (reviews all AI-authored PRs in cross-vendor mode,
  // or all PRs in single-vendor mode). Recommended: set to the logins of your AI agents.
  allowed_authors: z.array(z.string()).default([]),
  // Last-resort fallback when body, commit, and branch checks all fail.
  // Maps GitHub login → vendor origin.
  // e.g. { beingzy: 'claude' } means PRs from beingzy are treated as Claude-authored
  // and will be reviewed by Codex, even without any other attribution signal.
  //
  // NOTE: in cross-vendor mode with BOTH vendors enabled, author_routes is bypassed
  // and detection falls through to `fallback_reviewer` instead. A static author→vendor
  // map would silently mis-route PRs when the author switches between agents — set
  // `fallback_reviewer` to handle this case explicitly.
  author_routes: z.record(z.enum(['claude', 'codex'])).default({}),
  // When origin detection cannot determine a vendor (origin: human), use this reviewer
  // instead of skipping the PR.
  // 'auto' = pick whichever vendor is currently enabled (codex first, then claude).
  // null   = skip the PR (legacy behaviour, cross-vendor mode only).
  fallback_reviewer: z.enum(['auto', 'codex', 'claude']).nullable().default('auto'),
})

export const ServerConfigSchema = z.object({
  port: z.number().default(7891),
  webhook_path: z.string().default('/webhook'),
})

// Extended logging captures richer PR context (title, body, file paths, review text,
// author) to enable data-driven config tuning and best-practice recommendations.
//
// CONSENT REQUIRED — this field exists in the schema but must NOT be exposed via
// CLI flags, onboard prompts, or documentation until a user-facing consent agreement
// is drafted, reviewed, and accepted interactively. Setting enabled: true manually
// in config.yml is possible for internal testing only.
//
// Fields logged in extended mode (NOT logged otherwise):
//   pr_title, pr_body, head_ref, file_paths[], review_text, author_login
//
// All extended entries carry "_extended": true so they can be filtered or scrubbed
// independently of standard log entries.
const ExtendedLoggingSchema = z.object({
  enabled: z.boolean().default(false),
})

export const LogsConfigSchema = z.object({
  enabled: z.boolean().default(true),
  retention_days: z.number().int().min(1).max(365).default(30),
  // Not exposed in CLI or onboard — see consent note above.
  extended: ExtendedLoggingSchema.default({}),
})

export const TunnelConfigSchema = z.object({
  // localhost.run: zero-config SSH tunnel, reconnects automatically, no install required.
  // smee: webhook relay via smee.io — events queued while offline, stable channel URL.
  //   Requires: npm install -g smee-client  and  tunnel.smee_channel set below.
  backend: z.enum(['localhost.run', 'smee']).default('localhost.run'),
  smee_channel: z.string().default(''),
})

export const ImpactConfigSchema = z.object({
  assumed_human_review_minutes: z.number().int().min(1).default(60),
  hourly_rate_usd: z.number().min(0).default(150),
  defect_cost_usd: z.number().min(0).default(150),
})

export const IssueEnrichmentConfigSchema = z.object({
  // Fetch the linked tracker issue and inject its goal (title, description,
  // labels, estimate, project) into the reviewer prompt, so the review judges
  // the change against the stated goal rather than inferring intent from the
  // diff. Opt-in — requires LINEAR_API_KEY in the environment.
  enabled: z.boolean().default(false),
  provider: z.enum(['linear']).default('linear'),
  // Restrict ticket-ref extraction to these team keys (e.g. ['IN']). Empty =
  // match any <LETTERS>-<n> token; unknown refs simply resolve to nothing and
  // are skipped, so scoping here mainly avoids wasted lookups on tokens like
  // UTF-8 that share the ticket shape.
  team_keys: z.array(z.string()).default([]),
  // Hard cap (chars) on the injected issue description to bound prompt size.
  // 0 disables the cap.
  max_description_chars: z.number().int().min(0).default(4000),
})

export const BacktraceConfigSchema = z.object({
  // Scan for open PRs without a [crosscheck] comment on startup.
  // Off by default — pass --backtrace (watch/serve) or set enabled: true in config to opt in.
  enabled: z.boolean().default(false),
})

export const WatchIdleIssueSchema = z.object({
  // When watch has been idle (no PR activity) for timeout_min minutes, analyze logs
  // and offer to create a GitHub improvement ticket. Opt-in: set enabled: true to enable.
  enabled: z.boolean().default(false),
  timeout_min: z.number().int().min(5).default(30),
})

export const WatchConfigSchema = z.object({
  idle_issue: WatchIdleIssueSchema.default({}),
})

export const PostReviewDeliverySchema = z.object({
  // pull_request → opens a fix PR targeting the original branch (human approves before merge)
  // commit       → pushes fixes directly onto the original PR branch
  // comment      → posts suggested changes as review comments only (no code push)
  mode: z.enum(['pull_request', 'commit', 'comment']).default('pull_request'),
  pr_title: z.string().default('fix: address CR issues in #{original_pr_title}'),
  label: z.string().default('cr-autofix'),
})

// Trigger conditions, vendor selection, and step sequencing are all defined in
// workflow.yml (type, when, reviewer). This schema retains only the delivery
// mechanism — how fixes land on the PR — which is operational config, not pipeline logic.
export const PostReviewFixSchema = z.object({
  delivery: PostReviewDeliverySchema.default({}),
  // Migration compat: honored with a deprecation warning but no longer the control plane.
  // Remove these from config and use workflow.yml to control when fix steps run.
  enabled: z.boolean().optional(),
  trigger: z.enum(['on_issues', 'always', 'never']).optional(),
})

export const PostReviewConfigSchema = z.object({
  auto_fix: PostReviewFixSchema.default({}),
})

export const DisplayThemeSchema = z.object({
  bar_fill: z.string().default('blue'),
  bar_empty: z.string().default('dim'),
  cr_approve: z.string().default('green'),
  cr_needs_work: z.string().default('yellow'),
  cr_block: z.string().default('red'),
  fix_fill: z.string().default('cyan'),
})

export const DisplayConfigSchema = z.object({
  theme: DisplayThemeSchema.default({}),
})

export const BrandConfigSchema = z.object({
  service_name: z.string().default('crosscheck'),
  comment_header: z.string().default(''),
  comment_footer: z.string().default(''),
  reviewer_attribution: z.string().default(''),
})

// Tiered Linear identity — see src/linear/identity.ts for the tier semantics.
// Disabled by default, so existing configs are unaffected.
export const LinearAuthConfigSchema = z.object({
  // api_key            — T0: personal/workspace key + signature line.
  // client_credentials — T1: OAuth app token minted per run + createAsUser (botActor).
  mode: z.enum(['api_key', 'client_credentials']).default('api_key'),
  // Env var NAMES, never the secrets themselves. Values are read in config/loader.ts.
  api_key_env: z.string().default('LINEAR_API_KEY'),
  client_id_env: z.string().default('LINEAR_CLIENT_ID'),
  client_secret_env: z.string().default('LINEAR_CLIENT_SECRET'),
  // Linear documents the token request as taking a COMMA-separated list. Space
  // separated input is normalised on the wire, so both forms work.
  // NOTE: `read,write` does NOT cover initiatives — initiative:read /
  // initiative:write are separate scopes that must be requested explicitly.
  scopes: z.string().default('read,write'),
})

export const LinearIdentityConfigSchema = z.object({
  // createAsUser base name in T1; the {actor} placeholder in the signature template.
  actor: z.string().default('crosscheck'),
  // Placeholders: {actor} {product} {model} {reviewer} {icon}. Ones with no value
  // resolve to empty and the leftover separators are tidied away.
  //
  // {product} is available but not in the default: actor defaults to the product
  // name, so `{actor} · {product}` renders as `crosscheck · crosscheck`. The model
  // carries more information in the same space.
  signature: z.string().default('🤖 {actor} · {model}'),
  // Optional logo shown inline in the signature via {icon}. Note the better route
  // is the OAuth app avatar (T1), which Linear renders natively beside the comment —
  // see docs/linear-identity.md. Inline images may render block-level.
  icon_url: z.string().default(''),
  // Suffix the actor with the workflow step that produced the write, so a review,
  // a recheck and a fix are distinguishable rather than all reading as one bot:
  //   crosscheck/review, crosscheck/fix, crosscheck/recheck
  // Set false for a single flat actor name.
  per_step_actor: z.boolean().default(true),
})

export const LinearVerdictFilterSchema = z.enum(['APPROVE', 'NEEDS_WORK', 'BLOCK', 'UNKNOWN'])
export type LinearVerdictFilter = z.infer<typeof LinearVerdictFilterSchema>

export const LinearConfigSchema = z.object({
  enabled: z.boolean().default(false),
  auth: LinearAuthConfigSchema.default({}),
  identity: LinearIdentityConfigSchema.default({}),
  // Which verdicts get mirrored to the linked Linear issue. Defaults to the ones
  // that need someone to act: a clean PR posting an APPROVE onto its issue is noise
  // on every green review. Add 'APPROVE' (and 'UNKNOWN') to hear about those too.
  comment_on: z.array(LinearVerdictFilterSchema).default(['NEEDS_WORK', 'BLOCK']),
  // Team key prefixes (e.g. ['IN']) that may be matched as bare identifiers in a
  // branch/title/body. Leave empty to only follow explicit linear.app issue URLs —
  // see src/linear/ref.ts for why bare matching is opt-in.
  team_keys: z.array(z.string()).default([]),
})

export const ConfigSchema = z.object({
  // Absent = not yet configured; watch/serve will prompt on first run.
  deployment: z.enum(['personal', 'team']).optional(),
  mode: z.enum(['single-vendor', 'cross-vendor']).default('cross-vendor'),
  // How crosscheck clones PR repos for review.
  // ssh   — git@github.com:owner/repo.git (uses local SSH keys)
  // https — https://github.com/owner/repo.git (uses GitHub token via gh credential helper)
  // Pick https if you have multi-account SSH setup or your default SSH key cannot
  // access target repos. Independent of `gh config get git_protocol`.
  clone_protocol: z.enum(['ssh', 'https']).default('ssh'),
  vendors: z.object({
    codex: CodexVendorConfigSchema.default({}),
    claude: VendorConfigSchema.default({}),
  }).default({}),
  quality: QualityConfigSchema.default({}),
  skills: SkillsConfigSchema.default({}),
  budget: BudgetConfigSchema.default({}),
  orgs: z.array(z.string()).default([]),
  users: z.array(z.string()).default([]),
  repos: z.array(RepoConfigSchema).default([]),
  routing: RoutingConfigSchema.default({}),
  server: ServerConfigSchema.default({}),
  tunnel: TunnelConfigSchema.default({}),
  logs: LogsConfigSchema.default({}),
  impact: ImpactConfigSchema.default({}),
  backtrace: BacktraceConfigSchema.default({}),
  issue_enrichment: IssueEnrichmentConfigSchema.default({}),
  watch: WatchConfigSchema.default({}),
  post_review: PostReviewConfigSchema.default({}),
  display: DisplayConfigSchema.default({}),
  brand: BrandConfigSchema.default({}),
  linear: LinearConfigSchema.default({}),
})

export type Config = z.infer<typeof ConfigSchema>
export type BrandConfig = z.infer<typeof BrandConfigSchema>
export type VendorConfig = z.infer<typeof VendorConfigSchema>
export type CodexVendorConfig = z.infer<typeof CodexVendorConfigSchema>
export type QualityConfig = z.infer<typeof QualityConfigSchema>
export type SkillsConfig = z.infer<typeof SkillsConfigSchema>
export type LogsConfig = z.infer<typeof LogsConfigSchema>
export type TunnelConfig = z.infer<typeof TunnelConfigSchema>
export type ImpactConfig = z.infer<typeof ImpactConfigSchema>
export type PostReviewConfig = z.infer<typeof PostReviewConfigSchema>
export type PostReviewFixConfig = z.infer<typeof PostReviewFixSchema>
export type DisplayConfig = z.infer<typeof DisplayConfigSchema>
export type DisplayTheme = z.infer<typeof DisplayThemeSchema>
export type BacktraceConfig = z.infer<typeof BacktraceConfigSchema>
export type IssueEnrichmentConfig = z.infer<typeof IssueEnrichmentConfigSchema>
export type WatchConfig = z.infer<typeof WatchConfigSchema>
export type LinearConfig = z.infer<typeof LinearConfigSchema>
export type LinearAuthConfig = z.infer<typeof LinearAuthConfigSchema>
