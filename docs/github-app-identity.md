# GitHub App review identity

Crosscheck has two GitHub roles:

| Role | Identity | Used for |
|---|---|---|
| **actor** | your account (`gh auth login` / `GITHUB_TOKEN`) | clone, push fixes, merge, locks, statuses |
| **reviewer** | your account **or** a GitHub App installation | review comments and fix summaries |

They are the same by default. Giving the reviewer its own identity is optional,
but it fixes one real annoyance: when crosscheck reviews a PR you opened, the
comment is authored by you, so it reads as a self-review. With an app, the
comment is authored by `<app-slug>[bot]` and the separation is visible on the PR.

The app is **never** used to mutate a repo — it cannot push, label, or merge.

## Create the app (once, by an org admin)

Organization **Settings → Developer settings → GitHub Apps → New GitHub App**.

| Field | Value |
|---|---|
| Name | `crosscheck-bot` (must be globally unique) |
| Homepage URL | your repo URL |
| Webhook → Active | **off** — crosscheck does not need webhooks from this app |

Repository permissions:

| Permission | Level | Why |
|---|---|---|
| Metadata | Read | mandatory for every app |
| Pull requests | **Read & write** | read PR files, post review comments |
| Issues | **Read & write** | PR conversation comments use the Issues API |
| Contents | Read only | not needed for review; grant write only if you also let the bot merge |

Then:

1. **Create** → note the **App ID**.
2. **Generate a private key** → download the `.pem` (shown once).
3. **Install App** → select the repos crosscheck should review.

Store the key where it cannot be committed:

```bash
mkdir -p ~/.crosscheck
mv ~/Downloads/crosscheck-bot.*.pem ~/.crosscheck/app.pem
chmod 600 ~/.crosscheck/app.pem
```

## Configure and verify

```bash
ck auth app --app-id 1234567 --key ~/.crosscheck/app.pem --repo owner/name
```

Crosscheck runs five probes in dependency order and only writes config when all
of them pass:

```
 ✓ private key        parses and signs RS256
 ✓ app credentials    crosscheck-bot (app 1234567)
 ✓ installation       humanbased-ai (id 98765432)
 ✓ repo access        humanbased-ai/crosscheck
 ✓ permissions        pull_requests:write issues:write

✓ Config written to ~/.crosscheck/config.yml
  reviews will be posted as crosscheck-bot[bot]
```

Other forms:

```bash
ck auth                    # show actor + reviewer, probe the configured one
ck auth app --check        # probe without writing
ck auth app --clear        # back to posting as your account
```

In CI, skip the file: put the PEM in an environment variable and point the
config at it (`private_key_env`, default `CROSSCHECK_APP_PRIVATE_KEY`). Literal
`\n` escapes in a single-line value are normalised.

## Config

```yaml
github:
  app:
    app_id: 1234567
    installation_id: 98765432        # null = resolve from the PR's repo
    private_key_path: ~/.crosscheck/app.pem
    private_key_env: CROSSCHECK_APP_PRIVATE_KEY
```

`app_id: null` (the default) means "post as me". A configured-but-broken app
**fails the run** with the fix in the message instead of silently falling back to
your account — a review attributed to the wrong identity is worse than a failed
run.

## Token lifecycle

- A signed RS256 JWT (`iss` = app id, 9-minute lifetime) authenticates the app.
- It is exchanged for an installation token (`POST /app/installations/{id}/access_tokens`).
- Installation tokens last one hour. They are minted on demand, cached in memory
  with their expiry, and refreshed 60 seconds before expiry. **No token is ever
  written to disk.**
- If `installation_id` is not pinned, crosscheck resolves it from the PR's repo
  on first use (`GET /repos/{owner}/{repo}/installation`).

## Branch protection caveat

A GitHub App **cannot be a code owner**. If a protected branch sets
`require_code_owner_reviews: true`, then even a successful bot review leaves the
PR in `REVIEW_REQUIRED` until a human code owner approves.

That is the safe default. If you deliberately want automation to satisfy the
rule, either drop `require_code_owner_reviews`, or move the branch to a
repository **ruleset** whose bypass list includes the app. Bypass is a big
hammer — scope it to the app, and keep human review for anything that can ship
a regression.

## Troubleshooting

| Probe fails | Fix |
|---|---|
| `private key` | The PEM is wrong or truncated. Generate a new key and re-point `--key`. |
| `app credentials` | `--app-id` does not match the key, or the key was revoked. |
| `installation` | The app is not installed on that account. Open the install URL printed. |
| `repo access` | The repo is not selected in the installation. Edit the installation. |
| `permissions` | Grant Read & write for `pull_requests` and `issues` on the app settings page. |

`ck auth` re-runs the same probes against the saved config, so it is the fastest
way to diagnose a setup that stopped working.

## Where the identity shows up

| Surface | What it reports |
|---|---|
| `ck auth` | actor, reviewer, and the full probe table |
| `ck init` | `reviewer identity` row (fails only when an app is configured but unusable) and a `code-owner` advisory |
| `ck status` | the same `reviewer` row, bounded to 10s so status stays responsive |
| watch / kickass board | `reviewing as <identity>` in the config panel |

The advisory fires when a configured repo's default branch sets
`require_code_owner_reviews: true`, and names the CODEOWNERS handles when the
file is readable. It is a note, not a failure: an advisory bot review is a valid
setup, and `ck` never blocks on it.
