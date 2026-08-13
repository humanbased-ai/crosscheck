# Trust: what Crosscheck reaches, sends, and changes

Crosscheck runs on your machine, holds your GitHub token, clones your code, and pushes commits. This document says exactly what that means, so you can decide whether to run it without reading the source.

Everything below is behaviour of the current release. Where a default is risky, it is called out as a default rather than buried.

**The short version.** Crosscheck has no server. There is no Crosscheck-operated endpoint, no telemetry, no account, no phone-home, and no analytics — install it and nothing is reported anywhere. It talks to GitHub with your token, and it runs the Claude Code and Codex CLIs on your machine under *their* credentials and *their* privacy terms. On a default `watch` setup, one third party you may not expect is in the path: the webhook tunnel. See [What leaves your machine](#what-leaves-your-machine).

---

## What leaves your machine

Five destinations, and nothing else.

| Destination | What goes there | When | Avoidable? |
|---|---|---|---|
| `api.github.com`, `github.com` | Your token; PR reads; git clone/fetch; the comments, commit statuses, commits, branches and PRs Crosscheck writes | Every command | No — this is the product |
| Claude Code CLI → Anthropic | The reviewer prompt, plus whatever the agent reads from the clone (it is allowed `git diff` and `git log`) — so in practice your diff and relevant source | Review, fix, recheck, conflict-resolve steps | Yes — disable the vendor in config |
| Codex CLI → OpenAI | Same, for Codex-assigned steps | Same | Yes — disable the vendor in config |
| Tunnel relay — `localhost.run` (default) or `smee.io` | GitHub's webhook deliveries for your monitored repos: PR metadata, author, branch, head sha, and PR body as GitHub sends it | `crosscheck watch` only | Yes — see below |
| `api.linear.app` | Issue reads (enrichment) and verdict comments | Only when Linear is configured; off by default | Yes — leave it off |

Two things to be precise about, because they are the parts people get wrong:

**Crosscheck does not upload your code. The vendor CLIs do.** Crosscheck clones your repo to a temp directory and runs `claude` or `codex` as a subprocess pointed at that directory. Your diff reaches Anthropic or OpenAI through those CLIs, under the credentials you already logged into them with and under their data-handling terms — the same exposure you have when you run `claude` in your own checkout. Crosscheck adds no separate upload path. If a repo cannot go to a model vendor, Crosscheck is not the tool that changes that.

**The webhook tunnel is a third party in the path.** `crosscheck watch` needs a public URL for GitHub to POST to, and by default it opens an SSH tunnel through `localhost.run`. GitHub's webhook payloads for your monitored repos therefore transit a relay operated by someone else. Deliveries are HMAC-signed and Crosscheck rejects anything whose signature does not verify (`webhook_sig_invalid`), so a relay cannot *forge* events — but it can *see* payloads, which include PR titles, bodies, branch names and author logins. Payloads carry no source diff and no token.

To avoid the relay entirely, don't run `watch`. Everything Crosscheck does is available as a one-shot command that needs no inbound connection:

```bash
crosscheck run https://github.com/acme/web/pull/245
```

Run that from cron, from CI, or by hand. Or use `tunnel.backend: smee` with your own [smee.io](https://smee.io/new) channel if you prefer a named relay that queues events while you are offline — same trade, different operator. Self-hosting the relay is not supported today.

---

## GitHub permissions

Crosscheck uses whatever token `gh auth login` already produced — it does not mint its own, and it never asks you to paste one into a config file.

| Scope | Needed for | Required? |
|---|---|---|
| `repo` | Clone, fetch, push; read PRs; post comments; write the `crosscheck/review` commit status | Yes |
| `admin:repo_hook` | Register the webhook on individual repos | `watch` with repo-level scopes only |
| `admin:org_hook` (`write:org`) | Register one webhook per org instead of per repo | `watch` with org-level scopes only |

`repo` is a coarse scope, and it is coarse because git push over HTTPS needs it. If that is more than you want to grant, the narrow path is a fine-grained PAT limited to the specific repositories you intend to review, exported as `GITHUB_TOKEN`. Crosscheck reads the token from `gh`'s keyring first and falls back to `GITHUB_TOKEN` / `GH_TOKEN`, so a scoped PAT in your shell is a drop-in.

Without the hook scopes, `watch` still runs — it just cannot register its own webhook, and you point one at the tunnel URL yourself.

---

## Webhooks: registration and removal

`crosscheck watch` registers hooks at startup and removes them at shutdown.

**Registered:** one hook per monitored org (preferred) or per monitored repo, `active: true`, events `pull_request` and `issue_comment` only, `content_type: json`, pointed at your tunnel URL, with an HMAC secret. If a Crosscheck hook already exists, the existing one is reused and its event list patched rather than a second one created — restarts do not accumulate hooks.

**Removed:** on `Ctrl-C` or `SIGTERM`, `watch` deletes every hook it registered in that session before exiting.

**The gap you should know about:** an abnormal exit — uncaught exception, `SIGKILL`, power loss — skips that cleanup, and the hook stays registered and pointed at a tunnel URL that no longer answers. GitHub will retry deliveries, fail, and eventually show the hook as failing. Nothing leaks (the endpoint is gone, and the payload was going to your machine), but the hook is orphaned. Two ways to clear it:

- Start `watch` again. It finds the existing hook and reuses it, which also repoints it at the new tunnel URL.
- Delete it by hand: repo or org **Settings → Webhooks**, remove the entry whose payload URL is your old tunnel.

Note that with `tunnel.backend: smee`, the channel URL is stable and hooks are *meant* to outlive the session — that is the point of using smee. They persist until you delete them.

---

## What Crosscheck can change

The workflow is a sequence of steps, and each step's mutations are listed below. What runs is `~/.crosscheck/workflow.yml`, narrowable per repo — so this table is also the menu of what you can switch off.

| Step | What it writes to your repo |
|---|---|
| **review** | One PR comment (the review, with a hidden `<!-- crosscheck: ... -->` annotation). One commit status, context `crosscheck/review`: `pending` while running, then `success` or `failure`. Optionally one Linear comment. **No code.** |
| **recheck** | Same as review — a second comment, and release of the pending status. **No code.** |
| **fix** | Code. Commits to the PR's own branch and pushes there, plus a "fix applied" comment. If that push cannot land (protected branch, deleted branch, fork), it pushes the same commit to `fix/cr-<pr>-review-issues`, opens a follow-up PR targeting the original branch, and labels it `cr-autofix`. In `delivery.mode: comment` it pushes nothing and posts the diff as a suggestion instead. |
| **conflict-resolve** | Code. Merges the base branch into the PR branch, resolves conflicts, and pushes the merge commit to the PR branch, plus a comment. Skipped for fork PRs. |

Boundaries that hold across every step:

- **Never merges.** No command merges a pull request — there is no code path from any verdict to a merge. `crosscheck scan` will tell you a PR looks merge-ready; a human or your own automation acts on that.
- **Never touches your base branch.** Pushes go to the PR's head branch or to a new `fix/cr-*` branch. `main` and `staging` are only ever read.
- **Never force-pushes over your work.** A rejected non-fast-forward push is retried by rebasing onto the remote branch; if that fails it gives up and falls back to the follow-up PR.
- **Never edits outside the clone.** All work happens in a `mkdtemp` directory that is deleted when the step finishes, pass or fail.
- **Repo review guidance is read from the base branch,** not from the PR — a PR cannot rewrite the rules it will be reviewed under.
- **Automation triggers are authenticated.** The comment bridge that advances a workflow only fires for annotations posted by the token's own account; a comment from anyone else carrying the same hidden marker is ignored and logged as `annotation_injection_blocked`.

One boundary is *not* Crosscheck's to enforce, and you should know which: **what the reviewer agent may execute inside the clone is the vendor CLI's decision, not Crosscheck's.** Crosscheck itself never runs your project's code — no install, no test, no build. For Claude steps it passes an explicit tool allowlist of `Bash(git diff)` and `Bash(git log)`, so a review is confined to reading history. For Codex steps it invokes `codex exec` and passes no sandbox override, so the agent operates under Codex's own default policy for non-interactive runs — which necessarily permits writing files in the clone, since that is how a Codex fix lands. If your threat model requires a specific sandbox for agent execution, set it in the Codex CLI's own configuration; Crosscheck will not override it.

---

## Trying it on one PR first

Fully read-only. Clones the repo, runs the review, prints the comment it *would* post, and exits. No comment, no commit status, no Linear write, no lock:

```bash
crosscheck run https://github.com/acme/web/pull/245 --dry-run
```

When you want the comment but still no code changes:

```bash
crosscheck run https://github.com/acme/web/pull/245 --review-only
```

Neither command needs a webhook, a tunnel, or `watch`. There is also a [public fixture PR](./fixture-pr.md) if you would rather not point a first run at your own code.

---

## Turning off auto-fix

Three levels, from narrowest to broadest.

**One repo, permanently** — review and recheck only, no code ever pushed to it:

```bash
crosscheck alter acme/legacy-service --review-only
```

The override lands in `~/.crosscheck/workflows/acme__legacy-service.yml` and is read per PR event, so it takes effect without restarting `watch`. `crosscheck alter acme/legacy-service --show` prints what is in force.

**Everywhere, but keep the suggestions** — fixes are posted as a diff in a comment instead of pushed:

```yaml
post_review:
  auto_fix:
    delivery:
      mode: comment
```

**Everywhere, entirely** — remove the `fix` and `recheck` steps from `~/.crosscheck/workflow.yml`, or narrow each repo with `crosscheck alter <repo> --steps review`.

---

## Secrets and local logs

**Secrets are never written to config.** `crosscheck.config.yml` stores environment variable *names* (`api_key_env: LINEAR_API_KEY`), never values. The GitHub token comes from `gh`'s keyring or your environment at call time. The webhook HMAC secret is read from your environment.

**The one place a token is embedded is the clone URL** (`https://x-access-token:<token>@github.com/...`), which is how git authenticates over HTTPS. Every log and error path that could carry that URL runs it through a redactor first, so it appears as `x-access-token:[REDACTED]`. Use `clone_protocol: ssh` if you would rather it never be constructed.

**Logs are local files, and that is the only place they go.** `~/.crosscheck/logs/<date>.ndjson`, one JSON object per line, enabled by default (`logs.enabled`), pruned by age (`logs.retention_days`, default 30). They power `crosscheck diagnose`, `optimize`, and `impact` — all of which read these files and make no network calls.

What a standard log line contains: repo and PR number, event name, verdict, vendor and model, token counts, durations, commit shas, error category. What it deliberately does not contain: **source code, diffs, prompts, review text, PR titles or bodies, or author logins.**

Those richer fields exist behind `logs.extended.enabled`, which is **off by default and not exposed by any CLI flag or by `onboard`** — it can only be turned on by hand-editing config, and every line it writes is tagged `"_extended": true` so it can be filtered or scrubbed separately. Turning it on is a deliberate act; nothing in the product nudges you toward it.

To keep no local history at all, set `logs.enabled: false`. `diagnose`, `optimize` and `impact` will have nothing to read, which is the whole trade.

Other state under `~/.crosscheck/`: your config, per-repo workflow overrides, and small caches of already-seen commit shas and diff hashes (used to avoid re-reviewing the same code). Shas and hashes, no content.

---

## Reporting a security issue

Email <yi@inductive.network> rather than opening a public issue.
