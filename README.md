<div align="right">
  <h5><a href="./README.zh.md">🌏 &nbsp;中文</a></h5>
</div>

<p align="center">
  <img src="./assets/logo.png" alt="crosscheck" width="160" />
</p>

<p align="center"><em>A Humanbased project, built with crosscheck.</em></p>

# crosscheck

<p align="center">
  <img src="./assets/screenshot-watch.png" alt="crosscheck watch — live pipeline view" width="860" />
</p>

**Your agents ship fast. Crosscheck makes sure they ship right.**

AI coding agents create PRs faster than review habits can absorb. The failure mode isn't broken builds — it's *early victory*: patches that pass CI, look complete, and still hide regressions, brittle edge cases, or half-finished fixes.

Crosscheck adds an independent Review → Fix → Recheck loop. One agent writes the patch. Another reviews it. Findings go back to the author to repair. The result gets rechecked before merge. The PR moves toward genuinely merge-ready — not just "looks green."

No new hosted service. No per-review API bill. Crosscheck runs through the `claude` and `codex` CLIs you already have — your existing subscriptions, your machine or server.

Built by [Humanbased](https://github.com/humanbased-ai). Read the field report: [What 295 Agentic PRs Taught Us About Code Review](https://blog.humanbased.ai/posts/agentic-pr-quality-crosscheck/) — 295 agentic PRs analyzed, real Crosscheck logs included.

## Why crosscheck?

**Agent velocity without lowering the merge bar.**

- **Independent eyes, not self-review** — route Claude-authored PRs to Codex and vice versa. Self-review is exactly where early-victory failures hide.
- **Review → Fix → Recheck, not just comments** — findings return to the author agent for repair; a clean recheck follows before merge. PRs move forward, not sideways.
- **No new vendor** — runs through the `claude` and `codex` CLIs you already pay for. No per-review bill, no extra trust surface.
- **Configurable for any team size** — review-only, review + fix, or the full loop. Use one workflow locally, or one always-on team watcher with per-repo overrides via `crosscheck alter`.

## Who uses crosscheck

| Persona | Problem | How crosscheck helps |
|---|---|---|
| **Solo agentic builder** | Same agent that wrote the code may self-approve incomplete work | Independent reviewer from a different vendor, on your machine |
| **Technical founder** | AI PRs look done before delivering stable value | Closes the loop: review finding → agent fix → clean recheck |
| **Engineering lead** | Agent use is hard to supervise or standardize | A default full-loop workflow, per-repo overrides (`crosscheck alter`), and a visible PR audit trail |
| **OSS maintainer** | Review bandwidth is scarce; comments must be actionable | One-shot `crosscheck review` posts concrete findings directly on the PR |

### Usage scenarios

**Local use**

Use Crosscheck from your own machine when you want an independent review before merge, or a temporary watcher while you work.

```bash
# Catch regressions before merging a solo PR
crosscheck run <pr-url>

# One-shot review of a specific PR
crosscheck review <pr-url>

# Continuous review while your terminal is open
crosscheck onboard --personal
crosscheck watch

# Loop until the agent produces an approved patch
crosscheck run <pr-url> --crazy
```

**Always-on team server**

Run one long-lived `watch` process for the whole team or org on a shared machine. Configure the default workflow once, then narrow individual repos only when needed.

```bash
# One-time setup on the server
crosscheck onboard --team

# Example: one repo gets review-only, the rest keep the global workflow
crosscheck alter humanbased-ai/xny-monorepo --review-only

# Start the team watcher
crosscheck watch
```

---

## Quick start

### First useful review in 10 minutes

Start with one low-risk PR before turning on continuous watch mode. You only need GitHub CLI plus one authenticated reviewer CLI.

```bash
# 1. Install crosscheck
npm install -g @humanbased/crosscheck

# 2. Authenticate GitHub
brew install gh && gh auth login

# 3. Authenticate one reviewer
npm install -g @openai/codex && codex login --device-auth
# or:
npm install -g @anthropic-ai/claude-code && claude

# 4. Check your setup
crosscheck status

# 5. Review the public fixture PR
crosscheck review https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1 --reviewer codex
```

This fixture PR intentionally contains a realistic agentic-code regression, so you can see whether Crosscheck produces a useful review before pointing it at your own repo. Use `--reviewer claude` if Claude Code is the authenticated reviewer. After the fixture review works, swap in one low-risk PR from your repo, then run `crosscheck onboard` to configure repos, workflow mode, and continuous monitoring.

### Continuous local mode

```bash
# 1. Install crosscheck and the agent CLIs
npm install -g @humanbased/crosscheck
npm install -g @anthropic-ai/claude-code && claude        # Claude Pro/Max subscription
npm install -g @openai/codex && codex login --device-auth # ChatGPT Plus/Pro subscription
brew install gh && gh auth login                          # GitHub CLI

# 2. Guided setup — repos, review mode, workflow pipeline
crosscheck onboard

# 3. Start watching
crosscheck watch                  # continuous review → fix → recheck as PRs arrive
```

> Want reviews only (no auto-fix) for a repo? Make it review-only with
> `crosscheck alter owner/repo --review-only` — see [per-repo overrides](#crosscheck-alter-repo).

### Always-on team mode

```bash
# 1. Run guided setup on the shared machine
crosscheck onboard --team

# 2. Optional: tune individual repos without changing the global workflow
crosscheck alter humanbased-ai/xny-monorepo --review-only
crosscheck alter humanbased-ai/api --steps review,fix,recheck

# 3. Start the long-lived watcher
crosscheck watch
```

---

## Commands

```bash
crosscheck onboard                  # guided setup — pick repos, mode, and default pipeline
crosscheck alter <repo>             # per-repo override: --steps review,fix | --review-only | --reset | --show
crosscheck watch                    # continuous use — tunnel + webhook + listening
crosscheck review <pr-urls...>      # review one or more PRs (comma lists, ranges, cross-repo)
crosscheck run <pr-urls...>         # run the full workflow: review → (fix → recheck) × max_rounds (--review-only for review only)
crosscheck recheck|fix|resolve <pr-urls...>   # force one workflow step on one or more PRs
crosscheck scan                     # show open PR workflow state across monitored repos
crosscheck detect-step <pr-url>     # explain the next workflow step for one PR
crosscheck kickass                  # advance stale PRs from an interactive operator queue
crosscheck init                     # check prerequisites, write starter config
crosscheck status                   # auth state, config summary, CLI versions
```

**Operator queue (scan + kickass)**

`crosscheck scan` tracks two independent dimensions per PR:

| Workflow stage (`reviewState`) | Meaning | Next action |
|---|---|---|
| `NEEDS_REVIEW` | No crosscheck review for current HEAD | review |
| `NEEDS_FIX` | Reviewed — fix requested | fix |
| `NEEDS_RECHECK` | Fix committed, recheck pending | recheck |
| `APPROVED` | Reviewed and approved | merge |

| Verdict (`verdict`) | Meaning |
|---|---|
| `UNREVIEWED` | No review found |
| `APPROVE` | AI approved |
| `NEEDS_WORK` | AI requested changes |
| `BLOCK` | AI hard-blocked merge |

`BLOCK` and `NEEDS_WORK` both map to `NEEDS_FIX` stage — same next action, but the `verdict` field preserves severity so operators can prioritise.

**How workflow steps are counted**

Crosscheck reconstructs PR workflow state from visible artifacts:

| Evidence | Counts as |
|---|---|
| Review or recheck comment with `<!-- crosscheck: ... verdict=... -->` | completed `review` / `recheck` step |
| Fix or conflict-resolve comment, such as `<!-- crosscheck: fix_applied ... -->` | completed `fix` / `conflict-resolve` step |
| PR commit trailer, such as `Crosscheck-Step: fix` | completed step declared by that trailer |

Commit trailers are accepted as operator-declared workflow state. In practice, a PR author may command Claude, Codex, or another agent to apply a fix outside a standalone Crosscheck post; if the resulting PR commit carries `Crosscheck-Step: fix`, Crosscheck counts it as fix evidence.

That evidence only advances the next step to `recheck` when the fix commit is the current PR HEAD. If another commit lands after the fix evidence, Crosscheck starts a fresh review round so the newer code is reviewed normally. This prevents an old fix trailer from marking later changes as ready for recheck.

```bash
crosscheck scan [--tidy] [--stale-after <duration>] [--force] [--json]
crosscheck kickass [--dry-run] [--stale-after <duration>] [--force]
```

`crosscheck review --reviewer`, `crosscheck run --reviewer`, `crosscheck run --fixer`, and `crosscheck run --vendor` accept vendor aliases:
- Claude: `claude`, `claude-code`, `cc`, `anthropic`
- Codex: `codex`, `openai`

**Continuous improvement** *(experimental)*

```bash
crosscheck diagnose                 # surface failure patterns from review logs
crosscheck optimize [--apply]       # rewrite reviewer instructions based on diagnose output
crosscheck impact [--money]         # time saved, issues caught, code quality trends
crosscheck issue                    # draft and file a bug report from recent error logs
```

---

### `crosscheck onboard`

Interactive setup wizard. Picks repos/orgs to monitor, selects single-vendor or cross-vendor mode, configures the review pipeline, and writes `~/.crosscheck/config.yml` and `workflow.yml`.

```bash
crosscheck onboard              # guided setup
crosscheck onboard --personal   # skip persona prompt, go straight to personal mode
crosscheck onboard --team       # skip persona prompt, go straight to team mode
crosscheck onboard -y           # accept all defaults non-interactively
```

---

### `crosscheck alter <repo>`

Sets the workflow depth for one repo, leaving the global default in place for every other monitored repo. Writes a standalone file at `~/.crosscheck/workflows/<owner>__<repo>.yml` (`alter-workflow` is an alias). This is how you run one watcher for many repos while making one repo review-only. Changes apply on the next PR event — no need to restart `crosscheck watch`.

```bash
crosscheck alter humanbased-ai/xny-monorepo --review-only            # alias for --steps review
crosscheck alter github.com/humanbased-ai/xny-monorepo --steps review,fix
crosscheck alter https://github.com/humanbased-ai/xny-monorepo --steps review,fix,recheck
crosscheck alter humanbased-ai/xny-monorepo --show                   # print effective steps
crosscheck alter humanbased-ai/xny-monorepo --reset                  # revert to the global default
```

Accepted repo formats: `owner/repo`, `github.com/owner/repo`, and `https://github.com/owner/repo`. The override narrows the global `~/.crosscheck/workflow.yml` — it wins over the global default but a repo-committed `.crosscheck/workflow.yml` still wins over it.

---

### `crosscheck watch`

Starts an SSH tunnel (localhost.run), registers GitHub webhooks, and listens for PR events. Everything self-cleans on Ctrl+C.

```bash
crosscheck watch
crosscheck watch --no-backtrace       # skip startup scan for unreviewed open PRs
crosscheck watch --reconfigure        # re-run deployment setup before starting
```

> For reviews only, make the repo review-only with `crosscheck alter <repo> --review-only` rather than a global flag.

---

### `crosscheck review <pr-urls...>`

Reviews one or more PRs. Clones, checks out, reviews, and posts the comment. The PR argument accepts the [multi-PR spec syntax](#multi-pr-syntax) — multiple PRs are reviewed concurrently.

```bash
crosscheck review https://github.com/org/repo/pull/42
crosscheck review <pr-url> --reviewer claude    # force Claude regardless of detection
crosscheck review <pr-url> --reviewer codex     # force Codex regardless of detection
crosscheck review <pr-url> --reviewer cc        # alias for Claude
crosscheck review <pr-url> --reviewer openai    # alias for Codex
crosscheck review .../pull/245,255              # review several PRs at once
crosscheck review .../pull/245-256              # review an inclusive range
```

---

### `crosscheck run <pr-urls...>`

Runs the configured workflow against one or more PRs: review → (fix → recheck) × `max_rounds`. Without `--steps`, this honors any repo workflow set by `crosscheck alter`. Loops autonomously through fix→recheck cycles up to the `max_rounds` value configured in `workflow.yml` (default: 1). Use `--crazy` or `--half-crazy` to loop until approved or unblocked, ignoring `max_rounds`. The PR argument accepts the [multi-PR spec syntax](#multi-pr-syntax); multiple PRs run concurrently (one agent per PR by default).

```bash
crosscheck run <pr-url>
crosscheck run <pr-url> --steps review           # only the review step
crosscheck run <pr-url> --steps fix,recheck      # skip initial review
crosscheck run <pr-url> --reviewer claude        # force review/recheck agent
crosscheck run <pr-url> --fixer claude           # force fix agent
crosscheck run <pr-url> --vendor claude          # force review/recheck/fix agent
crosscheck run <pr-url> --dry-run                # review without posting or fixing
crosscheck run <pr-url> --crazy                  # 🔥🔥 loop until APPROVE
crosscheck run <pr-url> --half-crazy             # 🔥  loop until not BLOCK
crosscheck run <pr-url> --timeout 10m            # custom reviewer timeout
crosscheck run .../pull/245,255                  # several PRs, concurrently
crosscheck run .../pull/245-256 --concurrent 3   # range, max 3 agents in parallel
```

---

### `crosscheck recheck` / `fix` / `resolve <pr-urls...>`

Force a single workflow step against one or more PRs, bypassing next-step auto-detection. Each is sugar for `crosscheck run <spec> --steps <type>` and accepts the same [multi-PR spec syntax](#multi-pr-syntax) and `--concurrent` / `--sequential` / `--stagger` flags as `run`.

| Command | Forces the step |
|---|---|
| `crosscheck recheck <spec>` | `recheck` — re-evaluate against the latest review |
| `crosscheck fix <spec>` | `fix` — apply fixes for the latest review |
| `crosscheck resolve <spec>` | `conflict-resolve` — resolve merge conflicts (Claude only) |

```bash
crosscheck recheck https://github.com/org/repo/pull/42
crosscheck fix .../pull/245,255 --fixer claude
crosscheck resolve .../pull/245-256 --vendor claude
```

When the step is absent from the active `workflow.yml`, `recheck` and `conflict-resolve` are synthesized with built-in defaults so the command still runs.

---

### Multi-PR syntax

`run`, `review`, `recheck`, `fix`, and `resolve` accept a single PR URL or a **spec** that expands to many PRs — a comma-separated list of full URLs, bare numbers, and `N-M` ranges:

```bash
.../pull/245,255                                   # two PRs in the same repo
.../pull/245-256                                   # an inclusive range
.../repo/pull/245,https://github.com/o/other/pull/3  # across repos
```

The first token must be a full URL (a bare number inherits the most recent repo). Duplicates are de-duplicated and a spec expands to at most 100 PRs. Multiple PRs run concurrently by default — control parallelism with `--concurrent <n>`, `--sequential`, or `--stagger <ms>`.

---

### `crosscheck scan`

Scans every open PR in the configured monitor scope and reports where each one is in the crosscheck workflow. Results are cached for 60 seconds.

States: `NEEDS_REVIEW` · `NEEDS_FIX` · `BLOCK` · `NEEDS_RECHECK` · `APPROVE`

```bash
crosscheck scan                          # all open PRs, grouped stale/not-stale
crosscheck scan --tidy                   # stale actionable rows only
crosscheck scan --stale-after 4h         # custom staleness threshold (default 24h)
crosscheck scan --force                  # bypass cache
crosscheck scan --json                   # machine-readable output
```

---

### `crosscheck detect-step`

Explains the workflow history for one PR and prints the next step Crosscheck would run. Use this when a PR has mixed evidence from comments, Crosscheck commits, or ad hoc agent commits with `Crosscheck-Step` trailers.

```bash
crosscheck detect-step <pr-url>
crosscheck detect-step <pr-url> --json
```

---

### `crosscheck kickass`

Selects stale PRs from the operator queue and advances them — runs `scan` first, presents a multi-select picker, shows a preflight summary, then executes after confirmation.

```bash
crosscheck kickass                       # interactive operator queue
crosscheck kickass --dry-run             # preflight only — no mutations
crosscheck kickass --stale-after 2h      # tighter staleness threshold
crosscheck kickass --force               # bypass scan cache before picking
crosscheck kickass --crazy               # 🔥🔥 auto loop until APPROVE
crosscheck kickass --half-crazy          # 🔥  auto loop until not BLOCK
```

Actions: `NEEDS_REVIEW → CR` · `NEEDS_FIX/BLOCK → Fix` · `NEEDS_RECHECK → Recheck` · `APPROVE → Merge`

**`kickass` + `watch` combo**

For the best recovery experience when a batch of PRs is stuck (timed out, stopped before `watch` was running), run both commands together. Each plays a distinct role:

- `kickass` kicks each stuck PR **one step at a time** — it uses `detect-step` to read live PR history and dispatches only the next needed step (review, fix, or recheck).
- `watch` owns **all continuation** — it listens for the webhooks each completed step produces and runs the full remaining pipeline from there.

```
crosscheck kickass
  └─ ck run <url>  --trigger kickass  (one step; detect-step finds where to start)
       └─ detect-step → "review"      run review only → posts comment
       └─ detect-step → "fix"         run fix only → pushes commit
       └─ detect-step → "recheck"     run recheck only → posts verdict

crosscheck watch
  ├─ issue_comment (type=review) → pick up fix step automatically
  └─ synchronize   (fix commit)  → pick up recheck step automatically
```

> **Note:** `crosscheck run <pr-url>` invoked directly runs the **full remaining pipeline** from the detected starting step. The one-step behaviour above applies only when kickass dispatches it with `--trigger kickass`.

Start `watch` first, then run `kickass` in a second terminal:

```bash
# terminal 1
crosscheck watch

# terminal 2
crosscheck scan --force    # refresh PR state
crosscheck kickass
```

> **How the review→fix bridge works:** after `kickass` posts a review comment, GitHub fires an `issue_comment` webhook (not a `pull_request` event). `watch` subscribes to `issue_comment` and, when it sees a crosscheck `type=review` annotation on an open PR, fetches the current PR head and runs the fix step automatically — no new commit required to wake it up. (Introduced in [#193](https://github.com/Motivation-Labs/crosscheck/pull/193).)

**Autonomous loop modes**

`--crazy` and `--half-crazy` turn `run` and `kickass` into autonomous fix→recheck loops that keep going until the verdict improves — no manual re-runs needed.

| Flag | Stops when | Max rounds | Timeout |
|---|---|---|---|
| `--crazy` 🔥🔥 | verdict = `APPROVE` | ∞ | none |
| `--half-crazy` 🔥 | verdict ≠ `BLOCK` | ∞ | none |

Both flags disable all reviewer subprocess timeout constraints — long fixes on large PRs won't be cut short. Use `--timeout <duration>` (e.g. `--timeout 10m`) without these flags to set a custom cap.

```bash
# Run full workflow and keep looping until approved
crosscheck run <pr-url> --crazy

# Advance every stale PR until it's no longer blocked
crosscheck kickass --half-crazy

# Custom timeout without looping
crosscheck run <pr-url> --timeout 10m
```

---

## Configuration

Crosscheck uses `~/.crosscheck/config.yml` by default. If that file exists, it wins over `./crosscheck.config.yml` unless you pass `--config ./crosscheck.config.yml`.

### Review depth (`quality.tier`)

```yaml
# crosscheck.config.yml
quality:
  tier: balanced    # fast | balanced | thorough
```

| Tier | Claude model | Codex model | Latency |
|---|---|---|---|
| `fast` | Haiku 4.5 | GPT-5.6 Luna | ~10s |
| `balanced` | Sonnet 5 | GPT-5.6 Terra | ~30s |
| `thorough` | Opus 4.8 | GPT-5.6 Sol | ~60s |

### Pipeline (`workflow.yml`)

```yaml
steps:
  - name: review
    type: review
    reviewer: auto          # auto | claude | codex | origin

  - name: fix
    type: fix
    reviewer: origin
    when: review.verdict != 'APPROVE'

  - name: recheck
    type: recheck
    reviewer: auto
    when: fix.applied_count > 0
```

### Per-repo workflow overrides

The global `workflow.yml` is the default for every repo (out of the box, the full `review → fix → recheck` loop). To run one repo at a narrower depth in the same watcher, use `crosscheck alter` — it writes a standalone override file at `~/.crosscheck/workflows/<owner>__<repo>.yml`:

```bash
crosscheck alter humanbased-ai/xny-monorepo --review-only      # review only
crosscheck alter humanbased-ai/api --steps review,fix,recheck  # full loop, explicit
crosscheck alter humanbased-ai/xny-monorepo --reset            # back to the global default
```

Each override file lists the review → fix → recheck depth only:

```yaml
# ~/.crosscheck/workflows/humanbased-ai__xny-monorepo.yml
steps:
  - review
```

The override *narrows* the global workflow — it keeps each step's configured instructions and reviewer. `conflict-resolve` is orthogonal to the depth ladder: it stays enabled for any override that permits code modification (`review,fix` or `review,fix,recheck`) and is dropped only for review-only (`review`). Repos without an override file keep the complete global workflow. Resolution order: `{repo}/.crosscheck/workflow.yml` → `~/.crosscheck/workflows/<owner>__<repo>.yml` → `~/.crosscheck/workflow.yml` → built-in default.

### Config snapshot

```yaml
# ~/.crosscheck/config.yml
orgs:
  - your-org

routing:
  allowed_authors:
    - your-github-login

mode: cross-vendor          # cross-vendor | single-vendor

vendors:
  claude:
    enabled: true
  codex:
    enabled: true

quality:
  tier: balanced

clone_protocol: ssh         # ssh (default) | https
```

Full reference: [get-started.md](./get-started.md)

---

## Requirements

| | Minimum |
|---|---|
| Node.js | 18+ |
| Claude Code CLI | latest — `npm install -g @anthropic-ai/claude-code` |
| Codex CLI | latest — `npm install -g @openai/codex` |
| GitHub CLI | 2.65+ — `brew install gh` |

`GITHUB_TOKEN` is derived automatically from `gh auth login`. No manual export needed.

---

## Documentation

| | |
|---|---|
| **[get-started.md](./get-started.md)** | Full setup guide — prerequisites, all flags, complete config reference, FAQ |
| **[What 295 Agentic PRs Taught Us About Code Review](https://blog.humanbased.ai/posts/agentic-pr-quality-crosscheck/)** | Humanbased field report on agentic PR quality, review routing, and why Crosscheck exists |
| **[docs/fixture-pr.md](./docs/fixture-pr.md)** | Safe public fixture PR for the first Crosscheck review |
| **[crosscheck.config.example.yml](./crosscheck.config.example.yml)** | Annotated config with every option |
| **[CHANGELOG.md](./CHANGELOG.md)** | Release notes |

---

## Contributing

Issues and PRs welcome at [github.com/humanbased-ai/crosscheck](https://github.com/humanbased-ai/crosscheck).

---

## License

[MIT](./LICENSE) — Copyright (c) 2025–2026 Humanbased PTE LTD.
