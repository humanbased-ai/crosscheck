<div align="right">
  <h5><a href="./get-started.zh.md">🌏 &nbsp;中文</a></h5>
</div>

# crosscheck — Get Started

## Table of contents

- [Prerequisites](#prerequisites)
- [Install](#install)
- [Environment variables](#environment-variables)
- [Step 1 — Check your setup](#step-1--check-your-setup)
- [Step 2 — Get one useful review](#step-2--get-one-useful-review)
- [Step 3 — Choose a deployment mode](#step-3--choose-a-deployment-mode)
- [Step 4 — Verify it's working](#step-4--verify-its-working)
- [Commands](#commands)
  - [init](#crosscheck-init)
  - [onboard](#crosscheck-onboard)
  - [review](#crosscheck-review-pr-urls)
  - [run](#crosscheck-run-pr-urls)
  - [recheck / fix / resolve](#crosscheck-recheck--fix--resolve-pr-urls)
  - [Multi-PR syntax](#multi-pr-syntax)
  - [watch](#crosscheck-watch)
  - [status](#crosscheck-status)
  - [diagnose](#crosscheck-diagnose)
  - [optimize](#crosscheck-optimize)
  - [impact](#crosscheck-impact)
  - [issue](#crosscheck-issue)
- [Configuration](#configuration)
- [How it works](#how-it-works)
- [Post-review auto-fix](#post-review-auto-fix)
- [FAQ](#faq)

---

## Prerequisites

You need GitHub CLI and at least one authenticated AI reviewer CLI before crosscheck can run a one-shot review. Install both Claude Code and Codex only if you want cross-vendor review routing.

### Claude Code

```bash
npm install -g @anthropic-ai/claude-code
claude   # follow prompts to sign in to claude.ai
```

Requires a Claude Pro or Max plan. Reviews use your subscription quota — no per-token API billing.

### Codex

```bash
npm install -g @openai/codex
codex login --device-auth   # OAuth sign-in with your ChatGPT account
```

Requires a ChatGPT Plus or Pro plan. When authenticated via `--device-auth`, reviews run against your subscription — no API key needed.

If you prefer to use an OpenAI API key instead:

```bash
printenv OPENAI_API_KEY | codex login --with-api-key
```

Then set `auth: api-key` in your config to enable model selection.

### GitHub CLI

```bash
brew install gh       # macOS
gh auth login
```

Used for cloning PR branches and (in watch mode) registering webhooks automatically.

---

## Install

**Stable (recommended):**

```bash
npm install -g @humanbased/crosscheck
```

**Beta (latest features, may have rough edges):**

```bash
npm install -g @humanbased/crosscheck@beta
```

**npx — no install:**

```bash
npx @humanbased/crosscheck <command>
npx @humanbased/crosscheck@beta <command>
```

**From source:**

```bash
git clone https://github.com/humanbased-ai/crosscheck
cd crosscheck
npm install && npm run build && npm link
```

---

## Environment variables

### GitHub auth — two options (pick one)

**Option 1 — gh CLI (recommended):** authenticate once and crosscheck picks up the token automatically:

```bash
gh auth login
```

**Option 2 — Personal access token:** useful in CI or if you prefer an explicit token:

```bash
export GITHUB_TOKEN=ghp_...
```

A classic PAT needs `repo` and `admin:org_hook` scopes (org-level webhooks require `admin:org_hook`; repo-level only needs `repo`).
Generate one at [github.com/settings/tokens](https://github.com/settings/tokens).

If both are present, crosscheck prefers the `gh` keyring token (always fresh) and uses `GITHUB_TOKEN` as a fallback.

### Webhook secret — auto-managed

`CROSSCHECK_WEBHOOK_SECRET` is **optional**. If you don't set it, crosscheck generates a random secret on first use and saves it to `~/.crosscheck/webhook-secret` (readable only by you). It's reused automatically on every subsequent run.

To retrieve it later (e.g. to register a webhook manually):

```bash
cat ~/.crosscheck/webhook-secret
```

To use your own secret instead, set it in your shell profile:

```bash
export CROSSCHECK_WEBHOOK_SECRET=your-secret
```

### Linear API key — for issue enrichment (optional)

`LINEAR_API_KEY` is only read when `issue_enrichment.enabled: true` (see
[Issue enrichment](#issue-enrichment)). It lets crosscheck fetch the linked
Linear issue so the review is anchored to the ticket's stated goal. A read-only
personal API key is enough — create one under Linear → Settings → API.

```bash
export LINEAR_API_KEY=lin_api_...
```

If it's unset while enrichment is on, crosscheck just skips enrichment and
reviews the diff as usual — it never errors.

---

## Step 1 — Check your setup

```bash
crosscheck status
```

`crosscheck status` prints the active config path, GitHub auth source, usable reviewer CLIs, webhook-secret handling, and current logs. A webhook secret is auto-managed for `watch`, so it does not need to be set before a one-shot review.

If you prefer to create a starter config without the full wizard:

```bash
crosscheck init
```

## Step 2 — Get one useful review

Before using a production PR, run the public fixture from the Humanbased field report:

```bash
crosscheck review https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1 --reviewer codex
```

This clones the PR branch, runs Codex review against the base branch, and posts a comment to the PR. Use `--reviewer claude` if Claude Code is your authenticated reviewer. Once the fixture produces a useful verdict, run the same command against one low-risk PR from your own repo:

```bash
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
```

If this step fails, fix the specific auth, clone, reviewer, or comment-posting error before enabling `watch`.

## Step 3 — Choose a deployment mode

After one-shot review works, run the guided setup:

```bash
crosscheck onboard
```

`crosscheck onboard` checks your CLIs, walks you through deployment mode, repo selection, review mode, workflow pipeline, and connection settings, then writes a ready-to-use config. See the [`crosscheck onboard`](#crosscheck-onboard) command reference for the full walkthrough.

Once it completes, go straight to `crosscheck watch`. There is no separate init step required.

> If you prefer to skip the wizard and configure manually, run `crosscheck init` to generate a starter config, then edit `~/.crosscheck/config.yml` directly.

### Personal vs team

On first run, `crosscheck watch` will ask how you're using it:

```
How are you using crosscheck?

  [1] personal  — monitor all your repos and orgs; review only PRs you author
  [2] team      — monitor org repos only; review all PRs from any author

  Choice [1]:
```

The choice is saved to `crosscheck.config.yml` as `deployment: personal` or `deployment: team`.

**Personal mode** (default, recommended for individuals)
- Monitors all repos under your personal GitHub account + all orgs you belong to
- Only reviews PRs you authored — ignores everyone else's
- Sets `routing.allowed_authors` to your GitHub login automatically

**Team mode** (recommended for shared machines)
- Monitors all orgs you belong to (no personal repos)
- Reviews all PRs from any author — no author filter applied

You can override the saved choice for a single session without touching the config:

```bash
crosscheck watch --personal   # personal mode this session only
crosscheck watch --team       # team mode this session only
crosscheck watch --port 8080  # force a specific webhook port this session (overrides config; not saved)
```

`--port <n>` forces the local webhook server onto that exact port for this session
without editing `server.port` in config — useful for running a second instance or
avoiding a port already in use. If the port is taken, `watch` exits with an error.

To re-run the prompt and permanently change your choice:

```bash
crosscheck watch --reconfigure
```

### Watch mode — for your development machine

Starts a local server and opens a tunnel via `localhost.run` (SSH, no install needed) so GitHub can reach your laptop. Registers webhooks automatically. Supports org-level coverage or per-repo. Runs while your terminal is open.

```bash
# Monitor entire orgs (set in crosscheck.config.yml)
crosscheck watch

# Or run inside a repo — auto-detects from git remote
cd /path/to/your/repo && crosscheck watch
```

```
crosscheck watch

  orgs      humanbased-ai, codatta
  mode      cross-vendor
  quality   balanced
  config    ./crosscheck.config.yml  ← edit to change above

  ✓ tunnel ready: https://abc123.lhr.life
  tunnel    https://abc123.lhr.life
  ✓ webhook registered for humanbased-ai

Waiting for PR events — Ctrl+C to stop.
```

When you press `Ctrl+C`, the SSH tunnel and any registered webhooks are cleaned up automatically.

**Token scope for org webhooks:** `GITHUB_TOKEN` needs `write:org` scope for org-level coverage. For repo-level, `repo` scope is sufficient.

**Review-only for a repo:** make a repo post reviews and nothing else with `crosscheck alter <repo> --review-only` — crosscheck never runs the fix, recheck, or conflict-resolve steps for it, and never pushes commits to its PRs:

```bash
crosscheck alter humanbased-ai/xny-monorepo --review-only
```

Each PR (and each new pushed SHA) on a review-only repo gets a fresh review comment; content that has already been reviewed at the current SHA is skipped. Use this when you want crosscheck's verdicts on a repo but want to apply fixes yourself. Review-only is a per-repo setting now — there is no global `--only-review` flag.

---

## Step 4 — Verify it's working

Open a PR (or push to an existing one). You should see:

1. A log line in your terminal when the event arrives
2. A code review comment posted to the PR within ~60 seconds

If it doesn't appear, run `crosscheck status` to check auth and config, then check your GitHub webhook delivery log at `Settings → Webhooks → Recent Deliveries`.

---

## Commands

### `crosscheck init`

Checks your environment and writes a starter config file.

```bash
crosscheck init
crosscheck init --config /path/to/crosscheck.config.yml
```

What it checks: `codex` CLI, `claude` CLI, `gh` CLI, GitHub auth, and webhook-secret handling. The webhook secret is auto-managed at `~/.crosscheck/webhook-secret` for `watch`.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Write the config file to a specific path |

---

### `crosscheck onboard`

The recommended first-time setup command. Walks through ten steps interactively and writes a ready-to-use config.

```bash
crosscheck onboard
crosscheck onboard --yes          # accept all defaults non-interactively
crosscheck onboard --personal     # force personal mode for this session
crosscheck onboard --team         # force team mode for this session
crosscheck onboard --reconfigure  # re-run setup even if config already exists
```

**The ten steps:**

**Step 1 — Environment check.** Verifies codex CLI, claude CLI, gh CLI, and GitHub token. At least one AI CLI must be authenticated; gh auth is always required. Prints ✓/✗ with fix hints.

**Step 2 — Deployment mode.** Choose how crosscheck scopes itself:
- `personal` — monitors your personal repos + all orgs you belong to; reviews only PRs you author
- `team` — monitors org repos only; reviews all PRs from any author

**Step 3 — Repo selection.** Lists accessible repos and orgs; you pick which ones to watch. Org-level selection covers all repos in the org with one webhook.

**Step 4 — Review mode.** If both CLIs are available, choose:
- `cross-vendor` — Claude reviews Codex PRs; Codex reviews Claude PRs (recommended when using both agents)
- `single-vendor` — one AI reviews all PRs (default when only one CLI is installed)

**Step 5 — Primary author.** In personal cross-vendor mode, choose which agent usually authors your PRs so Crosscheck can route reviews to the other vendor.

**Step 6 — Review quality.** Choose the speed/thoroughness tier for review prompts and reviewer timeouts.

**Step 7 — Workflow pipeline.** Choose what happens after a review:

```
  [1] review only              — AI posts a comment; you handle fixes
  [2] review → fix             — AI reviews, then auto-applies fixes  (recommended)
  [3] review → fix → re-check  — full loop: review, fix, re-review to confirm
```

The `review → fix → re-check` option writes a `~/.crosscheck/workflow.yml` with all three pipeline steps configured.

**Step 8 — Fix -> recheck rounds.** When the full loop is selected, choose how many autonomous fix→recheck cycles Crosscheck can run before stopping. Each cycle is one fix commit followed by one recheck: `review → fix¹ → recheck¹ → fix² → recheck² → …`. Crosscheck drives these cycles automatically — no human push needed between rounds. A round stops early when the recheck returns `APPROVE`. The cap prevents runaway loops when issues resist automated fixing.

**Step 9 — Auto conflict-resolve.** Optionally add a merge-conflict resolution step before review.

**Step 10 — Connection type.** Choose how GitHub webhooks reach your local server:
- `localhost.run` — zero-config SSH tunnel; reconnects automatically, no install required *(default)*
- `smee.io` — webhook relay; events queued while offline, stable channel URL (requires `npm install -g smee-client` and `tunnel.smee_channel` in config)

**Step 11 — Git clone protocol.** Choose SSH or HTTPS for PR checkout.

**Step 12 — Review and write config.** Shows a summary of all choices and writes `~/.crosscheck/config.yml` and `~/.crosscheck/workflow.yml`.

```
crosscheck onboard

  Step 1 — environment check
  ✓ codex CLI            codex-cli 0.128.0 — authenticated
  ✓ claude CLI           2.1.x (Claude Code)
  ✓ gh CLI               gh version 2.65.0
  ✓ GITHUB_TOKEN         set (gh auth login)

  Step 2 — deployment mode
  [1] personal  [2] team
  Choice [1]: 1

  Step 3 — select repos to monitor
  [1] humanbased-ai (org · 12 repos)
  [2] codatta (org · 5 repos)
  [3] your-github-login (personal · 8 repos)
  Select [all]: 1,3

  Step 4 — review mode
  [1] cross-vendor  [2] single-vendor
  Choice [1]: 1

  Step 5 — primary author
  [1] Claude  [2] Codex  [3] both
  Choice [3]: 3

  Step 6 — review quality
  [1] fast  [2] balanced  [3] thorough
  Choice [2]: 2

  Step 7 — workflow pipeline
  [1] review only  [2] review → fix  [3] review → fix → re-check
  Choice [2]: 3

  Step 8 — fix → re-check rounds
  [1] 1 round  [2] 2 rounds  [3] 3 rounds
  Choice [1]: 1

  Step 9 — auto conflict-resolve
  [1] disabled  [2] enabled
  Choice [1]: 1

  Step 10 — connection type
  [1] localhost.run  [2] smee.io
  Choice [1]: 1

  Step 11 — git clone protocol
  [1] SSH  [2] HTTPS
  Choice [1]: 1

  Step 12 — review and write config
  deployment   personal
  connection   localhost.run
  clone        ssh
  orgs         humanbased-ai
  users        your-github-login (8 repos)
  mode         cross-vendor
  quality      balanced
  pipeline     review-fix-recheck
  max rounds   1
  conflict-resolve  no
  config       ~/.crosscheck/config.yml

  ✓ config written to ~/.crosscheck/config.yml
  ✓ workflow written to ~/.crosscheck/workflow.yml

  Next: run  crosscheck watch  to start reviewing PRs.
```

> **`crosscheck init` vs `crosscheck onboard`** — `init` is a lightweight environment check only (no repo selection, no pipeline prompt). Use it for a quick health check or in CI. `onboard` is the full first-time setup wizard.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Write the config to a specific path |
| `-y, --yes` | Accept all defaults without interactive prompts |
| `--personal` | Use personal deployment mode for this session only |
| `--team` | Use team deployment mode for this session only |
| `--reconfigure` | Re-run setup even if `deployment` is already set in config |

Onboard never touches per-repo workflow overrides written by `crosscheck alter` — those live in their own files under `~/.crosscheck/workflows/`.

---

### `crosscheck alter`

Sets the workflow depth for one repo without changing the global default. Writes a standalone file at `~/.crosscheck/workflows/<owner>__<repo>.yml` that narrows the global `~/.crosscheck/workflow.yml` for that repo only. Use it when one watcher should run different depths for different repos. `alter-workflow` is an alias.

```bash
crosscheck alter humanbased-ai/xny-monorepo --review-only            # alias for --steps review
crosscheck alter github.com/humanbased-ai/xny-monorepo --steps review,fix
crosscheck alter https://github.com/humanbased-ai/xny-monorepo --steps review,fix,recheck
crosscheck alter humanbased-ai/xny-monorepo --show                   # print effective steps, no write
crosscheck alter humanbased-ai/xny-monorepo --reset                  # remove the override
```

| Flag | Description |
|---|---|
| `--steps <list>` | `review`, `review,fix`, or `review,fix,recheck` |
| `--review-only` | Alias for `--steps review` |
| `--show` | Print the repo's effective steps without writing |
| `--reset` | Remove the override; revert to the global default |

Accepted repo formats: `owner/repo`, `github.com/owner/repo`, and `https://github.com/owner/repo`. Changes apply on the next PR event — no need to restart a running `crosscheck watch`.

---

### `crosscheck review <pr-urls...>`

Manually triggers a review for one or more PRs. The PR argument accepts the [multi-PR spec syntax](#multi-pr-syntax) — comma-separated URLs, bare numbers, and ranges. When more than one PR is selected they are reviewed concurrently (one agent per PR by default).

```bash
crosscheck review https://github.com/owner/repo/pull/123
crosscheck review https://github.com/owner/repo/pull/123 --reviewer codex
crosscheck review https://github.com/owner/repo/pull/123 --reviewer claude

# multiple PRs in the same repo (comma list and ranges)
crosscheck review https://github.com/owner/repo/pull/245,255
crosscheck review https://github.com/owner/repo/pull/245-256

# PRs across different repos
crosscheck review https://github.com/owner/repo/pull/245,https://github.com/other/repo/pull/210
```

| Flag | Description |
|---|---|
| `-r, --reviewer codex\|claude` | Skip auto-detection and force a specific reviewer |
| `--vendor codex\|claude` | Alias for `--reviewer` |
| `--concurrent [n]` | Multi-PR: cap parallel agents; omit `n` for one agent per PR (default) |
| `--sequential` | Multi-PR: run PRs one at a time instead of in parallel |
| `--stagger <ms>` | Multi-PR: delay between concurrent worker starts (default 2000) |
| `-c, --config <path>` | Use a specific config file |

---

### `crosscheck run <pr-urls...>`

Runs the configured workflow against one or more PRs: review → (fix → recheck) × `max_rounds`. The PR argument accepts the [multi-PR spec syntax](#multi-pr-syntax). Without `--steps`, `detect-step` determines where to resume from live PR history (skipping steps already completed for the current HEAD), then runs all remaining steps from that point. Pass `--steps` explicitly to restrict to specific steps.

Loops autonomously through fix→recheck cycles up to the `max_rounds` value configured in `workflow.yml` (default: 1). Use `--crazy` (loop until `APPROVE`) or `--half-crazy` (loop until not `BLOCK`) to bypass `max_rounds` entirely.

When the spec selects more than one PR, each PR runs in its own subprocess and they execute concurrently (one agent per PR by default). Use `--concurrent <n>` to cap parallelism, or `--sequential` to run one at a time.

```bash
crosscheck run https://github.com/owner/repo/pull/123
crosscheck run https://github.com/owner/repo/pull/123 --reviewer claude
crosscheck run https://github.com/owner/repo/pull/123 --fixer claude
crosscheck run https://github.com/owner/repo/pull/123 --vendor claude
crosscheck run https://github.com/owner/repo/pull/123 --steps review,fix
crosscheck run https://github.com/owner/repo/pull/123 --dry-run
crosscheck run https://github.com/owner/repo/pull/123 --crazy   # loop until APPROVE
crosscheck run https://github.com/owner/repo/pull/123 --halfcrazy

# multiple PRs, run concurrently
crosscheck run https://github.com/owner/repo/pull/245,255
crosscheck run https://github.com/owner/repo/pull/245-256
crosscheck run https://github.com/owner/repo/pull/245,https://github.com/other/repo/pull/210
crosscheck run https://github.com/owner/repo/pull/245-256 --concurrent 3
```

The workflow executed is loaded from `.crosscheck/workflow.yml` in the operator repo root if present, then `~/.crosscheck/workflow.yml`, and otherwise falls back to the built-in default pipeline: review, then fix when the verdict is not `APPROVE`. Use `crosscheck run` to test your full pipeline end-to-end against a real PR.

| Flag | Description |
|---|---|
| `-r, --reviewer codex\|claude` | Force review/recheck steps to use this vendor; skip auto-detection for review routing |
| `--fixer codex\|claude` | Force fix steps to use this vendor |
| `--vendor codex\|claude` | Force review, recheck, and fix steps to use this vendor |
| `--steps <list>` | Run only the listed step types, comma-separated: `review`, `fix`, `recheck` |
| `--dry-run` | Run the review but do not post a comment or apply fixes |
| `--expected-head-sha <sha>` | Skip if the PR head changed since the command was queued (single PR only) |
| `--crazy` | After the initial run, loop fix→recheck until APPROVE (ceiling: 2 rounds) |
| `--halfcrazy` | After the initial run, loop until verdict is not BLOCK — stops at NEEDS\_WORK or APPROVE |
| `--concurrent [n]` | Multi-PR: cap parallel agents; omit `n` for one agent per PR (default) |
| `--sequential` | Multi-PR: run PRs one at a time instead of in parallel |
| `--stagger <ms>` | Multi-PR: delay between concurrent worker starts (default 2000) |
| `-c, --config <path>` | Use a specific config file |

---

### `crosscheck recheck` / `fix` / `resolve <pr-urls...>`

Force a single workflow step against one or more PRs, bypassing next-step auto-detection. Each is equivalent to `crosscheck run <spec> --steps <type>` but as a first-class command, and each accepts the same [multi-PR spec syntax](#multi-pr-syntax) and concurrency flags as `run`.

| Command | Forces | Equivalent |
|---|---|---|
| `crosscheck recheck <spec>` | the `recheck` step (re-evaluate against the latest review) | `run <spec> --steps recheck` |
| `crosscheck fix <spec>` | the `fix` step (apply fixes for the latest review) | `run <spec> --steps fix` |
| `crosscheck resolve <spec>` | the `conflict-resolve` step (resolve merge conflicts) | `run <spec> --steps conflict-resolve` |

```bash
crosscheck recheck https://github.com/owner/repo/pull/245
crosscheck fix https://github.com/owner/repo/pull/245,255 --fixer claude
crosscheck resolve https://github.com/owner/repo/pull/245-256 --vendor claude
```

When the named step is not present in the active `workflow.yml`, `recheck` and `conflict-resolve` are synthesized with built-in defaults so the command still runs. `resolve` only supports `claude` (Codex conflict resolution is not yet supported); pass `--vendor claude` if the PR's assigned reviewer is Codex.

---

### Multi-PR syntax

The `run`, `review`, `recheck`, `fix`, and `resolve` commands accept a single PR URL or a **spec** that expands to many PRs. A spec is a comma-separated list of tokens:

| Token | Meaning | Example |
|---|---|---|
| Full PR URL | one PR; also sets the repo for following bare tokens | `https://github.com/owner/repo/pull/245` |
| Bare number | one PR in the most recent repo | `255` |
| Range `N-M` | inclusive range of PR numbers (in a URL tail or bare) | `245-256` |

```bash
# two PRs in the same repo
.../pull/245,255

# an inclusive range
.../pull/245-256

# PRs across different repos (each full URL switches repo)
.../owner/repo/pull/245,https://github.com/other/repo/pull/210

# mix and match
.../owner/repo/pull/245-247,250,https://github.com/other/repo/pull/3
```

Rules: the first token must be a full URL (a bare number with no preceding repo is an error), duplicate PRs are de-duplicated, and a spec may expand to at most 100 PRs. Multiple PRs run concurrently by default — control parallelism with `--concurrent <n>` / `--sequential` / `--stagger <ms>`.

---

### `crosscheck scan`

Scans monitored open PRs and shows which crosscheck workflow state each PR is in.

```bash
crosscheck scan
crosscheck scan --tidy
crosscheck scan --force --stale-after 2h
crosscheck scan --json
```

| Flag | Description |
|---|---|
| `--tidy` | Show only stale PRs that need attention |
| `--force` | Bypass the short-lived scan cache |
| `--stale-after <duration>` | Treat PRs as stale after a duration like `30m`, `2h`, or `1d` |
| `--json` | Emit raw scan data for scripts |

---

### `crosscheck kickass`

Selects all actionable PRs (any PR where a next step is needed: review, fix, recheck) and advances each one. Stale PRs are shown first. APPROVE PRs appear as a read-only "needs merge (manual)" section — visible so you know what's ready, but not dispatched automatically. The command revalidates the PR head before each mutation and prints an execution summary when it finishes.

Each PR dispatch uses `detect-step` to read live PR comment history and advances **exactly the next needed step** — kickass drives one step per PR, then `watch` picks up continuation via the webhooks that step produces.

```bash
crosscheck kickass --dry-run
crosscheck kickass --force --stale-after 2h
crosscheck kickass --crazy        # loop fix→recheck until APPROVE (ceiling: 2 rounds)
crosscheck kickass --halfcrazy    # loop until verdict is not BLOCK
```

| Flag | Description |
|---|---|
| `--dry-run` | Print the selected actions without mutating PRs |
| `--force` | Bypass the short-lived scan cache |
| `--stale-after <duration>` | Only show PRs stale for at least this duration |
| `--crazy` | Autonomous loop: keep running fix→recheck cycles until APPROVE (ceiling: 2 rounds per PR) |
| `--halfcrazy` | Autonomous loop: keep running until verdict is not BLOCK — NEEDS\_WORK is acceptable |

#### `kickass` + `watch` combo

When a batch of PRs is stuck — timed out, or stopped before `watch` was running — use both commands together for hands-free recovery:

```bash
# terminal 1 — keep running to handle continuations
crosscheck watch

# terminal 2 — kick each stuck PR one step forward
crosscheck scan --force
crosscheck kickass
```

How they divide the work:

```
crosscheck kickass
  └─ ck run <url>  --trigger kickass  (one step; detect-step finds where to start)
       └─ detect-step → "review"      run review only → posts comment
       └─ detect-step → "fix"         run fix only → pushes commit
       └─ detect-step → "recheck"     run recheck only → posts verdict

crosscheck watch
  ├─ issue_comment (type=review) → pick up fix step automatically
  └─ fix commit done → auto-loop to next fix→recheck round (up to max_rounds)
```

> **Note:** `ck run <url>` invoked directly (without `--trigger kickass`) runs the **full remaining pipeline** from the detected starting step. The one-step behaviour above applies only when kickass dispatches it.

`kickass` advances each PR exactly one step using live `detect-step` detection. `watch` owns all continuation via webhooks:

- A posted review fires an `issue_comment` webhook → `watch` starts the fix step.
- After a fix commit, `watch` automatically triggers the next fix→recheck round (up to `max_rounds` cycles). No human push needed between rounds.

No second `kickass` run is needed. Once `kickass` kicks the first step, the pipeline advances on its own as long as `watch` is running. (Introduced in [#193](https://github.com/Motivation-Labs/crosscheck/pull/193).)

---

### `crosscheck watch`

Local dev mode. Auto-creates a smee.io tunnel, registers the webhook, cleans up on exit.

```bash
cd /path/to/your/repo
crosscheck watch
```

Uses `localhost.run` (SSH) to open a public tunnel — SSH is pre-installed on macOS/Linux, no extra install or account needed. Requires `GITHUB_TOKEN` with `write:org` scope for org-level coverage, or `repo` scope for repo-level.

| Flag | Description |
|---|---|
| `-c, --config <path>` | Use a specific config file |
| `--personal` / `--team` | Override the saved deployment mode for this session only |
| `--reconfigure` | Re-run deployment setup and save the new choice |
| `--backtrace` / `--no-backtrace` | Force on/off the startup scan for unreviewed open PRs |

---

### `crosscheck status`

Shows auth state, config summary, and CLI versions.

```bash
crosscheck status
```

```
crosscheck status

  Auth
  ✓ codex                  authenticated
  ✓ claude                 2.1.x (Claude Code)
  ✓ GITHUB_TOKEN           via gh auth login
  ✓ WEBHOOK_SECRET         auto-managed at ~/.crosscheck/webhook-secret

  Config
    mode                   cross-vendor
    quality tier           balanced
    codex auth             subscription
    claude model           sonnet
    per-review budget      $2.00/review

  Impact
    summary                47 reviews · ~43h saved · 19 issues caught
                           (run crosscheck impact for details)

  Logs
    path                   ~/.crosscheck/logs/
    today                  2026-05-08.ndjson  (12 entries)

  CLIs
    codex                  codex-cli 0.128.0
    claude                 2.1.x (Claude Code)
```

| Flag | Description |
|---|---|
| `-c, --config <path>` | Check status against a specific config file |

---

### `crosscheck diagnose`

Reads `~/.crosscheck/logs/` and surfaces failure patterns, reviewer performance, and improvement suggestions.

```bash
crosscheck diagnose
crosscheck diagnose --since 2026-05-01
crosscheck diagnose --json
```

```
crosscheck diagnose

  Period   2026-05-07 → 2026-05-08  (1 log file)

  Reviews
    total       6
    successful  3
    failed      3  (50% failure rate)

  Reviewer performance
    codex    1/4 success  25%
    claude   2/2 success  100%

  Verdict distribution
    APPROVE     2  (67%)
    NEEDS WORK  1  (33%)
    BLOCK       0  (0%)

  Error patterns
    ✗ command not found: tsc                    ×2  (codex)
    ✗ base branch missing: staging              ×2

  Languages detected
    typescript, nodejs

  Suggestions
    → tsc: command not found ×2 (codex)
      add to workflow.yml review step instructions: "Do not run tsc, ts-node, or tsx."
    → base branch 'staging' not found ×2 — verify branch is fetched before review

  Run `crosscheck optimize` to apply suggestions automatically.
```

| Flag | Description |
|---|---|
| `--json` | Output full report as JSON (for scripting or piping to `optimize`) |
| `--since <YYYY-MM-DD>` | Limit analysis to logs from this date onward |

---

### `crosscheck optimize`

Runs `diagnose` internally, selects the best available AI agent, and generates improved instructions for the review step in `~/.crosscheck/workflow.yml`. Dry-run by default — shows a diff without writing.

```bash
crosscheck optimize             # show diff only
crosscheck optimize --apply     # apply the changes
crosscheck optimize --agent codex --apply
```

```
  Running diagnose...
  agent    claude  (default — both enabled, no data)

  diff  /Users/you/.crosscheck/workflow.yml (review step)

  +## Constraints
  +
  +- Do not run tsc, ts-node, or tsx.
  +- Do not run npm, npx, yarn, or pnpm.
  ...

  Run with --apply to write changes to /Users/you/.crosscheck/workflow.yml (review step)
```

**Which agent does `optimize` use?**

`optimize` picks the agent automatically based on your config and log history:

1. If only one vendor is enabled → uses that one.
2. If both are enabled → uses whichever has the higher success rate in recent logs.
3. If rates are equal or no log data → defaults to `claude`.
4. `--agent claude|codex` overrides all of the above.

| Flag | Description |
|---|---|
| `--apply` | Write the improved instructions to the review step in `~/.crosscheck/workflow.yml` (default is dry-run) |
| `--dry-run` | Show diff without writing (default behavior, explicit alias) |
| `--agent <claude\|codex>` | Force a specific agent regardless of config or log data |
| `--since <YYYY-MM-DD>` | Limit the diagnose window used as input |
| `-c, --config <path>` | Config file path |

---

### `crosscheck impact`

Reports cumulative value from review history: time saved, issues caught, and code quality trends. Reads from `~/.crosscheck/logs/` — no network calls.

```bash
crosscheck impact
crosscheck impact --money
crosscheck impact --since 2026-01-01
crosscheck impact --json
```

```
crosscheck impact  (all time · 47 reviews)

  Time saved
  ──────────────────────────────────────────────
  Reviews run              47
  Avg AI review time       ~14 min
  Assumed human time       60 min  ⓘ
  Total time saved         ~43 h

  Issues caught
  ──────────────────────────────────────────────
  APPROVE              28   (60%)
  NEEDS WORK           14   (30%)  ← actionable feedback
  BLOCK                 5   (11%)  ← potential bugs / breaking changes
  Total issues caught  19

  Code quality trend  (BLOCK rate, weekly)
  ──────────────────────────────────────────────
  May W1    ████████████████  22%
  May W2    ████████████      17%
  May W3    ████████          11%   ↓ improving

  ⓘ assumes 60 min avg human review — set impact.assumed_human_review_minutes to adjust
  Run crosscheck impact --money for a rough monetary estimate.
```

| Flag | Description |
|---|---|
| `--money` | Append a monetary estimate based on `impact.hourly_rate_usd` and `impact.defect_cost_usd` |
| `--since <YYYY-MM-DD>` | Limit the analysis to logs from this date onward |
| `--json` | Output the full report as JSON |
| `-c, --config <path>` | Config file path |

The monetary estimate formula: `(hours_saved × hourly_rate_usd) + (issues_caught × defect_cost_usd)`. Defaults: `$150/hr`, `$150/issue`. Both configurable in `crosscheck.config.yml` under `impact`.

---

### `crosscheck issue`

Reads recent error logs, uses your best-performing AI agent to draft a GitHub issue, asks three short follow-up questions, and submits to `humanbased-ai/crosscheck` after you confirm. No manual log-digging or issue writing required.

```bash
crosscheck issue               # interactive — review draft before submitting
crosscheck issue --dry-run     # print draft only, never submit
crosscheck issue --yes         # submit immediately after displaying draft
crosscheck issue --since 2026-05-01
```

```
crosscheck issue

  Scanning logs (last 3 days)...
  Found error pattern: command_not_found: tsc  ×4  (codex)

  Can you reproduce this consistently?
    [1] Every time  [2] Sometimes  [3] Happened once
  Choice [1]: 1

  Which command triggered this?
    [1] watch  [2] serve  [3] review  [4] Unknown
  Choice [1]: 1

  Is this blocking you?
    [1] Blocked  [2] Degraded  [3] Cosmetic
  Choice [2]: 2

  Draft issue:
  ────────────────────────────────────────────────────────
  TITLE: codex: command not found: tsc during review in temp clone

  ## Description
  When crosscheck runs a Codex review, the reviewer tries to execute `tsc`
  ...

  Submit to humanbased-ai/crosscheck? [y/N]: y
  ✓ https://github.com/humanbased-ai/crosscheck/issues/99
```

If no errors are found in recent logs, crosscheck prints `No errors found in recent logs — nothing to report` and exits cleanly.

| Flag | Description |
|---|---|
| `--since <YYYY-MM-DD>` | Limit log scan to this date onward (default: last 3 days) |
| `--dry-run` | Print the draft without submitting |
| `-y, --yes` | Submit immediately after displaying the draft (skip confirmation) |
| `-c, --config <path>` | Config file path |

---

## Customization home

`~/.crosscheck/` is the persistent home for everything crosscheck learns and configures. Back it up before a machine migration and a reinstall is instant — run `crosscheck onboard` and press Enter through each step to confirm your previous settings.

### Files in `~/.crosscheck/`

| File | Written by | Read by | Purpose |
|---|---|---|---|
| `config.yml` | `onboard`, `init`, `watch` (first run) | all commands | Main config — deployment, repos, mode, vendors, quality, tunnel, routing, budget, branding |
| `workflow.yml` | `onboard` (first run only) | `watch`, `run` | Global pipeline steps with per-step inline instructions. Written once on first onboard; never overwritten on re-runs — edit freely |
| `webhook-secret` | auto-generated on first use | `watch` | HMAC secret for GitHub webhook signature verification — reused across restarts |
| `logs/YYYY-MM-DD.ndjson` | `watch` | `diagnose`, `optimize`, `impact`, `issue` | Structured review event log, one file per day |

### Per-project overrides (checked before the global files)

| File | Read by | Purpose |
|---|---|---|
| `.crosscheck/workflow.yml` *(in repo)* | `watch`, `run` | Per-project pipeline — takes priority over `~/.crosscheck/workflow.yml` |
| `.crosscheck/AGENT.md` *(in repo)* | `optimize` | Per-project harness — takes priority over bundled `AGENT.md` |
| `AGENT.md` *(bundled with crosscheck)* | `optimize` | Default harness — shipped with the package, always available as fallback |

### What `crosscheck onboard` owns vs. preserves

On re-runs, `onboard` updates only the fields it collected answers for. Everything else survives unchanged.

**Updated on every run:** `deployment`, `orgs`, `repos`, `mode`, `clone_protocol`, `vendors.*.enabled`, `vendors.*.effort`, `quality.tier`, `tunnel.*`, `post_review.auto_fix.*`

**Never touched by onboard:** per-repo overrides in `~/.crosscheck/workflows/` (owned by `crosscheck alter`), and `~/.crosscheck/workflow.yml` after its first write

**Initialised on first run, never overwritten:** `routing.allowed_authors`, `routing.author_routes`, `routing.fallback_reviewer`

**Never touched by onboard:** `quality.focus`, `quality.custom_prompt`, `budget.*`, `branding.*`, `server.*`, `logs.*`, `backtrace.*`, `workflow.yml` (after first write), harness files

---

## Configuration

crosscheck stores its config in `~/.crosscheck/config.yml` by default — persistent across projects, no per-repo file needed. It also looks in these locations (first found wins):

1. `~/.crosscheck/config.yml` ← **default location**
2. `./crosscheck.config.yml`
3. `./.crosscheck.yml`

If `~/.crosscheck/config.yml` exists, it wins over local project files. Pass `--config ./crosscheck.config.yml` when you deliberately want to test a project-local config.

Run `crosscheck init` to generate `~/.crosscheck/config.yml` with all options documented.

Logs are written to `~/.crosscheck/logs/YYYY-MM-DD.ndjson` and retained for 30 days by default.

### Full reference

```yaml
# ── Deployment ────────────────────────────────────────────────────────────────
# Set automatically on first run. Re-run the prompt with: crosscheck watch --reconfigure
# personal — monitor your repos + orgs; review only your PRs
# team     — monitor org repos only; review all PRs from any author
# deployment: personal

# ── Mode ──────────────────────────────────────────────────────────────────────
# single-vendor: one AI reviews all PRs
# cross-vendor:  Claude ↔ Codex review each other
mode: cross-vendor

# ── Clone protocol ────────────────────────────────────────────────────────────
# ssh   — git@github.com:owner/repo.git (uses local SSH keys)
# https — https://github.com/owner/repo.git (uses GitHub token)
# Pick https if you have multi-account SSH setup or your default SSH key
# cannot access target repos. Independent of `gh config get git_protocol`.
clone_protocol: ssh

# ── Vendors ───────────────────────────────────────────────────────────────────
vendors:
  codex:
    enabled: true
    auth: subscription      # subscription | api-key
    model: gpt-5.6-terra    # only used when auth: api-key
    # timeout_sec: 1200     # max seconds per CLI call; unset = tier-based (300/600/1200)

  claude:
    enabled: true
    model: sonnet           # haiku | sonnet | opus
    effort: medium          # low | medium | high | max
    # timeout_sec: 1200     # max seconds per CLI call; unset = tier-based (300/600/1200)

# ── Quality ───────────────────────────────────────────────────────────────────
quality:
  tier: balanced            # fast | balanced | thorough
  focus:                    # narrows review scope (optional)
    - security
    - types
    - performance
  custom_prompt: |          # appended to every review prompt
    Be concise. Flag only issues that would block a merge.

# ── Budget ────────────────────────────────────────────────────────────────────
budget:
  codex_monthly_usd: 20     # null = unlimited; only applies when auth: api-key
  per_review_usd: 2.00      # passed to claude --max-budget-usd

# ── Orgs — covers all repos in each org with one webhook ─────────────────────
orgs:
  - humanbased-ai
  - codatta

# ── Users — monitors all repos owned by personal GitHub accounts (non-org) ───
# At startup, crosscheck enumerates each user's repos and registers webhooks.
# Useful when your AI agents open PRs across many personal repos.
# Combines with `orgs` and `repos` — all configured sources are additive.
users:
  - beingzy           # your personal account
  # - my-agent-login  # a bot account that pushes to its own repos

# ── Repos — for monitoring specific repos only ────────────────────────────────
# Omit when using `orgs`/`users`. Auto-detected from git remote if all are empty.
# To run one repo at a narrower workflow depth, do NOT add fields here — run
# `crosscheck alter <owner>/<repo> --review-only` (or --steps review,fix). That
# writes ~/.crosscheck/workflows/<owner>__<repo>.yml, live-reloaded per PR.
repos:
  - owner: acme
    name: specific-repo
  - owner: humanbased-ai
    name: xny-monorepo

# ── Routing ───────────────────────────────────────────────────────────────────
routing:
  # Origin is detected via a four-signal chain:
  #   1. PR body patterns below (fastest)
  #   2. Commit message Co-Authored-By: trailers (API call, non-fatal if it fails)
  #   3. Branch prefix (claude/ or codex/)
  #   4. author_routes fallback (last resort)
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"    # Claude Code attribution footer
    - "Co-Authored-By: Claude"              # commit trailer
  claude_reviews_patterns:
    - "Generated with \\[OpenAI Codex\\]"   # Codex attribution footer
    - "Co-Authored-By: codex"               # commit trailer

  # Branch prefix detection (signal 3). Claude Code uses claude/, Codex uses codex/.
  claude_branch_prefixes:
    - "claude/"
  codex_branch_prefixes:
    - "codex/"

  # Restrict reviews to PRs opened by these GitHub logins.
  # Auto-filled with your GitHub login by `crosscheck init` or first `crosscheck watch`.
  # Empty = no restriction (all matching PRs reviewed).
  allowed_authors:
    - your-github-login  # auto-detected from gh auth

  # Author-based routing fallback (signal 4) — used when no pattern or prefix matches.
  # Maps GitHub login → vendor origin so crosscheck routes PRs even without
  # the attribution footer (e.g. when creating PRs via gh CLI directly).
  author_routes:
    your-github-login: claude   # your PRs → treated as Claude-authored → Codex reviews

# ── Tunnel (watch mode only) ──────────────────────────────────────────────────
# localhost.run (default) — SSH tunnel, zero install, URL changes on reconnect.
# smee — stable relay via smee.io; events queued while offline.
#   Setup: npm install -g smee-client, visit https://smee.io/new
tunnel:
  backend: localhost.run
  # backend: smee
  # smee_channel: https://smee.io/your-channel-id

# ── Impact reporting ──────────────────────────────────────────────────────────
# Used by `crosscheck impact` to calculate estimated time and monetary value.
impact:
  assumed_human_review_minutes: 60   # baseline for time-saved calculation
  hourly_rate_usd: 150               # for --money estimate
  defect_cost_usd: 150               # per issue caught, for --money estimate

# ── Post-review auto-fix ──────────────────────────────────────────────────────
# Controls HOW fixes are delivered. Step sequencing (which steps run, when,
# and with which vendor) is configured in ~/.crosscheck/workflow.yml.
post_review:
  auto_fix:
    delivery:
      mode: pull_request      # pull_request | commit | comment
      # pull_request → fix PR targets original branch; human approves before merge
      # commit       → fixes pushed directly onto the original PR branch
      # comment      → suggested fixes posted as review comments only
      pr_title: "fix: address CR issues in #{original_pr_title}"
      label: cr-autofix       # GitHub label applied to the fix PR

# ── Watch ─────────────────────────────────────────────────────────────────────
# watch:
#   idle_issue:
#     enabled: false      # opt-in: set to true to prompt when watch is idle for timeout_min minutes
#     timeout_min: 30     # minutes of no PR activity before the idle prompt fires (min: 5)

# ── Backtrace ─────────────────────────────────────────────────────────────────
# On startup, scan all open PRs in the monitored scope and review any that
# haven't received a [crosscheck] comment yet. Off by default.
# Enable with:
#   backtrace.enabled: true  (persistent — runs every startup)
#   --backtrace flag         (this session only)
#   --no-backtrace flag      (suppress even when enabled: true)
# backtrace:
#   enabled: true

# ── Server ────────────────────────────────────────────────────────────────────
server:
  port: 7891
  webhook_path: /webhook
```

### Quality tiers

| Tier | Speed | Depth | Best for |
|---|---|---|---|
| `fast` | ~10s | Top issues only | High-volume repos, draft PRs |
| `balanced` | ~30s | Full review, all issues explained | Default for most teams |
| `thorough` | ~60–90s | Deep multi-pass, architecture + security | Before merging to main |

### Issue enrichment

By default crosscheck infers a PR's intent from the diff. With enrichment on, it
recovers the linked tracker ref (e.g. `IN-2017`) from the PR title, branch, or
body, fetches that Linear issue, and prepends its goal — title, description,
labels, estimate, project — to the reviewer prompt. The review then judges the
change against the **stated goal**, flagging scope creep and behavior that
contradicts the ticket.

```yaml
issue_enrichment:
  enabled: true
  provider: linear             # linear (only provider today)
  team_keys: [IN]              # restrict extraction to these keys; [] = match any
  max_description_chars: 4000  # cap injected description length (0 = no cap)
```

Requires `LINEAR_API_KEY` (see [Environment variables](#environment-variables)).
It's fail-soft at every step: no ref found, no key set, issue not found, or the
Linear API being unreachable all degrade the run to a normal diff-only review —
enrichment never blocks or fails a review. Misses are logged (`issue_enrichment_*`
events) so you can see why a given PR wasn't enriched. Enrichment feeds the
review and recheck steps only; it does not change reviewer routing or tier.

### Routing patterns

Patterns are matched against the PR body as case-insensitive regular expressions.

- `codex_reviews_patterns` — PRs matching these are reviewed by Codex
- `claude_reviews_patterns` — PRs matching these are reviewed by Claude

To also review human PRs, add a catch-all:

```yaml
routing:
  codex_reviews_patterns:
    - "Generated with \\[Claude Code\\]"
    - ".*"    # Codex reviews all PRs
```

### Minimal config

```yaml
mode: cross-vendor
```

Everything else uses defaults.

---

## How it works

```
GitHub repo
    │  pull_request event (opened / synchronize)
    ▼
crosscheck webhook server
    │
    ├─ verify HMAC-SHA256 signature
    ├─ detect PR origin from body patterns
    ├─ assign reviewer (opposite vendor in cross-vendor mode)
    │
    ▼
clone PR branch into temp directory
    │
    ├─ codex review --base <branch>       ← non-interactive Codex review
    │  or
    └─ claude --print --bare ...          ← non-interactive Claude review
            │
            ▼
    post comment to PR via GitHub API
    delete temp clone
            │
            ▼  post_review.auto_fix (if enabled and issues found)
    authoring vendor reads review comment
            │
    ├─ claude --print ...  (Claude authored the PR)
    │  or
    └─ codex ...           (Codex authored the PR)
            │
            ▼
    opens fix PR → fix/cr-<pr-number>-review-issues → original branch
    (you review and merge the fix PR; original PR updates automatically)
```

### PR origin detection

crosscheck uses a four-signal chain to determine whether a PR was authored by Claude Code, Codex, or a human:

1. **PR body** — looks for attribution footers (e.g. `Generated with [Claude Code]`)
2. **Commit messages** — scans all commit messages for `Co-Authored-By:` trailers
3. **Branch prefix** — `claude/` → Claude origin; `codex/` → Codex origin
4. **`author_routes`** — per-login fallback in config

If none match, origin is `human` and the PR is skipped in cross-vendor mode.

| Default pattern | Matches |
|---|---|
| `Generated with \[Claude Code\]` | Claude Code attribution footer in PR body |
| `Generated with \[OpenAI Codex\]` | Codex attribution footer in PR body |
| `Co-Authored-By: Claude` | Commit trailers from Claude Code |
| `Co-Authored-By: codex` | Commit trailers from Codex |
| branch prefix `claude/` | Branch naming convention for Claude-authored PRs |
| branch prefix `codex/` | Branch naming convention for Codex-authored PRs |

### Reviewer assignment

| Mode | PR origin | Reviewer |
|---|---|---|
| `cross-vendor` | claude | Codex |
| `cross-vendor` | codex | Claude |
| `cross-vendor` | human | None — skipped |
| `single-vendor` | any | First enabled vendor |

### How Codex reviews run

```bash
codex review --base <base-branch> --title "<pr-title>"
```

The `--base` flag diffs current HEAD against the base branch — exactly the PR diff. With `auth: subscription`, no model flag is passed. With `auth: api-key`, the model is selected by quality tier (`fast` → `gpt-5.6-luna`, `balanced` → `gpt-5.6-terra`, `thorough` → `gpt-5.6-sol`).

### How Claude reviews run

```bash
claude \
  --print --bare \
  --model claude-sonnet-5 \
  --effort medium \
  --max-budget-usd 2.00 \
  --output-last-message /tmp/review.md \
  --allowedTools "Bash(git diff),Bash(git log)" \
  "<prompt>"
```

`--bare` makes execution fast and deterministic. `--allowedTools` limits Claude to read-only git operations on the cloned repo.

### Deduplication

**What's implemented today**

GitHub can fire both `opened` and `synchronize` events for the same push. crosscheck tracks `owner/repo#pr@sha` in an in-memory set and drops duplicate events for the same commit within the same running process.

**Known gap — concurrent sessions**

If `crosscheck run <pr-url>` is invoked while a `watch` daemon is already reviewing the same PR (or two machines pick up the same webhook), both sessions will pass the current check — which only looks at already-posted comments — and both will post a review. This is a known race condition.

The fix (file lock for same-machine + GitHub commit status for cross-machine) is tracked as a P0 item and not yet implemented. Until it lands, avoid running `crosscheck run` manually on a PR that your `watch` daemon is actively processing.

### Security

- **Webhook signature** — every request verified with HMAC-SHA256 before parsing
- **Temp isolation** — each PR cloned into a fresh temp dir, deleted after review
- **Read-only tools** — Claude restricted to `git diff` and `git log` only
- **Temp credential isolation** — with `clone_protocol: ssh` (default) no tokens touch disk; with `clone_protocol: https` a short-lived token is embedded in the temp clone's remote URL and removed when the temp dir is deleted after review

---

## Post-review auto-fix

When `post_review.auto_fix.enabled` is `true` (the default), crosscheck completes the full loop automatically after every review that finds issues:

```
agent opens PR #42  →  opposite vendor reviews  →  issues found?
                                                         │ yes
                                        authoring vendor generates fixes
                                                         │
                                    fix PR #43 opened → feat/my-feature
                                                         │
                                    you review and merge PR #43
                                                         │
                                    PR #42 updates → you merge to main
```

**Key design decisions:**

| Setting | Default | Why |
|---|---|---|
| `fixer: same-as-author` | the vendor that wrote the PR also fixes it | The authoring agent knows its own code and style best |
| `delivery: pull_request` | opens a new PR, doesn't push directly | You stay in the loop — no code lands without your approval |
| `trigger: on_issues` | only fires when the reviewer found warnings or worse | Skips the fix step on clean PRs |
| `min_severity: warning` | ignores info/cosmetic findings | Avoids noisy fix PRs for style-only comments |

**Fix PR branch naming:** `fix/cr-<original-pr-number>-review-issues`

**Original PR number:** never changes. The fix PR targets the original branch; once merged, its commits appear in the original PR automatically.

**To disable:** set `post_review.auto_fix.enabled: false` in your config, or set `trigger: never`.

---

## FAQ

### How does crosscheck improve over time?

Every review — success or failure — is appended to `~/.crosscheck/logs/YYYY-MM-DD.ndjson`. Running `crosscheck diagnose` reads those logs and surfaces patterns: which commands failed, which reviewer is struggling, which language-specific tools were missing. Running `crosscheck optimize` feeds that report into your best-performing AI agent (guided by the bundled `AGENT.md`) and updates the `instructions` field of the review step in `~/.crosscheck/workflow.yml`. The improvements take effect immediately on the next PR.

### Which agent does `crosscheck optimize` use?

It picks automatically:
1. If only one vendor is enabled in your config → uses that one.
2. Both enabled → whichever has the higher success rate in recent logs.
3. Equal rates or no data → defaults to `claude`.
4. You can always override: `crosscheck optimize --agent codex`.

The agent used for `optimize` is independent of which agent reviews your PRs — `optimize` is about improving the instructions, not reviewing code.

### How do I customize reviewer behavior?

The primary place is the workflow file. Each step has an `instructions` field that is passed verbatim to the reviewer or fixer agent:

```yaml
# .crosscheck/workflow.yml
steps:
  - name: review
    type: review
    reviewer: auto
    instructions: |
      Do not suggest TypeScript patterns — this is a Rust project.
      Focus on memory safety and error handling.
      ## Verdict
      End with: VERDICT: APPROVE | NEEDS_WORK | BLOCK
  - name: fix
    type: fix
    reviewer: origin
    when: "review.verdict != 'APPROVE'"
    instructions: "Only fix issues explicitly called out. Do not refactor unrelated code."
```

`crosscheck optimize --apply` updates the review step's `instructions` field in `~/.crosscheck/workflow.yml` to persist learned improvements across sessions.

To reset the review step instructions to defaults, delete `~/.crosscheck/workflow.yml` and re-run `crosscheck onboard` — it will regenerate the file with the built-in defaults.

### Can I have per-project workflow?

Yes. Create `.crosscheck/workflow.yml` in your repo root. crosscheck loads it automatically and uses it instead of the built-in default pipeline. This is the recommended way to customize reviewer behavior — it keeps all per-project settings in one file under version control.

For one always-on watcher that monitors many repos, use `crosscheck alter owner/repo --review-only` (or `--steps review,fix`) instead. That writes `~/.crosscheck/workflows/<owner>__<repo>.yml`, which narrows the global workflow for that one repo — live-reloaded, no restart — while the rest keep the global workflow.

### What is `AGENT.md`?

`AGENT.md` is the harness document that guides the AI during `crosscheck optimize`. It defines the input/output contract, language-detection rules, constraint-writing guidelines, and quality principles. It ships bundled with crosscheck so `optimize` works out of the box.

You can override it by placing an `AGENT.md` at your project root or `.crosscheck/AGENT.md`. crosscheck checks for a local override first, then falls back to the bundled version. This lets teams customize the optimization logic for their specific stack or conventions.

### Why did my review fail with "command not found"?

The reviewer (codex or claude) tried to run a CLI tool (e.g. `tsc`, `pytest`) that isn't available in the temporary clone. The clone is a shallow `git` checkout with no `node_modules` or other installed dependencies. Run `crosscheck diagnose` to see which commands failed, then `crosscheck optimize --apply` to add the appropriate constraints to the review step in `~/.crosscheck/workflow.yml` so the reviewer stops trying.

### Why did my review fail with "no such branch"?

crosscheck fetches the PR base branch (e.g. `staging`) into the temp clone before running the reviewer. If that fetch fails (network issue, branch deleted, insufficient token scope), the reviewer cannot diff correctly. Check:
- The base branch exists and is accessible with your token.
- Your `GITHUB_TOKEN` has `repo` scope.
- The branch name in the PR matches what's on the remote.

### How do I use smee.io instead of localhost.run?

`localhost.run` (the default) drops events if your laptop is offline when GitHub fires the webhook. [smee.io](https://smee.io) queues events and replays them when your laptop reconnects — useful when the reviewer machine isn't always on.

```bash
npm install -g smee-client
```

Visit [smee.io/new](https://smee.io/new) and copy the channel URL. Then in `~/.crosscheck/config.yml`:

```yaml
tunnel:
  backend: smee
  smee_channel: https://smee.io/your-channel-id
```

crosscheck registers the smee channel URL as your GitHub webhook automatically on first `watch` start. The channel URL never changes, so no re-registration is needed on restart. Unlike `localhost.run`, events are queued while you're offline and replayed when you reconnect.


### What does `max_rounds` mean?

`max_rounds` on the `fix` and `recheck` steps controls how many autonomous fix→recheck cycles can run for a single PR before the loop stops.

**Pattern with `max_rounds: 3`:**
```
review → fix¹ → recheck¹ → fix² → recheck² → fix³ → recheck³
```

Each cycle is one `[crosscheck]` fix commit followed by one recheck. The loop stops early when:
- the recheck returns `APPROVE` (done), or
- `round` reaches `max_rounds` (cap hit — human attention required for remaining issues).

`max_rounds: 1` (the default) runs one cycle: review → fix → recheck. If the recheck still says `NEEDS WORK` or `BLOCK`, the loop stops and the outstanding issues need manual resolution.

`max_rounds` is a per-step field. Crosscheck uses the minimum across all fix and recheck steps in the workflow, so setting `max_rounds: 3` on both keeps them in sync. Setting it to different values on fix vs recheck is not recommended.

`max_rounds` is respected by both `crosscheck watch` and `crosscheck run`. `watch` re-triggers on each pushed fix commit; `run` loops inline within the same session.

### Can I disable the auto-fix step?

Yes. Set `post_review.auto_fix.enabled: false` in your config, or set `trigger: never`. You can also raise `min_severity` to `error` to limit fixes to blocking issues only.

To push fixes directly without a separate PR (skipping your review), switch to `delivery: commit`. To get suggested fixes as review comments without any code push, use `delivery: comment`.

### Why does the fixer use the same vendor that wrote the PR?

The authoring agent has the most context about its own code — the same style, constraints, and intent behind the original changes. Using `fixer: same-as-author` keeps the feedback loop tight: the agent writes the code, another agent reviews it, the original agent fixes it. You can override this to `same-as-reviewer`, `codex`, or `claude` if you prefer a different arrangement.

### Does optimize run automatically?

No — `crosscheck optimize` is always user-triggered. You run it when you want to improve instructions. There is no background daemon or scheduled job. A future version may add an optional `--schedule` mode, but the default will always be manual to keep you in control of what gets written to `~/.crosscheck/workflow.yml`.
