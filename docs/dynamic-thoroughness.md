# Dynamic thoroughness

**Strategy version 1.0.0 · updated 2026-08-07 · re-verify every 60 days.**

This document is the analysis behind [`src/config/review-strategy.json`](../src/config/review-strategy.json).
The JSON is the policy crosscheck executes; this file is why the policy says what it
says. They are versioned together: a change to one without the other is drift, and
`npm run verify:strategy` is the check that makes that drift loud.

---

## 1. The problem

One PR is not like another. A lockfile bump and a rewrite of the session handler
are both "a PR", and crosscheck used to review them identically — one configured
`quality.tier`, one model, one effort level, the same review→fix→recheck loop.
That is wrong in both directions at once: it overpays on the lockfile and
under-reviews the session handler.

The failure that prompted this was quieter than either. `review-model-tiers.json`
pinned `claude-opus-4-8` for the `thorough` tier and kept pinning it after
`claude-opus-5` shipped at identical $5/$25 pricing with a higher coding score.
Nothing broke. Nothing warned. Every `thorough` review just got worse than it had
to be, for months. A model pin is a perishable asset, and nothing in the repo
treated it as one.

So the policy has two jobs: choose per PR, and tell a human when the inputs it
chose from have moved.

---

## 2. Sources, and how to re-verify

`sources[]` in the JSON lists the pages the numbers came from, each with the
strings that must still appear on it. `scripts/verify-review-strategy.mjs`
fetches them and compares.

| Source | What it fixes |
|---|---|
| [Anthropic model catalog](https://platform.claude.com/docs/en/about-claude/models/overview) | Claude model IDs and availability |
| [Anthropic effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort) | The effort ladder, including `xhigh` |
| [OpenAI model catalog](https://developers.openai.com/api/docs/models) | Codex model IDs |

Benchmarks are recorded in `benchmarks` with their own `as_of` dates and caveats,
because they age faster than prices:

- **SWE-bench Verified** — resolving real GitHub issues in Python repos. A
  backend/general proxy only. Comparable within one leaderboard run; cross-run
  positions are indicative.
- **Frontend Code Arena** — blind pairwise human preference on generated frontend
  output. Measures *generation*, not defect detection. Claude Opus 5 is absent
  from the retrieved leaderboard: a missing measurement, not a low score.

Re-verification is not automatic and is not meant to be. Model choice is a
judgement call backed by benchmarks that need reading. The weekly
`Review Strategy` workflow fetches the sources and opens an issue when a check
string disappears; a human then re-reads and edits. The job's job is to say *the
inputs moved*, never to move the policy itself.

Network failures are deliberately not drift. A fetch that never landed says
nothing about the policy, so the verifier treats unreachable sources as warnings
on `pull_request` and as errors only on `schedule`, where someone is looking.

---

## 3. The model catalog

Prices are USD per million tokens.

| Model | Vendor | In | Out | SWE-bench V | Frontend Elo | Effort levels |
|---|---|---:|---:|---:|---:|---|
| `claude-opus-5` | claude | 5 | 25 | 0.960 | — | low…max |
| `claude-sonnet-5` | claude | 3 | 15 | 0.852 | — | low…max |
| `claude-haiku-4-5-20251001` | claude | 1 | 5 | 0.733 | — | *(none)* |
| `gpt-5.6-sol` | codex | 5 | 30 | — | 1618 | none…max |
| `gpt-5.6-terra` | codex | 2 | 12 | — | — | none…max |
| `gpt-5.6-luna` | codex | 0.2 | 1.2 | — | — | none…max |
| `kimi-k3` | opencode *(planned)* | 3 | 15 | — | 1679 | *(none)* |
| `glm-5.2` | opencode *(planned)* | 1.4 | 4.4 | — | 1587 | *(none)* |
| `deepseek-v4-pro` | opencode *(planned)* | 0.435 | 0.87 | 0.806 | — | none, high, max |
| `deepseek-v4-flash` | opencode *(planned)* | 0.14 | 0.28 | 0.790 | — | none, high, max |

`banned_models` is a separate list from "not currently routed", because the
reason matters. `claude-fable-5` is banned on cost: $50/MTok output is 2× Opus 5
for a *lower* SWE-bench Verified score (95.0 vs 96.0). At the measured ~48k
output tokens per review that is $2.40 a call with no capability justification.
The verifier fails if any vendor tier or domain preference ever routes to it.

---

## 4. Tiers and domains

Tiers are the vendor-facing ladder:

| Tier | Claude | Codex | OpenCode *(planned)* |
|---|---|---|---|
| `fast` | Haiku 4.5 | GPT-5.6 Luna | deepseek-v4-flash |
| `balanced` | Sonnet 5 | GPT-5.6 Terra | glm-5.2 |
| `thorough` | Opus 5 | GPT-5.6 Sol | kimi-k3 |

Capability, though, is domain-shaped rather than scalar. Opus 5 leads backend
defect resolution; kimi-k3 leads the frontend arena. A single ladder cannot
express that, so `domains` carries a preference list per tier. The domain is
detected from changed-file extensions; `mixed` and `unknown` both fall back to
`backend`, the conservative default — the backend list is `measured`, the
frontend list is still a `hypothesis` pending a local A/B.

---

## 5. PR classes

**Order is the routing logic — first match wins.** The list is in
`pr_classes`, and `risky` sits second, immediately after `generated`, so
consequence-based promotion dominates every cheapening rule below it. A
deletion-only PR that removes auth code, or a two-file change to a migration,
must not fall through to `fast`.

| # | Class | Tier · effort | Steps |
|---|---|---|---|
| 1 | `generated` — every file generated or vendored | *skip* | — |
| 2 | `risky` — security / data-critical | thorough · high | review, fix, recheck |
| 3 | `deletion_only` | fast · medium | review |
| 4 | `docs` | balanced · high | review |
| 5 | `test_only` | fast · medium | review, fix |
| 6 | `config_infra` | balanced · high | review, fix, recheck |
| 7 | `trivial` | fast · medium | review, fix |
| 8 | `standard` — fallthrough | balanced · medium | review, fix, recheck |

Two classes drop the fix loop on purpose. `docs` is open-ended design
negotiation that no automated fix loop terminates. `deletion_only` carries
reference-breakage risk rather than defect density — a wrong deletion is
reverted, not patched — so it gets a review focused on dangling imports, call
sites, config keys, route registrations and stale doc pointers.

The last entry must have an empty `match`: it is the fallthrough, and
`resolveReviewStrategy` falls back to it when nothing matches. The verifier
asserts this.

### Path patterns are anchored

Class patterns match path *segments and extensions*, not substrings. An
unanchored list is worse than no list:

- `auth` matched `author.ts`, `authors.ts` and `oauth.ts`;
- `migration` matched this repo's own `MIGRATION_AND_GROWTH.md`, promoting a
  pure-docs PR to `thorough` with a full fix/recheck loop;
- `spec` matched `src/lib/pr-spec.ts` and `test` matched any `latest.ts`,
  routing ordinary source changes to `test_only` with a test-focused prompt.

Over-promotion is safe but expensive; under-review is neither. Both are bugs.

### Size caps fail closed

`src_churn_max` can only be evaluated when churn is attributable — the PR
context carries whole-PR `additions`/`deletions`, not per-file counts, so the
total is only meaningful when every changed file is source. When it is not, the
cap fails **closed** (the churn reads as `Infinity` and the class does not
match). Failing open cost us a real misroute: `['package.json',
'src/lib/runner.ts', 'src/lib/board.ts']` at +3000/−2000 satisfied
`files_max: 3`, the unattributable churn read as `0`, and a 5,000-line change to
the core runner was routed to `fast` with no recheck.

---

## 6. Design decisions

### 6.1 Why a versioned policy file, not code

Every crosscheck comment cites `strategy=<version>`. A review that ran three
months ago has to stay explicable by the policy in force when it ran, and that is
only possible if the policy is a versioned artifact rather than a diff of
`if` statements. It also puts the routing decision and the sentence explaining it
in the same record, so the two cannot drift apart: `reason` is quoted verbatim
into the PR comment, which is why the verifier fails any class missing one.

`review-model-tiers.json` is retained for backwards compatibility and is
superseded by this file.

### 6.2 Why capability is not a single number

See §4. A tier ladder is a cost ladder that happens to correlate with capability
inside one vendor. Across vendors and across domains it stops correlating, which
is why `domains.*.preferred` exists and why each entry carries a `confidence`
field. `measured` and `hypothesis` are load-bearing words here — the frontend
list is a hypothesis and is labelled as one.

### 6.3 Why `thorough` moved to Opus 5

Identical $5/$25 pricing, higher SWE-bench Verified (0.960 vs the 4.8 pin it
replaced). There is no trade here; the old pin was a silent capability loss, and
it persisted only because nothing was watching. §2 exists so the next one does
not persist.

### 6.4 Models with no effort ladder — the OpenCode case

Most open-weight models expose no effort parameter at all: `kimi-k3`, `glm-5.2`
and `claude-haiku-4-5-20251001` all have `effort_levels: []`, and the deepseek
models expose only `none`/`high`/`max`. An escalation step defined purely as
"raise effort" silently no-ops on every one of them.

So the ladder declares `effort_fallback: "promote_tier"`: where effort cannot
rise, the escalation degrades to a model step instead. `escalate()` implements
this by clamping the round's target effort to what the model actually accepts and
promoting a tier only when the clamped value is not an increase over the round
before — otherwise a model whose ladder tops out below `xhigh` comes out of
round 3 *weaker* than it left round 2.

The verifier enforces the invariant directly: if any model has no effort levels,
`ladder.effort_fallback` must be set.

### 6.5 Escalate on measured non-convergence, never on predicted complexity

The ladder is bounded — 3 rounds, 5 blocking findings, 60 wall-clock minutes —
and each round narrows scope rather than widening it. Round 2 rechecks the delta
plus the open findings, not the whole PR again. The model never weakens across
rounds; only its scope shrinks. Round 4 is a handoff to a human with a digest,
not a fourth attempt.

### 6.6 Cross-vendor vs single-vendor

Cross-vendor buys an independent second perspective: in the census a vendor
switch broke a stalled loop twice (PR #2057, #2060) after same-vendor escalation
had failed for three to six rounds. Its round-3 lever is *switch vendor and raise
effort*, and it caps at 3 rounds. Single-vendor buys one CLI to authenticate,
version and monitor, with no routing logic; its round-3 lever is *raise effort,
then promote one tier*, because no fresh-eyes option exists, and it caps at 2.

### 6.7 Conflict resolution is not a review

`conflict_resolve` runs at `fast`/`low` regardless of class. Resolving conflict
markers is mechanical text surgery bounded by the markers themselves — measured
at 37s against ~643s for a review. Spending review-grade capability on it buys
nothing.

### 6.8 What classification may and may not conclude

Two rules constrain the classifier, and they are the reason it stays a small
static function instead of growing into a difficulty predictor:

1. **It may set a floor, or promote on consequence.** A security path is
   reviewed thoroughly because a miss there is expensive. That is a statement
   about cost of failure, which the file list genuinely supports.
2. **It may not predict that a PR will be hard.** Static features — file count,
   line count, extension mix — do not support that inference. Difficulty is
   discovered by reviewing, not before it. So there is no "this looks tricky,
   use the big model" rule, and there never should be.

Escalation is how difficulty gets handled, and it is driven by *measured*
non-convergence: the review came back BLOCK, the fix did not resolve it, so the
next round escalates. That is evidence. A file-count heuristic is not.

---

## 7. Runtime status

`runtime_status: "defined_not_wired"`. This file and the JSON are the adopted
policy, but no runtime code reads `resolveReviewStrategy()` yet —
`resolveClaudeModel` / `resolveCodexModel` still apply the single configured
`quality.tier`. Verification, documentation and the citation contract are in
place ahead of the resolver so the policy is settled before it is enforced.

Consequently:

- `quality.mode` stays **optional**. Unset means `fixed` — the legacy behaviour —
  and it will stay that way until the resolver lands, so nothing silently changes
  tier on upgrade.
- `citation.annotation_fields` (`strategy`, `class`, `tier`) is a declared
  contract, not yet emitted by `src/lib/annotation.ts`.

Wiring is the next change, and it is a separate one. It needs the PR's changed-file
list threaded to the reviewers, the `strategy` argument passed at each
`resolve*Model` call site, and the annotation fields emitted — none of which
belongs in the PR that settles the policy.

---

## 8. Cadence

`review_interval_days: 60`. The verifier warns past 45 days and fails past 60.
The `Review Strategy` workflow runs Mondays at 09:15 UTC — fifteen minutes after
`model-tier-sources`, so the two do not race the same provider docs — and on any
PR touching the strategy, the verifier or this document.

To refresh: re-read the `sources` and `benchmarks` pages, update prices, scores
and tier assignments in `src/config/review-strategy.json`, refresh the analysis
here, bump `version` and `updated`, then run `npm run verify:strategy`.