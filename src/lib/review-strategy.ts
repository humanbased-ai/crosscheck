// Resolves the per-PR review strategy: which class a PR falls into, which tier
// and effort that class earns, and which steps run. Reads the versioned policy
// in config/review-strategy.json so the routing decision and the explanation
// posted on the PR come from one place and cannot drift apart.
//
// Two rules constrain what classification may conclude (see
// docs/dynamic-thoroughness.md §6.8):
//   - it may set a FLOOR, or promote on CONSEQUENCE (a security path is
//     reviewed thoroughly because a miss there is expensive);
//   - it may NOT predict that a PR will be hard. Static features do not support
//     that inference — difficulty is discovered by reviewing, so escalation is
//     driven by measured non-convergence instead (see escalate()).
import { createRequire } from 'module'
import { z } from 'zod'
import type { QualityConfig } from '../config/schema.js'

const require = createRequire(import.meta.url)

export type Tier = QualityConfig['tier']
export type Domain = 'frontend' | 'backend'

/** Ordered effort ladder. Index-based so escalation is a step, not a lookup. */
const EFFORT_LADDER = ['none', 'low', 'medium', 'high', 'xhigh', 'max'] as const

const MatchSchema = z.object({
  all_files_match: z.array(z.string()).optional(),
  any_path_matches: z.array(z.string()).optional(),
  or_labels: z.array(z.string()).optional(),
  or_hotfix_to_default_branch: z.boolean().optional(),
  additions_max: z.number().optional(),
  deletions_min: z.number().optional(),
  doc_fraction_min: z.number().optional(),
  config_fraction_min: z.number().optional(),
  source_files_max: z.number().optional(),
  files_max: z.number().optional(),
  src_churn_max: z.number().optional(),
})

const PRClassSchema = z.object({
  id: z.string(),
  label: z.string(),
  match: MatchSchema,
  tier: z.enum(['fast', 'balanced', 'thorough']).nullable(),
  // Not z.string(): a typo ("higgh") would validate, then read as -1 in
  // clampEffort and silently drop the whole class to the model's lowest level.
  effort: z.enum(EFFORT_LADDER).nullable(),
  steps: z.array(z.string()),
  focus: z.string().optional(),
  reason: z.string(),
})

const StrategySchema = z.object({
  version: z.string(),
  updated: z.string(),
  models: z.record(z.string(), z.object({
    vendor: z.string(),
    effort_levels: z.array(z.string()),
  }).passthrough()),
  banned_models: z.array(z.object({ model: z.string(), reason: z.string() })).default([]),
  vendors: z.record(z.string(), z.object({
    tiers: z.record(z.string(), z.string()),
  }).passthrough()),
  domains: z.record(z.string(), z.unknown()),
  // .min(1): resolveReviewStrategy falls back to the last entry, which is
  // undefined — and throws on `cls.id` — for an empty list.
  pr_classes: z.array(PRClassSchema).min(1),
  ladder: z.object({
    max_blocking_findings: z.number(),
    max_rounds: z.number(),
    max_wall_clock_min: z.number(),
    effort_fallback: z.string(),
  }).passthrough(),
}).passthrough()

const raw: unknown = require('../config/review-strategy.json')
const STRATEGY = StrategySchema.parse(raw)

const TIER_LADDER: Tier[] = ['fast', 'balanced', 'thorough']

/** Position on EFFORT_LADDER; -1 for null or an unrecognised level. */
function effortIndex(effort: string | null): number {
  return effort === null ? -1 : EFFORT_LADDER.indexOf(effort as (typeof EFFORT_LADDER)[number])
}

const FRONTEND_EXT = /\.(tsx|jsx|vue|svelte|css|scss|less|html)$/i
const BACKEND_EXT = /\.(py|go|rs|java|rb|php|sql|ts)$/i
const DOC_EXT = /\.(md|mdx|rst|adoc)$/i
const CONFIG_EXT = /(\.(json|ya?ml|toml|ini|lock|txt|csv|svg|png|jpe?g)$|^\.github\/)/i
// Anchored on path segments and extensions. Unanchored, `spec` matched
// src/lib/pr-spec.ts and `test` matched any latest.ts, routing ordinary source
// PRs to test_only with a test-focused prompt.
const TEST_PATH = /((^|\/)(__tests__|tests?|e2e|fixtures?)(\/|$)|\.(test|spec)\.)/i
const GENERATED = /((^|\/)(dist|build|node_modules)\/|\.(lock|sum)$|package-lock|pnpm-lock|yarn\.lock|\.(pb|_pb2)\.[a-z]+$|(^|\/)generated\/)/i

export interface PRContext {
  files: string[]
  additions: number
  deletions: number
  labels?: string[]
  title?: string
  baseRef?: string
  defaultBranch?: string
}

export interface ResolvedStrategy {
  /** Strategy file version, stamped into every comment so a past review stays explicable. */
  version: string
  classId: string
  classLabel: string
  /** Human-readable rationale, quoted verbatim in the PR comment. */
  reason: string
  /** null = skip this PR entirely. */
  tier: Tier | null
  effort: string | null
  steps: string[]
  focus?: string
  domain: Domain
}

function srcChurnFraction(files: string[]): { doc: number; config: number; source: number } {
  if (files.length === 0) return { doc: 0, config: 0, source: 0 }
  const doc = files.filter(f => DOC_EXT.test(f)).length / files.length
  const config = files.filter(f => CONFIG_EXT.test(f)).length / files.length
  const source = files.filter(f => !DOC_EXT.test(f) && !CONFIG_EXT.test(f) && !GENERATED.test(f) && !TEST_PATH.test(f)).length
  return { doc, config, source }
}

/**
 * Frontend vs backend, by file-extension majority. `mixed` and `unknown` both
 * fall back to backend — the conservative default, because the backend
 * preference list is `measured` while the frontend list is still a hypothesis.
 */
export function detectDomain(files: string[]): Domain {
  const fe = files.filter(f => FRONTEND_EXT.test(f)).length
  const be = files.filter(f => BACKEND_EXT.test(f)).length
  return fe > be ? 'frontend' : 'backend'
}

function matches(cls: z.infer<typeof PRClassSchema>, pr: PRContext): boolean {
  const m = cls.match
  const { files, additions, deletions } = pr

  // An empty match object is the fallthrough class.
  if (Object.keys(m).length === 0) return true
  // Never classify an empty file list as anything but the fallthrough.
  if (files.length === 0) return false

  if (m.all_files_match) {
    const res = m.all_files_match.map(p => new RegExp(p, 'i'))
    if (!files.every(f => res.some(r => r.test(f)))) return false
  }

  // `any_path_matches` is an OR-group with labels and the hotfix rule: any one
  // of the three promotes. Only evaluated when the class declares them.
  if (m.any_path_matches || m.or_labels || m.or_hotfix_to_default_branch) {
    const pathHit = m.any_path_matches
      ? files.some(f => m.any_path_matches!.some(p => new RegExp(p, 'i').test(f)))
      : false
    const labelHit = m.or_labels ? (pr.labels ?? []).some(l => m.or_labels!.includes(l)) : false
    const hotfixHit = m.or_hotfix_to_default_branch === true
      && /^hotfix/i.test(pr.title ?? '')
      && pr.baseRef !== undefined
      && pr.baseRef === pr.defaultBranch
    if (!pathHit && !labelHit && !hotfixHit) return false
  }

  if (m.additions_max !== undefined && additions > m.additions_max) return false
  // A floor on deletions, not merely "some deletions": a +2/-2 typo fix has
  // near-zero additions too, and is a modification rather than a removal.
  if (m.deletions_min !== undefined && deletions < m.deletions_min) return false

  const frac = srcChurnFraction(files)
  if (m.doc_fraction_min !== undefined && frac.doc < m.doc_fraction_min) return false
  if (m.config_fraction_min !== undefined && frac.config < m.config_fraction_min) return false
  if (m.source_files_max !== undefined && frac.source > m.source_files_max) return false
  if (m.files_max !== undefined && files.length > m.files_max) return false
  if (m.src_churn_max !== undefined) {
    const srcFiles = files.filter(f => !GENERATED.test(f) && !CONFIG_EXT.test(f))
    // Churn is only attributable per-file with a full diff; approximate with the
    // PR total when the change is entirely source, which is the case that matters.
    // Fails CLOSED when churn cannot be attributed: falling back to 0 passed
    // every cap, so one stray config file routed a 5,000-line change to the
    // core runner into `trivial` — fast tier, no recheck.
    const churn = srcFiles.length === files.length ? additions + deletions : Infinity
    if (churn > m.src_churn_max) return false
  }

  return true
}

/** Classifies a PR against the strategy's ordered class list. First match wins. */
export function resolveReviewStrategy(pr: PRContext): ResolvedStrategy {
  const cls = STRATEGY.pr_classes.find(c => matches(c, pr))
    ?? STRATEGY.pr_classes[STRATEGY.pr_classes.length - 1]

  return {
    version: STRATEGY.version,
    classId: cls.id,
    classLabel: cls.label,
    reason: cls.reason,
    tier: cls.tier,
    effort: cls.effort,
    steps: cls.steps,
    ...(cls.focus !== undefined && { focus: cls.focus }),
    domain: detectDomain(pr.files),
  }
}

/** Effort levels a model accepts. Empty array = the model has no effort control. */
export function effortLevelsFor(model: string): string[] {
  return STRATEGY.models[model]?.effort_levels ?? []
}

export function isModelBanned(model: string): boolean {
  return STRATEGY.banned_models.some(b => b.model === model)
}

export function strategyModelFor(vendor: string, tier: Tier): string | null {
  return STRATEGY.vendors[vendor]?.tiers[tier] ?? null
}

export function strategyVersion(): string {
  return STRATEGY.version
}

export function ladderLimits(): { maxRounds: number; maxBlocking: number; maxWallClockMin: number } {
  return {
    maxRounds: STRATEGY.ladder.max_rounds,
    maxBlocking: STRATEGY.ladder.max_blocking_findings,
    maxWallClockMin: STRATEGY.ladder.max_wall_clock_min,
  }
}

/**
 * True when the strategy's model map has an entry for this ID — i.e. its effort
 * ladder is known at all. Distinct from an entry whose ladder is empty: haiku's
 * `[]` means "no effort control", while a pinned ID or codex under subscription
 * auth (where the CLI picks the model) means "capability unknown".
 */
function modelIsKnown(model: string): boolean {
  return Object.prototype.hasOwnProperty.call(STRATEGY.models, model)
}

/** One vendor that may review this round. */
export interface EscalationLane {
  /** The model that would run for this vendor at the class tier. */
  model: string
  /** The vendor CLI's effort flags. Omitted = judge on model capability alone. */
  accepted?: readonly string[]
}

/**
 * Escalation for round N. Raises effort where the vendor that will actually run
 * can deliver a higher one; where it cannot, degrades to a tier promotion
 * instead — `ladder.effort_fallback`.
 *
 * `lanes` are the vendors in play, not claude alone. Collapsing them produced
 * two separate no-ops:
 *   - judging by the claude tier model on a codex-only install promoted a tier
 *     every round (haiku exposes no effort ladder) while codex — which accepts
 *     none…max — sat at the effort it started on;
 *   - judging by MODEL capability alone made round 3 identical to round 2 on
 *     claude: claude-opus-5 reasons at `xhigh`, the claude CLI has no flag for
 *     it, so the wire effort clamped straight back down to round 2's `high`.
 *
 * So each lane is judged post-clamp, at the wire, and effort rises only when
 * EVERY lane rises there. Otherwise the tier is promoted, which every lane can
 * express.
 *
 * The model never weakens across rounds. Scope narrows instead: a recheck
 * examines the delta plus the open findings, not the whole PR again.
 */
export function escalate(
  base: { tier: Tier; effort: string | null },
  round: number,
  lanes: string | readonly EscalationLane[],
): { tier: Tier; effort: string | null } {
  if (round <= 1) return base

  const list: readonly EscalationLane[] = typeof lanes === 'string' ? [{ model: lanes }] : lanes
  // Both clamps, in order: what the MODEL can reason at, then what the CLI has a
  // flag for. Only the second reaches the wire.
  const wire = (lane: EscalationLane, effort: string | null): string | null => {
    const atModel = modelIsKnown(lane.model) ? clampToLevels(effort, effortLevelsFor(lane.model)) : effort
    return lane.accepted ? clampToLevels(atModel, lane.accepted) : atModel
  }

  // Compare the target against what the round before already asked for. An exact
  // `levels.includes(target)` test made round 3 miss on any model whose ladder
  // tops out below xhigh (deepseek: none/high/max) and return base.effort —
  // weaker than round 2.
  const target = round >= 3 ? 'xhigh' : 'high'
  const previousTarget = round >= 3 ? 'high' : base.effort
  const clamped = list.map(lane => wire(lane, target))
  const rises = list.length > 0 && list.every((lane, i) => {
    const now = clamped[i]
    return now !== null && effortIndex(now) > effortIndex(wire(lane, previousTarget) ?? base.effort)
  })
  // The strongest level any lane accepts; each vendor config is clamped back down
  // to its own vocabulary downstream (strategyVendor), so a lane that cannot
  // reach it is not sent it.
  const best = clamped.reduce<string | null>((a, b) => (effortIndex(b) > effortIndex(a) ? b : a), null)

  if (rises) return { tier: base.tier, effort: best }

  // Effort cannot rise on at least one lane — promote a tier instead (the
  // strategy's ladder.effort_fallback), capped at thorough.
  const idx = TIER_LADDER.indexOf(base.tier)
  const promoted = TIER_LADDER[Math.min(idx + 1, TIER_LADDER.length - 1)]
  return { tier: promoted, effort: best ?? base.effort }
}

/** Clamps a requested effort to what the model actually accepts. */
export function clampEffort(model: string, effort: string | null): string | null {
  return clampToLevels(effort, effortLevelsFor(model))
}

/**
 * Clamps a requested effort to an accepted vocabulary.
 *
 * Applied twice on the way to a CLI, against two different sets: what the MODEL
 * can reason at (`models[].effort_levels` here) and what the VENDOR CLI has a
 * flag for (CLAUDE_EFFORT_LEVELS / CODEX_EFFORT_LEVELS in the config schema).
 * They are not the same — claude-opus-5 reasons at `xhigh` and the claude CLI
 * cannot ask for it — and only the second reaches the wire.
 */
export function clampToLevels(effort: string | null, levels: readonly string[]): string | null {
  if (effort === null || levels.length === 0) return null
  if (levels.includes(effort)) return effort
  // Snap down to the nearest supported level rather than failing the call. When
  // the vocabulary has nothing at or below the request, snap UP to its lowest
  // level instead — sending an effort that is rejected fails the call outright.
  const want = EFFORT_LADDER.indexOf(effort as (typeof EFFORT_LADDER)[number])
  for (let i = want; i >= 0; i--) {
    if (levels.includes(EFFORT_LADDER[i])) return EFFORT_LADDER[i]
  }
  return levels[0] ?? null
}
