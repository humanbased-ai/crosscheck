# Dynamic thoroughness — design & evidence

| | |
|---|---|
| **Strategy version** | `1.0.0` — [`src/config/review-strategy.json`](../src/config/review-strategy.json) |
| **Analysis run** | 2026-08-07T05:00:00Z |
| **Census window** | 2026-07-30 → 2026-08-07 |
| **Corpus** | 400 merged PRs · 199 crosscheck-engaged · 597 agent calls · 43 locally-logged runs |
| **Hand-labelled** | 40 BLOCK findings read against cited source |
| **Next review due** | 2026-10-06 (60-day interval) |
| **Re-verify** | `npm run verify:strategy` |

Status: **adopted; partially wired**. This document is the evidence behind
[`review-strategy.json`](../src/config/review-strategy.json); the JSON is what
crosscheck reads at runtime. The runner classifies every PR from its cloned
working copy, folds the result into the quality config the reviewers receive,
and stamps the version, class, and tier into each annotation. When they disagree, the JSON wins and this document is
stale — the weekly `Review Strategy` workflow files an issue when either drifts.

**Only the `Tier` column below is enforced today.** `Effort` and `Steps` are
resolved and logged but never applied: effort still comes from
`vendors.*.effort`, and every class runs the configured pipeline — so class 1
gets a review at the configured tier rather than being skipped, and class 4
still runs its fix and recheck steps. `escalate()` is likewise not yet called
from the runner, so §6.8's round ladder describes the design and not current
behaviour. Comments cite only the tier that actually applied, so the citation
never claims more than the runtime does.

Every crosscheck comment cites the strategy version it ran under, so a review from
last month can be explained by the policy in force when it ran rather than the policy
in force today.

---

## 0. The goal, and what it implies

The objective is **shipping quality code at a faster pace**. Code review is
instrumental to that, not an end in itself. So the metric that matters is not cost per
review, and not findings per review. It is:

> **Actioned-finding rate** — the share of real defects that get fixed *inside the
> merge window*.

A finding that arrives after merge is worth nothing. A finding the author declines to
act on is worth nothing. A correct finding nobody reads is worth nothing. Everything
below is organized around that.

Measured against it, the current system has a specific and non-obvious problem:

| | Measured | Reading |
|---|---|---|
| Review lands before merge | **94%** | Delivery works. |
| Findings that are real defects | **~85%** (hand-labelled, n=39) | Quality works. Noise is not the bottleneck. |
| PRs reaching APPROVE | **38%** | Action does not happen. |
| Median gap, last review → merge | **4 minutes** | **The author was already merging.** |

The reviewer is fast and it is right, and 62% of its output is merged past anyway — with
56% of those merges landing within five minutes of the review, or before it.

**The structural reason: crosscheck never publishes a merge-blocking signal.** It reads
commit statuses and check-runs (`client.ts:555`, `client.ts:684`) but creates neither.
Its entire output is a comment. Branch protection requires:

| Branch | Required checks |
|---|---|
| `staging` | `PR size, template, and reviewability`, `ci-gate` |
| `main` | + `release-guard`, 1 approving review |

Crosscheck appears in neither list, so GitHub merges the moment `ci-gate` goes green.
Nothing stops a merge at minute four. (`enforce_admins` is `false` on both branches, so
even a required check would be admin-bypassable.)

Two distinct failure modes follow, and they need different fixes:

1. **The fast majority — no gate.** Merging before the review lands is undisciplined
   practice, not a considered trade-off. No improvement to review quality, latency, or
   phrasing changes it, because the review is not part of the merge decision at all.
   Only a gate does.
2. **The slow tail — no terminal state.** Findings never stop arriving (§3), so the
   loop is an open-ended commitment. This is what makes the process intolerable *once
   authors are forced to engage with it*.

These compose in a specific order. **Gating without first bounding the loop would be
actively harmful** — it converts "merged past findings in 4 minutes" into "blocked for
51 hours," which is the opposite of the goal. Bound the loop first, then gate, then
optimize latency.

---

## 1. Methodology

| Input | What it gives | Confidence |
|---|---|---|
| **A.** Census of all 400 merged PRs | Population-scale cost and outcome | High |
| **B.** 40 BLOCK findings read against the cited code | Whether findings are real | High — hand-labelled |
| **C.** Local run logs (43 runs) | Tokens + wall-clock per step | High — measured |
| **D.** Vendor catalogs + live CLI probe | Price, effort, what actually runs | High — primary |
| **E.** SWE-bench, CR-Bench | Relative capability by task shape | Medium — see §5 |

Two earlier approaches were abandoned, recorded here so they are not re-derived:

- **Sampling 30 PRs and fitting a complexity score to agent-call count.** Circular:
  call count is set by whether the loop converged, which is a property of the reviewer
  configuration, not the PR. The census replaces it.
- **`breadth = dirs × languages` as a complexity metric.** Scored a perfect AUC on the
  30-PR sample; the census falsifies it outright (§4).

For the labelling pass, BLOCK findings were extracted from PRs that merged *without*
reaching APPROVE, deduplicated, sampled 40 (seeded; 20 P1-code / 12 P2-code / 8 docs),
and each was read against the file it cites at the SHA it was reviewed at.

---

## 2. Finding 1 — the findings are real

This was the decisive experiment, and it inverted the design.

Of 40 sampled findings: 1 unverifiable (file since deleted), **0 false**. Every
remaining claim was a true statement about the code it cited.

| Label | n | Meaning |
|---|---|---|
| Real, defect-grade | **33** | Genuine bug, security gap, or documented-convention violation |
| Real, severity-inflated | 6 | True, but should not have contributed to BLOCK |
| False | **0** | — |
| Unverifiable | 1 | Cited file no longer retrievable |

Representative confirmed defects, each verified against source:

- **#8** — `change_rule_mode` accepts an `expected_mode` parameter and never puts it in
  the POST body. Dual-control bypass. Two lines apart in the same function.
- **#6** — `body.get("data")` sits *outside* the `try` that catches JSON errors; a
  non-object response raises an uncaught `AttributeError`.
- **#10** — `_validated_gate` hard-rejects a gate response missing `profile`, so during
  a normal rolling deploy every enroll returns 503 until both services are upgraded.
- **#13** — the promote payload sends three fields the receiving `extra="forbid"` model
  no longer defines: every promotion and rollback 422s. Feature entirely broken.
- **#26** — `min_a2_shared_wrong` bounded at `_Bound(int, 0)` while its sibling and the
  request contract require ≥ 1.
- **#4** — migration named `20260820000000`. `docs/architecture/database-conventions.md`
  says verbatim: *"**Never hand-write a round-number timestamp**"*, and documents a
  prior silent-skip incident. The reviewer cited the correct line range.

The reviews also demonstrate project-specific reasoning that a generic linter cannot
do: they read repo convention docs, cross-reference design ADRs, and trace call paths
across services.

**The six severity-inflated cases are the real defect in the output**, not the
findings themselves: a webhook-secret hardening that requires operator misconfiguration
to exploit (#2), a request for validation stricter than the contract claims (#3), and
screenshot binaries committed to a feature branch (#20) — a process violation, correctly
identified, that should never gate a merge.

> **Calibration note.** CR-Bench reports 3.6–5.1% precision for review agents (§5).
> This system measures ~85% defect-grade. The gap is real and worth naming: CR-Bench
> scores against a fixed ground-truth defect list, penalizing any finding outside it,
> whereas this labelling asked "is the claim true and worth fixing." Those measure
> different things. The operational conclusion stands regardless — **do not tune this
> system as though its output were noise.**

---

## 3. Finding 2 — the loop cannot converge, by construction

Findings per review pass, across the census:

| Pass # | Passes | Mean findings | Total |
|---|---|---|---|
| 1 | 198 | 2.0 | 391 |
| 2 | 90 | 2.5 | 221 |
| 3 | 46 | 2.5 | 117 |
| 4 | 32 | **3.3** | 105 |
| 5 | 23 | **3.7** | 86 |
| 6+ | 94 | 2.3 | 216 |

**Later passes find more, not fewer.** And the findings do not repeat: across 684 raw
findings there are 676 distinct ones — a dedup ratio of **1.0**. Nothing recurs.

So the fixer *is* fixing (issues do not come back), and each pass mines a fresh seam.
Two sampled findings are regressions introduced by the *previous* round's fix:

- **#15 → #19** — round N flags a dual-control TOCTOU; the fix adds
  `expected_mode=current_mode`; round N+1 correctly observes that this now 409s every
  legitimate retry.
- **#32 → #33** — round N flags two data streams missing from a legal retention table;
  the fix adds them but describes the device ID as `raw`, contradicting the ADR that
  requires `key_version:HMAC`. Round N+1 catches it.

This is legitimate, valuable work. It is also **an unbounded process**: there is no
round at which the supply is exhausted, so "iterate until APPROVE" has no terminal
state. PR #1998 ran 12 recheck rounds — 26 agent calls, 4.6 hours — and merged unresolved.

The remedy is therefore not a better fixer or a stronger recheck model. It is to
**stop treating APPROVE as the exit condition** and bound the process explicitly.

---

## 4. Finding 3 — crosscheck is racing the merge, and the race is tight

Across the 122 PRs that merged unresolved, time from the **last** review comment to
merge:

| | Share |
|---|---|
| Review landed *after* the merge — too late entirely | 12% |
| Merged within 5 minutes of the review | **44%** |
| Merged 5–60 minutes after | 25% |
| Merged > 1 hour after (saw it, chose to ship) | 18% |

Median: **4 minutes**. Only ~18% of unresolved merges look like a considered decision.

The elapsed-time hypothesis — that authors bail because loops run too long — is **true
in the tail and insufficient on its own**. Convergence is flat at 33–41% across every
span and round bucket, including the 108 single-round PRs that resolved in a median of
11 minutes. Long loops do not predict merging unresolved; the behavior is uniform.

The uniformity is the tell. If authors were weighing findings, the rate would vary with
how painful the PR was. It does not vary at all — which is what an **absent gate** looks
like (§0). The fast majority is not a considered trade-off; it is merging that nothing
prevents. The tail is a separate problem: those PRs have the *highest* rate of reviews
landing after merge (20%) and a median span of **51 hours**, which is what makes the
loop intolerable once a gate forces engagement.

The window is genuinely tight. First review lands at a median of 6 minutes; merge at 11
minutes for single-round PRs and 36 overall. At p25, merge happens at 9 minutes against
a p25 review at 5. **For a large share of PRs the usable window is single-digit
minutes** — which makes time-to-first-review a first-class design constraint, not a
nice-to-have.

### Static prediction is weak

**Static complexity does not predict cost.** Spearman vs agent-call count across all 199
engaged PRs: churn 0.513, files 0.428, churn/files 0.321. The distributions overlap
severely — the largest one-call PR was **101,118 lines**; the smallest 7+-call PR was
**103**; and the single most expensive PR in the census (#1998, 26 calls) changed
**2 files**.

Conclusion: static features can answer only *"is this trivially safe to start cheap?"*
They set a floor. They cannot identify the hard PRs in advance, so they must never set
the ceiling.

---

## 5. Finding 4 — model selection is currently inert

Three breaks in one path, all of which must be fixed before any tiering policy can have
an effect.

**a. The Claude override bypasses tiers.** `vendors.claude.model: sonnet` wins over the
tier table, so all 43 logged runs were `claude-sonnet-5` regardless of `quality.tier`.

**b. The Codex model is silently discarded.**

```ts
export function resolveCodexModel(quality, vendor): string {
  if (vendor.auth !== 'api-key') return 'default'   // ← drops the configured model
  ...
}
```

The config sets `vendors.codex.model: gpt-5.6-sol` with `auth: subscription`, so it
never reaches the CLI. **148 of 199 engaged PRs and 482 of 597 calls (81%) ran on
`model=default`.** A live probe contradicts the guard's rationale: `codex -m/--model`
is a top-level flag and the CLI accepted it under subscription auth.

**c. The installed CLI is too old for the configured model.** The same probe returned
`The 'gpt-5.6-terra' model requires a newer version of Codex.` Installed
`codex-cli 0.141.0`; npm latest `0.147.0`. That error text is exactly what
`isVendorUnavailableError` matches, so smart-switch has been silently absorbing it.

Outcomes by first model:

| First model | PRs | Calls | Merged without APPROVE |
|---|---|---|---|
| `default` | 148 | 482 | **74%** |
| `claude-opus-5` | 22 | 60 | **5%** |
| `claude-sonnet-5` | 15 | 19 | 27% |
| `gpt-5.6-luna` | 6 | 22 | 17% |
| `gpt-5.6-sol` | 7 | 14 | 86% |

> **Confound, stated plainly.** Assignment was not random — it followed origin routing
> and smart-switch state. `gpt-5.6-sol`'s 86% is the clearest artifact: n=7, used as an
> *escalation target* on already-stuck PRs. The same bias inflates part of the `default`
> column. But `default` spans 148 PRs, and 74%-vs-5% is wider than selection alone
> plausibly explains.

### Price and capability

| Model | In | Out | Cost @ 48k out | Effort |
|---|---|---|---|---|
| `claude-fable-5` | $10 | $50 | $2.40 | low→max |
| `claude-opus-5` | $5 | $25 | $1.20 | low→max |
| `claude-sonnet-5` | $3 | $15 | $0.72 | low→max |
| `claude-haiku-4-5` | $1 | $5 | $0.24 | **none** |
| `gpt-5.6-sol` | $5 | $30 | $1.44 | none→max |
| `gpt-5.6-terra` | $2 | $12 | $0.58 | none→max |
| `gpt-5.6-luna` | $0.20 | $1.20 | **$0.058** | none→max |

SWE-bench Verified (one leaderboard, refreshed 2026-08-06, consistent within the Claude
family): Opus 5 **96.0%**, Fable 5 95.0%, Sonnet 5 **85.2%**, Haiku 4.5 **73.3%**.
Cross-family figures (Sol ~96.2%, Luna ~93%) come from a *different* aggregator and are
directional only.

Measured step costs (43 runs): review 643 s / 48.0k output tokens; **recheck 663 s /
48.9k — the same as a full review**; fix 409 s; conflict-resolve **37 s**.

Anthropic's effort guidance supports varying effort per call, with the constraint that
it must be constant *within* a cached conversation. Note Haiku 4.5 has no effort
parameter at all.

---

## 6. Design

Everything follows from §0: maximize actioned findings inside the merge window.

### 6.1 Front-load capability into pass 1 — against a latency budget

Pass 1 is the only pass reliably read before merge, and later passes find *more*
defects, not fewer (§3). So capability spent on pass 1 converts to action; capability
spent on pass 7 mostly does not.

But capability costs time, and §4 shows the window is often single-digit minutes. **This
tension is the actual case for dynamic thoroughness** — and it is the one justification
that survives the census. It is not cost. A review that is 10 points better on SWE-bench
and arrives after the merge scores zero.

So the tier is chosen against a **latency budget derived from expected merge speed**,
not from predicted difficulty:

| PR class | Expected merge | Budget | Tier |
|---|---|---|---|
| Trivial (§6.5) | ~9–11 min | **< 3 min** | `fast` — latency-driven, not cost-driven |
| Standard | ~36 min | < 10 min | `balanced` + `xhigh` |
| Risky / `risk:T3` | hours | < 20 min | `thorough` |

This is why the `fast` tier earns its place: on a PR that merges in nine minutes, Haiku
at 73.3% delivered in two minutes beats Opus at 96.0% delivered in twelve. The 12% of
reviews that currently land after merge are pure waste at any capability level.

- **Pin the models** (§5). Drop the `auth !== 'api-key'` guard; honor a configured model
  under either auth, as `resolveClaudeModel` already does. Require `codex >= 0.147.0`
  when a `gpt-5.6-*` model is set, and fail loudly at startup.
- **Refresh `review-model-tiers.json`.** `thorough` currently pins `claude-opus-4-8`,
  now legacy; `claude-opus-5` supersedes it at the identical $5/$25 and scores 96.0% vs
  88.6%. Free upgrade, ship independently.
- **Raise the pass-1 floor to `balanced`, and use `xhigh` effort.** Effort is the cheap
  lever: Sonnet 5 at `xhigh` costs the same per token as at `medium` and merely spends
  more of them, where Sonnet→Opus is a flat 1.67× on every token.

```json
{
  "claude":    { "fast": "claude-haiku-4-5-20251001",
                 "balanced": "claude-sonnet-5",
                 "thorough": "claude-opus-5" },
  "codex_api": { "fast": "gpt-5.6-luna",
                 "balanced": "gpt-5.6-terra",
                 "thorough": "gpt-5.6-sol" }
}
```

No `frontier` tier for `claude-fable-5`: 2× Opus 5's output price for a *lower*
SWE-bench score.

### 6.2 Make the terminal state visible — the closing contract

The exit condition changes from "APPROVE" to "**the blocking set is closed**," and —
critically — **pass 1 must say so in the comment.**

Authors merge past findings because entering the loop is an open-ended commitment (§0).
Bounding the set internally does not fix that; the author cannot see the bound. The
first review has to carry the promise explicitly:

> **3 blocking issues. This is the complete blocking set — later rounds will not add to
> it.** 7 further observations are advisory and do not gate this PR.

That sentence is the whole intervention. It converts an open-ended commitment into a
bounded one, which is the difference between a decision an author can make in the merge
window and one they resolve by merging.

It also has to be *true*, which constrains the implementation:

- Pass 1 emits at most N blocking findings (default 5), ranked; everything else is
  advisory and explicitly non-gating.
- **Advisory findings never trigger a fix round**, and later rounds may not promote a
  finding into the blocking set. A new defect discovered in round 3 is reported as
  advisory — otherwise the promise breaks and the learned disengagement returns.
- **Hard cap: 3 fix/recheck rounds, and a wall-clock budget.** Whichever binds first
  ends the loop with a digest and a human assignment. Given §3 the process has no
  natural terminal state, and given §4 the round count is the wrong unit — 7+ round PRs
  span a median of 51 hours.

The one real cost: capping the blocking set means some genuine defects ship as advisory.
Given ~85% precision that is a real loss, and it is the right trade — a bounded set that
gets acted on beats an unbounded one that gets merged past. The advisory list preserves
the finding for the author and for follow-up.

### 6.3 Tighten severity so BLOCK means something

Six of 40 sampled findings were true but should not have gated a merge. BLOCK should
require a concrete failure path in the changed code: data loss, security boundary,
broken API contract, or a correctness bug with a reachable trigger. Explicitly **not**
BLOCK-grade:

- repository process and hygiene conventions (#20 — screenshot binaries)
- hardening that requires operator misconfiguration to exploit (#2)
- requests for validation beyond what the code's stated contract claims (#3)

These stay in the review as advisory. This costs nothing and raises the signal on the
verdict that gates the pipeline.

### 6.4 The ladder — narrow the scope, hold the model, escalate the effort

Start strong but not maxed (54% of engaged PRs are one-and-done — maxing every pass 1
wastes budget on PRs that need one), then escalate on measured non-convergence.

| Round | Scope | Model | Effort | Rationale |
|---|---|---|---|---|
| **1 · review** | Whole PR | `balanced`, or `thorough` for risk classes (§6.5) | `medium` | Only pass reliably read. Sets the blocking set. |
| **· fix** | The N blocking items | **same as review** | `medium` | See below — cheap fixes cost a whole round. |
| **2 · recheck** | Delta + open items only | **same as review** | `high` | Narrower task, not a weaker judge. |
| **3 · recheck** | Delta + open items | same | `xhigh` | Non-convergence *is* the difficulty signal. |
| **4+** | — | — | — | Stop. Digest + human (§6.2). |

**Should review get cheaper over rounds? Yes — but by narrowing scope, never by
weakening the model.** The two levers look similar on a cost report and are opposite in
effect:

- *Scope* legitimately shrinks. Round 1 reads the whole PR; round N only has to check N
  known items against the delta. Today recheck costs the same as a full review (663 s
  vs 643 s, 48.9k vs 48.0k tokens) **because it re-reviews everything** — that is
  waste, and scoping it is a real saving that the closing contract (§6.2) already
  implies, since later rounds may not add blocking findings anyway.
- *Model* must not weaken. CR-Bench shows weak models degrade fastest under iteration —
  GPT-5-mini's SNR fell to 0.91, below 1, more noise than signal. Recheck is the call
  that decides whether to spend another round; a weak judge there is how loops become
  unbounded.

So the per-round cost curve falls because the **input shrinks**, while capability holds
and effort rises. That is the opposite of the intuitive "reviews are expensive, make
rechecks cheap," which optimizes the one call where cheapness is most damaging.

**On making `fix` cheaper:** it is the safest step to cheapen — generation against an
explicit list is the task models are strongest at (SWE-bench-shaped), unlike detection.
But the census argues for restraint. Two of 40 sampled findings are regressions
*introduced by a previous round's fix* (#15→#19, #32→#33), and each cost a full extra
round at ~10.7 minutes. Against that, a stronger fixer costs ~1.67× on a single call.
**Hold the model, drop effort one notch** — cheaper tokens without buying new defects.
A tier drop is defensible only for mechanical fix steps on trivial PRs.

### 6.5 The strategy table

Encoded in [`src/config/review-strategy.json`](../src/config/review-strategy.json), which
follows the pattern `review-model-tiers.json` already established: an `updated` date,
`sources` with verifiable `checks` strings, and a `review_interval_days` so drift is
detectable rather than silent (§6.6).

**Vendor tiers.** Cost is per 48k-output call, the census median.

| Tier | Claude | $/call | SWE-b | Codex | $/call | Effort |
|---|---|---|---|---|---|---|
| `fast` | `claude-haiku-4-5` | $0.240 | 73.3% | `gpt-5.6-luna` | **$0.058** | Claude: **none** · Codex: all |
| `balanced` | `claude-sonnet-5` | $0.720 | 85.2% | `gpt-5.6-terra` | $0.576 | both: all |
| `thorough` | `claude-opus-5` | $1.200 | 96.0% | `gpt-5.6-sol` | $1.440 | both: all |

*Claude strengths:* highest measured capability at `thorough`, most recent knowledge
cutoff (May 2026). *Weakness:* the `fast` tier has no effort parameter and only a 200k
context. *Codex strengths:* `fast` is 4× cheaper than Haiku on output, effort available
at every tier, 1.05M context throughout. *Weakness:* cross-family benchmarks are not
comparable — validate locally before assuming tier parity.

**`claude-fable-5` is banned from code review** (`banned_models` in the strategy file,
enforced by `verify:strategy`). At $50/MTok output it is 2× `claude-opus-5` for a
*lower* SWE-bench Verified score — $2.40 per call at the measured 48k output tokens,
with no capability justification at any tier.

### The second axis: domain

Capability is domain-shaped, not scalar, and a single tier ladder cannot express that.
SWE-bench Verified resolves issues in *Python* repositories; in this census **42% of
reviewed PRs are frontend-dominant and 55% touch frontend at all**. On the domain that
carries most of the workload the ordering inverts:

| Frontend Code Arena (Elo, blind pairwise) | | SWE-bench Verified | |
|---|---|---|---|
| **Kimi K3** *(open)* | **1679** | **Claude Opus 5** | **96.0** |
| Claude Fable 5 | 1631 | Claude Sonnet 5 | 85.2 |
| GPT-5.6 Sol | 1618 | DeepSeek V4 Pro *(open)* | 80.6 |
| GLM-5.2 *(open)* | 1587 | DeepSeek V4 Flash *(open)* | 79.0 |
| Claude Opus 4.8 | 1562 | GLM-5 *(open)* | 77.8 |
| Grok-4.5 | 1558 | Claude Haiku 4.5 | 73.3 |

The most capable frontend model available is open-weight, and it is a different model
from the backend leader. Hence `domains` in the strategy file: `frontend` prefers
`kimi-k3` → `gpt-5.6-sol` → `claude-opus-5` at `thorough`; `backend` prefers
`claude-opus-5` → `gpt-5.6-sol`. `mixed` and `unknown` fall back to `backend`.

> **Confidence: hypothesis, marked as such in the JSON.** Arena measures blind human
> preference on *generated* frontend output — a generation task, where review is
> detection. The same asymmetry that limits SWE-bench applies. And **Claude Opus 5 is
> absent from the retrieved frontend leaderboard** (only Opus 4.8 at 1562) — a missing
> measurement, not a low score. The backend row is `measured`; the frontend row needs a
> local A/B before it should be trusted over the default.

**PR classes.** First match wins, so ordering is the routing logic.

| # | Class | Detection | Tier | Effort | Steps |
|---|---|---|---|---|---|
| 1 | Generated / vendored only | every file is a lockfile, build output, or generated stub | — | — | **skip** |
| 2 | **Security / data-critical** | risky path, `risk:T3`, or hotfix→default branch | `thorough` | high | review, fix, recheck |
| 3 | Deletion-only | ≤ 5 additions with ≥ 20 deletions | `fast` | medium | review |
| 4 | Documentation / specification | ≥ 50% `.md`/`.rst`/`.adoc` | `balanced` | high | review |
| 5 | Test-only | every file is a test or fixture | `fast` | medium | review, fix |
| 6 | Config / infrastructure | ≥ 50% config, no source files | `balanced` | high | review, fix, recheck |
| 7 | Trivial | ≤ 3 files and ≤ 150 source churn | `fast` | medium | review, fix |
| 8 | Standard code | fallthrough | `balanced` | medium | review, fix, recheck |

Three classes carry reasoning that is not obvious from the row:

- **Deletion-only** is not "small, therefore cheap." Its risk is *reference breakage* —
  dangling imports, call sites, route registrations, docs pointing at removed symbols —
  which is a narrow lookup task, not defect detection. And it gets no fix loop: a wrong
  deletion is reverted, not patched.
- **Docs is review-only.** Census: docs PRs converge worst (mean 4.1 calls vs 3.0), and
  #1998 — the most expensive PR in the census at 26 calls — was two markdown files. The
  findings were real, but they were *design negotiation*, which no automated loop
  terminates. Removing the fix/recheck loop for this class is the single largest tail
  saving available.
- **Security is the only promotion rule**, applied because a missed defect there is
  expensive — *not* because those PRs are predicted to be hard. §4 shows static features
  cannot predict difficulty.

**Mode.**

| | Cross-vendor | Single-vendor |
|---|---|---|
| Strength | Independent second perspective | One CLI to auth, version, monitor |
| Round-3 lever | **switch vendor + raise effort** | raise effort, then promote one tier |
| Cost | both CLIs must stay current | loses the deadlock-breaker |
| `max_rounds` | 3 | **2** |

Cross-vendor's specific value is empirical: a vendor switch broke a stalled loop twice
in the census (#2057, #2060) *after* same-vendor escalation had failed for 3–6 rounds.
Single-vendor has no equivalent move, so it should cap rounds more aggressively rather
than grind.

### 6.6 Citing the strategy in every review

A review is only auditable if it says what policy produced it. Every crosscheck comment
carries the strategy version, the PR class that was matched, and the tier that class
selected — in both the machine annotation and the human-readable line.

```
<!-- crosscheck: origin=claude reviewer=claude model=claude-opus-5 type=review
     round=1 verdict=BLOCK strategy=1.0.0 class=risky tier=thorough
     service=crosscheck sha=abc123 -->
```

> _Reviewed with [Claude Code](https://claude.ai/code) via [Crosscheck](https://github.com/humanbased-ai/crosscheck)
> with Opus 5 (high) — thorough tier · touches a security or data-critical path, where a
> missed defect is expensive · strategy v1.0.0_

The rationale text is not written per review — it is the matched class's `reason` field,
so the explanation and the routing decision cannot drift apart. `strategy`, `class`, and
`tier` are **additive** annotation fields: per the annotation contract in `CLAUDE.md`,
parsers already tolerate unknown fields, so this is a minor version bump, not a breaking
change.

This is what makes a past review explicable. A BLOCK from six weeks ago was produced by
whatever policy was current then; without the version stamp, re-reading it under today's
policy is a guess.

### 6.7 Keeping the table current

The table is a perishable asset — `review-model-tiers.json` already went stale, pinning
`thorough` to `claude-opus-4-8` after `claude-opus-5` superseded it at the same price
and +7.4 points. That is a free capability loss, and it happened silently.

Staleness is now loud, by machine:

1. **`npm run verify:strategy`** ([`scripts/verify-review-strategy.mjs`](../scripts/verify-review-strategy.mjs))
   checks three things — internal consistency (every routed model exists; no banned
   model is routed; every class carries a citable reason), freshness against
   `review_interval_days`, and source drift (each `sources[].checks` string still
   appears on the live page).
2. **The `Review Strategy` workflow** ([`.github/workflows/review-strategy.yml`](../.github/workflows/review-strategy.yml))
   runs it on every PR touching the strategy, and weekly on a schedule. A scheduled
   failure opens a `strategy-drift` issue with the report and the remediation steps —
   it deliberately does *not* auto-edit the file, because model choice is a judgement
   backed by benchmarks a human has to read.
3. **Fail loudly on model rejection.** The `gpt-5.6-terra` 400 (`requires a newer
   version of Codex`) was silently absorbed by smart-switch, so the operator never
   learned their configured model was dead. Version and model errors should surface as
   configuration errors, not degrade quietly.
4. **`min_cli_version` per vendor**, checked at startup when a model needs it.

### 6.8 What classification may and may not decide

Every class in §6.5 is computed from the file list alone — no model call, no cost, and
available before the first review starts.

The hard constraint is what classification is *allowed* to conclude. It may:

- set the **floor** (`trivial`, `deletion_only`, `test_only` → `fast`)
- **promote** on consequence, not on predicted difficulty (`risky` → `thorough`)
- choose the **step set** (`docs` → review-only; `generated` → skip)

It may **not** predict that a PR will be hard and pre-emptively assign `thorough` for
that reason. §4 shows static features cannot support that inference: churn correlates
only 0.513 with realized cost, the largest one-call PR was 101,118 lines, and the most
expensive PR in the census changed 2 files. Difficulty is discovered by reviewing, and
that is what the ladder in §6.4 is for.

This is the discipline that keeps the table honest as it grows: new classes may adjust
the floor or the step set, but escalation stays evidence-driven.

---

## 7. Expected effect

| Change | Mechanism | Effect on the goal |
|---|---|---|
| Bounded set + closing contract (§6.2) | Loop gets a terminal state | Prerequisite for everything else |
| **Docs → review-only** (§6.5) | Removes the loop from the worst-converging class | Largest single tail saving |
| Pin models (§5, §6.1) | 148 PRs leave `default` | Unresolved 74% → plausibly ~25% |
| Cap rounds + wall-clock (§6.2) | 18 PRs truncated to ≤7 calls | **139 of 597 calls removed (-23%)**, verified |
| Latency budget (§6.1) | Review lands inside the merge window | Recovers the 12% arriving after merge |
| Severity discipline (§6.3) | ~15% fewer spurious BLOCKs | BLOCK becomes actionable |
| Skip generated / deletion-only (§6.5) | Removes calls with no defect surface | Pure saving, no quality cost |
| Publish a check run | Lets a team gate if they choose | Enables adoption; team's decision, not ours |

**The gate is what converts every other item here from advisory to load-bearing.** Today
review latency and review quality are both free variables — nothing downstream consumes
them. Once `crosscheck/review` is a required check, review latency becomes time-to-merge
directly, and *that* is what makes dynamic thoroughness a velocity lever rather than a
cost optimization.

Cost moves in both directions — up on pass 1, down hard on the tail — and nets roughly
flat to modestly lower. **That is the correct trade for this goal.** The call-count
reduction is the firm number; it follows from the round cap alone.

The measurable success criterion is **actioned-finding rate**, not cost: today 38% of
engaged PRs reach a closed state. Everything above should be judged on whether it moves
that number.

Throughput: #1998 goes from 4.6 hours of reviewer wall-clock, merged unresolved, to
~1.2 hours with a human handoff carrying a bounded list.

Two levers not modelled: `gpt-5.6-luna` at $0.058/call is 4× cheaper than Haiku on
output and reportedly much stronger — but that number is cross-family, so it needs a
local A/B, not a config change. And prompt caching cuts cached input 90%.

---

## 8. Rollout

Scoped to the tool. Whether a team gates on the result, and how they merge, is theirs to
decide — crosscheck's job is to be correct, bounded, and current by default.

**Silent-failure fixes** — pure defects, independent of every open design question:

1. **`resolveCodexModel` discards the configured model** under subscription auth (§5).
   Verified: the CLI accepts `--model` under either auth. 81% of census calls ran on an
   unpinned `default` because of this one guard.
2. **Model/version rejection is absorbed by smart-switch.** The `gpt-5.6-terra` 400 was
   swallowed, so the operator never learned their configured model was dead. Surface
   configuration errors as configuration errors; add `min_cli_version` checks at startup.
3. **Audit the round cap.** `workflow.yml` sets `max_rounds: 3`; #1998 reached round 12.
   `exceedsMaxRounds` (`runner.ts:184`) exempts a review step coerced to recheck — a
   plausible path, not yet confirmed. No bound holds until this does.
4. **Refresh the tier table** — `claude-opus-4-8` → `claude-opus-5`, same price, +7.4pts.

**Behavior** — needs the fixes above to be measurable:

5. **Bound and rank the finding set; state the closing contract** (§6.2); **tighten
   BLOCK** (§6.3). Prompt-level only, reversible in one commit.
6. **Land the strategy table** (§6.5) in shadow mode — log the class and tier beside the
   realized outcome, change nothing. Start with the three highest-confidence classes:
   `generated` (skip), `deletion_only`, and `docs` (review-only).
7. **Measure per-tier latency**, then enable the latency budget (§6.1). The fast-lane
   argument depends on numbers not yet measured.
8. **Enable the ladder** (§6.4) last — highest impact, easiest to get wrong.

**New capability** — makes crosscheck adoptable where review must be load-bearing:

9. **Publish a `crosscheck/review` check run** — `pending` while reviewing, `success`
   when the blocking set is closed or empty, `failure` when it is not. `client.ts` reads
   check-runs today but creates none, so a team *cannot* gate on crosscheck even if they
   want to. Ship it off by default and let teams opt in.

```yaml
quality:
  tier: balanced
  mode: smart              # already in schema.ts; currently inert
  smart:
    shadow: false
    max_blocking: 5        # above this → advisory, never gating
    max_rounds: 3          # hard stop, then hand to a human
    max_wall_clock_min: 60 # whichever binds first ends the loop
```

### Open questions

- **What block rate would a required check actually produce?** Today 62% of engaged PRs
  end non-APPROVE. Gating naively would block roughly that share — untenable. Step 3's
  unrequired rollout measures the real number after §6.2–6.3 land, and that number
  decides whether gating is viable at all.
- **Does the closing contract change behavior on its own?** It is the least-proven part
  of the design, and it only matters once a gate forces engagement. Cheapest test: ship
  the bounded-set wording for two weeks and watch the actioned-finding rate.
- **Should the gate apply to every PR?** A required check on trivial PRs that merge in
  nine minutes may cost more velocity than the defects it catches. Gating only the
  risky-path and `risk:T3` classes (§6.5) is the conservative first cut.
- **What is the real time-to-first-review at each tier?** The latency budget in §6.1 is
  built on one measured configuration (Sonnet 5, 643 s median). Haiku and Luna
  latencies on real diffs are unmeasured, and the whole fast-lane argument depends on
  them. Measure before committing thresholds.
- **Does `fast` hold on trivial PRs?** All one-call PRs ran Sonnet 5. Whether Haiku 4.5
  (73.3%) reaches the same verdicts is untested. Replay those diffs at both tiers.
- **Is `default` causal or a proxy for routing?** Shadow mode with a pinned model on
  unchanged routing settles it.
- **Should docs PRs enter the fix/recheck loop at all?** They converge worst (#1998).
  Their findings are real but constitute design negotiation. A review-only workflow may
  fit them better.
- **Should coverage widen?** 201 of 400 merged PRs saw no review at all — an author-scope
  gate. Out of scope here, but it dominates any projection.

---

## Sources

- [Anthropic model catalog](https://platform.claude.com/docs/en/about-claude/models/overview) — pricing, legacy status
- [Anthropic effort parameter](https://platform.claude.com/docs/en/build-with-claude/effort) — levels, guidance, caching constraint
- [OpenAI model catalog](https://developers.openai.com/api/docs/models) — GPT-5.6 family
- [CR-Bench](https://arxiv.org/html/2603.11078v1) — review precision/recall/SNR
- [SWE-bench Verified leaderboard](https://benchlm.ai/benchmarks/sweVerified) — Claude-family scores
