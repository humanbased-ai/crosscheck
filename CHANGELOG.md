# Changelog

All notable changes to crosscheck will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Changed (BREAKING)

- **Removed `crosscheck watch --only-review`.** ⚠️ Review-only is now a **per-repo** setting, not a session-global flag. To make a repo post reviews only (never fix, recheck, or resolve), run `crosscheck alter <owner>/<repo> --review-only`. Existing `crosscheck watch --only-review` invocations — systemd units, scripts, CI — will now **exit 1 with "unknown option"**; update them to the per-repo override. This removes a CLI flag present in released `0.18.0` and **requires a version bump before release**.
- **Per-repo workflow depth moved from config to files.** It is no longer a `repos[].steps` field in `crosscheck.config.yml`; each override lives in `~/.crosscheck/workflows/<owner>__<repo>.yml` (written by `crosscheck alter`) and *narrows* the global `~/.crosscheck/workflow.yml`. Overrides are read per PR event — live-reloaded, no `watch` restart.
- **Default pipeline is now `review → fix → recheck`.** The built-in default and the `crosscheck onboard` default are the full loop; scope down per repo with `crosscheck alter`.

### Changed

- **An `APPROVE` verdict now stops all further work on the commit it covers.** Once the newest verdict is `APPROVE` and its `sha=` matches the PR's HEAD, no further step runs on that commit — no recheck, no re-review. `watch` skips further events for that SHA, `crosscheck run` exits with `this commit is already approved — nothing to do until new commits land`, and `crosscheck detect-step` reports the stop (`stopReason: "approved"` in `--json`). `watch` now reads PR history on every event instead of routing from session caches, so an approval — or a verdict superseding one — posted by `kickass`, another `crosscheck run`, or a second watcher is honoured immediately rather than after a restart, and it defers the event rather than running blind when that history cannot be read. `crosscheck scan` and `crosscheck kickass` apply the same SHA scoping: a PR approved at an older commit is dispatched for a fresh review instead of being listed as merge-ready. Pushing new commits re-opens the PR: the approval no longer covers HEAD, so a fresh review round runs on the new code. Work that landed *after* the approval is still finished — a fix commit at HEAD gets its recheck, and a conflict-resolve merge commit gets a fresh review, since a merge brings in base content a recheck is instructed not to flag. To force a pass on the approved commit itself, name the steps explicitly: `crosscheck run <pr-url> --steps review`.
- **`quality.mode` now defaults to `smart`.** ⚠️ On upgrade this is a **silent behavior change** for existing installs: a config that sets `quality.tier` but no `quality.mode` switches from one fixed tier to **per-PR selection**. The tier, effort, and step set now come from the class each PR matches against the versioned policy in `src/config/review-strategy.json` — a lockfile-only PR is skipped outright, a docs PR narrows to review with no fix loop, a PR touching auth or a migration is promoted to `thorough` — and rounds past the first escalate on measured non-convergence. To keep the previous behavior, add `mode: fixed` under `quality:`, or re-run `crosscheck onboard`, which reads the raw yaml and preserves a tier that was written before `mode` existed. Every review comment cites the strategy version, class, and tier it ran under.

### Fixed

- **The separate-fix-PR fallback no longer fails in the two cases it exists for.** Logged runs show 43 fix PRs opened against 31 failures — the fallback failed roughly two times in five, and both causes were structural. **(1)** It opened the follow-up PR against the source PR's head branch, which is missing in precisely the situation that sends a fix down this path: the PR merged and GitHub deleted its branch. `pulls.create` rejected the missing base with `field: base, code: invalid` (19 occurrences) *after* the fix branch had already been pushed, so the fix was lost and the branch orphaned. Crosscheck now checks the base exists before pushing anything, and when it is gone it posts the fix as a diff on the original PR explaining why — a PR cut from the pre-merge snapshot would reintroduce whatever the merged version changed, which is the same hazard the superseded-auto-fix cleanup exists to prevent. **(2)** A fix branch left behind by an earlier round made a plain `git push` non-fast-forward, and the fix was lost with it (12 occurrences). The push now replaces the branch under `--force-with-lease`, stating the sha it expects to overwrite — safe because the branch is crosscheck's own artifact for one PR and this round's fix is built on the newer head, and the lease still refuses if anything other than crosscheck moved it. An open fix PR from that branch is updated in place rather than duplicated. New events: `fix_pr_skipped`, `fix_branch_replaced`, `fix_pr_updated`, `fix_branch_push_failed`.
- **A verdict is never posted against a commit the repository cannot resolve** ([#290](https://github.com/humanbased-ai/crosscheck/issues/290)). The `sha=` in a verdict annotation is read from the ephemeral clone's HEAD, which can hold a commit that never reached the remote — a fix commit whose push failed leaves the clone one commit ahead of the repo. A recheck on `monorepo#2444` stamped such a sha, and the `APPROVE` it carried cleared the previous round's `BLOCK` on code that was never reviewed; the PR merged with the flagged hole intact and the approval read as routine on the PR page. Before posting, crosscheck now asks the repo whether the reviewed sha resolves at all and whether it shares history with the PR head. If the commit is unknown to the repo, shares no history with the head, or cannot be checked, the verdict is refused rather than posted: the run fails with the reason, the review body is written to the log so the vendor work is not lost, the pending status releases as `failure`, and the PR stays blocked. A missing review is recoverable; an approval attributed to phantom code is not. A commit that *descends* from the PR head is still posted — that is the auto-fix-branch fallback, where the fix could not land on the PR branch — but it now logs `verdict_sha_off_head` so a verdict that does not cover HEAD is explicable from the log.
- **A failed clone is now classified by what went wrong, not by the URL it used.** The clone URL carries `x-access-token` as its literal username, and the redactor keeps that literal while hiding the value — so every failed clone contained the substring `token`, which the broad auth pattern matched. Any clone failure whatsoever was filed as an auth failure: the identical SSL error read `network` when it happened on a push (no URL in the message) and `auth` when it happened on a clone. Re-running the fixed classifier over 121 real logged error events reclassified **39 of them** — 32 to `timeout` (git's own `lowSpeedLimit` guard aborting a stalled transfer: *"Operation too slow. Less than 1000 bytes/sec"*) and 7 to `network` (`SSL_ERROR_SYSCALL`), while genuine `codex auth failure` entries stayed `auth`. `diagnose`, `optimize`, and the first-run failure breakdown were all pointing at credentials for what was really a stalling network. Two further miscategorisations surfaced while testing and are fixed with it: an SSH clone rejected with `Permission denied (publickey)` matched no auth pattern at all and landed in `subprocess`, and a `403` during clone was reported as `auth` rather than `permission` because the URL's token outranked the permission check.
- **Crosscheck commits credit the vendor that actually did the work.** All three commit subjects — fix in commit mode, the fix-PR commit, and conflict-resolve — ended in a hardcoded `— by Claude Code`, so a Codex-authored fix landed in git history under Claude's name while the `Crosscheck-Reviewer:` trailer on the same commit said `codex`. The subjects now take the active vendor, and the display name comes from one shared helper that the comment attribution footer uses too, so a card and the commit it describes cannot disagree. The `[crosscheck]` prefix and step word are unchanged — commit-cap counting and step-history detection parse those.
- **Conflicted PRs are resolved for the whole life of the PR, not just before the first review** ([#282](https://github.com/humanbased-ai/crosscheck/issues/282)). `conflict-resolve` was reachable only through the pre-review path, so once a PR had been reviewed it could never run again — and since a PR usually conflicts because the *base branch* moved, which fires no webhook, a conflicted PR sat untouched until someone ran `crosscheck resolve` by hand. `crosscheck scan` now reports `next=resolve` for a conflicted PR regardless of review state, `crosscheck kickass` dispatches it ahead of review/fix/recheck, and step detection routes to `conflict-resolve` whenever GitHub reports the PR as unmergeable. Fork PRs are skipped (crosscheck cannot push to them) and repos narrowed to `review`/`review,recheck` are unaffected, matching auto-fix.

### Added
- **`crosscheck adoption` — whether crosscheck is actually being used, from local logs** ([#202](https://github.com/humanbased-ai/crosscheck/issues/202)). npm download counts say nothing about whether a review ever ran. The new command reports the activation funnel (onboard started/completed/abandoned), usage counts (reviews, rechecks, blocking findings, fixes applied), weekly active repos, PR-open-to-verdict latency (median/p90/slowest), and first-run failure categories — the errors in sessions that never reached a verdict, which is what actually stops a new install. Three new events make this measurable rather than inferred: `onboard_started` and `onboard_completed` (with `outcome` and the stage a setup was abandoned at, so an abandoned onboard is visible instead of silent), and `blocking_finding_posted`. `review_complete` gains `open_to_verdict_ms`, threaded from the PR's own open time through all four review paths — omitted rather than guessed when an event carries no `created_at`, and reported separately as `unmeasured` so a real median is never mixed with invented ones. **Nothing is transmitted**: there is no endpoint, no account, and no network call in the collector or the reader — opt-in telemetry remains a design in `prd.md`, not shipped behaviour. Every field written to disk, and the list of what deliberately never is (source, diffs, prompts, review text, PR titles/bodies, author logins, secrets), is inventoried in [`docs/metrics.md`](docs/metrics.md).
- **[`docs/trust.md`](docs/trust.md) — the security and mutation model in one place** ([#199](https://github.com/humanbased-ai/crosscheck/issues/199)). Deciding whether to point crosscheck at a real repo previously meant reading the CLI. The doc answers, with the specifics rather than reassurance: the five destinations anything leaves for (and that your diff reaches Anthropic/OpenAI through *their* CLIs under *their* terms, not through a crosscheck upload path); that `watch`'s default tunnel puts a third-party relay in the webhook path, and that `crosscheck run` avoids it entirely; which token scope each command actually needs and why `repo` is coarse; how webhooks are registered, reused across restarts, removed on shutdown — and orphaned by an abnormal exit, with both ways to clear one; what each step can write, step by step, plus the boundaries that always hold (never merges, never touches the base branch, never force-pushes over your work) and the one boundary that is the vendor CLI's to enforce rather than crosscheck's; the read-only first run; three levels of turning auto-fix off; and what standard logs do and do not contain, including why `logs.extended` has no CLI flag.
- **`crosscheck alter <repo>`** (alias `alter-workflow`) — set a per-repo workflow override: `--steps review,fix,recheck`, `--review-only`, `--show`, `--reset`.
- **`crosscheck run --review-only`** — one-shot alias for `--steps review`.

---

## [0.10.0] — 2026-05-30

### Changed

- **Annotation contract v2** — review comments now embed structured metadata: `model=`, `type=`, `round=`, and `service=` fields alongside the existing `origin=`, `reviewer=`, and `verdict=`. New comments may append `sha=` with the PR head that was reviewed. Consumers parsing the `<!-- crosscheck: ... -->` tag must treat unknown field names as forward-compatible additions. The stable field prefix is `origin reviewer model type round verdict service`.
- **`isFreshReviewComment` delegates to annotation parser** — classification now reads the footer `type=` field directly; unknown explicit types are treated as non-reviews rather than defaulting to review. Pre-`type=` era annotations fall back to the header/recheck-prefix heuristic for backward compatibility.
- **Model-aware review headers** — `### Code Review by 🤖 Claude Code` now includes the resolved model in parentheses when a non-default model is used (e.g. `### Code Review by 🤖 Claude Code (Opus 4.7)`).
- **Commit trailers** — fix and conflict-resolve commits now include `Crosscheck-Reviewer`, `Crosscheck-Model`, `Crosscheck-Step`, and `Crosscheck-Service` git trailers for provenance.

### Fixed

- **`origin` field in `crosscheck review` annotations** — the detected PR origin (`claude`/`codex`/`human`) is now correctly threaded into the posted annotation; previously `origin=human` was always emitted regardless of detection result.
- **Haiku model ID** — restored the canonical dated alias `claude-haiku-4-5-20251001` for the `fast` quality tier.

---

## [0.2.0] — 2026-05-08

### Added

- **Structured debug logs** at `~/.crosscheck/logs/` — one NDJSON file per UTC day, configurable retention (default 7 days, max 30), toggle off with `logs.enabled: false` in config. Every PR event, review start/complete, and error is recorded.
- **Error classification** in the logger — errors are bucketed into `auth | permission | rate_limit | timeout | network | subprocess | unknown` for faster diagnosis.
- **`crosscheck status` — Logs section** showing whether logging is enabled, log directory path, retention, and today's file size.
- **Review verdict banner** — the first line of each PR comment now shows a coloured verdict badge (`✅ APPROVE`, `⚠️ NEEDS WORK`, `🚫 BLOCK`) parsed from the reviewer's last output line.
- **Fortune cookie welcome** — `crosscheck serve` prints a rotating one-liner on startup.
- **Elapsed-time counter** on the review spinner — shows seconds since the review started so you know it is still working.
- **`crosscheck watch` — localhost.run SSH tunnel** replaces the previous smee.io dependency. No account needed; works behind NAT.
- **`crosscheck serve`** — `EADDRINUSE` is caught and reported with a clear error instead of an unhandled exception crash.

### Fixed

- **Base-branch missing in shallow clone** — `git fetch origin <base>:<base>` is now run after PR checkout, so Codex can diff against the correct base (was causing `fatal: no such branch: 'staging'` failures silently).
- **GitHub token resolution** — token is now resolved from `gh auth login` keyring when `GITHUB_TOKEN` env var is absent; resolved token is pinned into every subprocess call so a stale env var cannot shadow a valid keyring credential.
- **`crosscheck status` / `crosscheck init`** — `GITHUB_TOKEN` now shows ✓ when `gh auth login` covers it (previously showed ✗ even when authentication was fully functional).
- **Webhook scope-error misclassification** — HTTP status is embedded in webhook error messages; the scope-failure regex is broadened to catch real GitHub error strings (`admin:org`, `write:org`, `resource not accessible`, etc.).
- **Codex terminal output on failure** — the review spinner now shows one actionable error line (e.g. `fatal: no such branch: 'main'`) instead of dumping the full Codex session trace.
- **Codex running build tools in temp clone** — Codex is instructed not to run `tsc`, `npm`, `yarn`, `jest`, etc., since those tools are not available in the temporary clone. `node_modules/.bin` is also added to PATH so local tools are findable when `node_modules` does exist.
- **Log entry bloat** — messages are capped at 2 000 chars and stacks at 1 000 chars to prevent 200 KB log entries from Codex failures.
- **Process-level error coverage** — `uncaughtException` and `unhandledRejection` handlers write to the log before printing and exiting, so crashes leave a trace.

### Changed

- `crosscheck.config.yml` — added `logs:` section with `enabled` and `retention_days` fields (both have defaults; existing configs continue to work unchanged).
- `crosscheck watch` — webhook registration error hint now suggests `gh auth refresh -s admin:org` for scope failures.

---

## [0.1.0] — 2025

### Initial release

#### Commands

- **`crosscheck init`** — Environment check and config generation. Verifies that required CLI tools (`gh`, `claude`, `codex`) are installed and authenticated, then writes a starter `crosscheck.config.yml` with sensible defaults.

- **`crosscheck review <pr-url>`** — Manual one-shot PR review. Clones the target repo, checks out the PR branch, and dispatches the review to the configured AI reviewer. Accepts `--reviewer codex|claude` to force a specific vendor, bypassing auto-detection.

- **`crosscheck watch`** — Local dev mode with auto-managed smee.io tunnel. Registers a temporary GitHub webhook on the current repo, listens for `pull_request` events, and automatically deduplicates in-flight reviews so the same PR is never reviewed twice concurrently.

- **`crosscheck serve`** *(BETA)* — Always-on webhook server for mac-mini or home-server deployments. Accepts incoming GitHub webhook payloads directly (no smee tunnel), handles deduplication, and keeps running until `SIGINT`.

- **`crosscheck status`** — Auth and config snapshot. Displays the current authentication state for GitHub (`gh`), Claude Code, and Codex, alongside a summary of the active config file.

#### Core features

- **Cross-vendor mode** — When both Codex and Claude Code are configured, crosscheck auto-detects the origin of each PR (e.g. Codex-generated vs human-authored) and routes to the appropriate reviewer for reciprocal review.

- **Single-vendor mode** — Works with only one reviewer configured; routes all PRs to the available vendor.

- **Subscription auth support** — Supports both API-key and subscription (OAuth/browser-based) authentication for Claude Code and Codex, so teams without pay-as-you-go billing can still use crosscheck.

- **Quality tiers** — Configurable review depth (`light`, `standard`, `thorough`) with per-review USD budget cap for API-key modes.

- **Webhook deduplication** — In-flight review keys (`owner/repo#pr@sha`) prevent duplicate reviews from rapid-fire webhook deliveries.

- **GitHub PR comment posting** — Review output is posted directly as a PR review comment via the GitHub API using Octokit.
