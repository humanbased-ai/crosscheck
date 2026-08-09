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

- **An `APPROVE` verdict now ends crosscheck's work on a PR.** ⚠️ Behavior change: previously, commits pushed after an approval opened a fresh review round. Now, once the newest verdict on a PR is `APPROVE`, no further step runs — `watch` skips later events on that PR, `crosscheck run` exits with `latest review is APPROVE — crosscheck is done with this PR`, and `crosscheck detect-step` reports the stop. Work that landed *after* the approval (a fix or conflict-resolve commit pushed past an APPROVE) is still finished. To force another pass, name the steps explicitly: `crosscheck run <pr-url> --steps review`.
- **`quality.mode` now defaults to `smart`.** ⚠️ On upgrade this is a **silent behavior change** for existing installs: a config that sets `quality.tier` but no `quality.mode` switches from one fixed tier to **per-PR selection**. The tier, effort, and step set now come from the class each PR matches against the versioned policy in `src/config/review-strategy.json` — a lockfile-only PR is skipped outright, a docs PR narrows to review with no fix loop, a PR touching auth or a migration is promoted to `thorough` — and rounds past the first escalate on measured non-convergence. To keep the previous behavior, add `mode: fixed` under `quality:`, or re-run `crosscheck onboard`, which reads the raw yaml and preserves a tier that was written before `mode` existed. Every review comment cites the strategy version, class, and tier it ran under.

### Added

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
