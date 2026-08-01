# Linear identity setup for your workspace

crosscheck can mirror a review verdict onto the Linear issue a PR belongs to. This
guide gets those writes attributed to *crosscheck* rather than to whoever's API key
the daemon happens to hold.

It assumes no prior Linear API experience. Budget about five minutes.

---

## Why this exists

By default an agent writing to Linear uses whatever API key the operator supplied —
usually a person's personal key. Every comment then looks like that person wrote it,
and there is no way to tell agent activity from human activity.

There are two tiers you can adopt, in increasing order of strength.

| Tier | Mode | Setup | How writes appear |
|---|---|---|---|
| **T0** | `api_key` | none beyond a key | Your account, with a `🤖 crosscheck · crosscheck` signature line |
| **T1** | `client_credentials` | one OAuth app, ~5 min | The app itself (botActor), via `createAsUser` |

T0 works everywhere and is the default. T1 is recommended — it is the only tier where
Linear itself, not just a text convention, distinguishes the writer.

---

## T0 — api_key (zero setup)

Create a personal API key under **Linear → Settings → API → Personal API keys**, then:

```bash
export LINEAR_API_KEY=lin_api_...
```

```yaml
linear:
  enabled: true
  auth:
    mode: api_key
  team_keys:
    - IN          # your team's key prefix
```

Every write leads with `🤖 crosscheck · crosscheck`. Linear still records your account
as the author — the signature is a convention, not an identity.

---

## T1 — client_credentials (recommended)

### 1. Create an OAuth application

Go to **Linear → Settings → API → OAuth applications → Create new**.

Fill in a name (`crosscheck`, or whatever you want to see on comments) and an icon.

> **Gotcha:** the form **requires a Redirect URI** even though client credentials never
> uses one. Any placeholder URL on a domain you control is fine —
> `https://example.com/callback`. It is never called.

### 2. Enable the client credentials toggle

On the application page, enable **Client credentials**. Without this the token mint in
step 5 returns `invalid_client`.

Also authorize the app for your workspace with **app-actor** ("application acts as
itself") so writes render as the app.

### 3. Choose scopes

`read,write` covers issues and comments — that is all crosscheck needs.

> **Gotcha:** `read,write` does **not** cover initiatives. `initiative:read` and
> `initiative:write` are separate scopes. Add them only if something else in your
> workspace needs them. Skip the admin scope.

### 4. Store the credentials

Copy the client ID and secret into your environment — never into the config file:

```bash
export LINEAR_CLIENT_ID=...
export LINEAR_CLIENT_SECRET=...
```

### 5. Verify the mint by hand

Confirm the credentials work before wiring crosscheck up. The form body goes through
**stdin**, so the secret never lands in your shell history or in `ps` output:

```bash
printf 'grant_type=client_credentials&client_id=%s&client_secret=%s&scope=read,write' "$LINEAR_CLIENT_ID" "$LINEAR_CLIENT_SECRET" | curl -s -X POST https://api.linear.app/oauth/token -H 'Content-Type: application/x-www-form-urlencoded' --data @- 
```

A successful response contains `access_token`. If you get `invalid_client`, revisit
step 2 — the toggle is the usual cause.

### 6. Configure crosscheck

```yaml
linear:
  enabled: true
  auth:
    mode: client_credentials
    client_id_env: LINEAR_CLIENT_ID
    client_secret_env: LINEAR_CLIENT_SECRET
    scopes: "read,write"
  identity:
    actor: crosscheck
  comment_on:
    - APPROVE
    - NEEDS_WORK
    - BLOCK
  team_keys:
    - IN
```

Run a review against a PR whose branch or body references a Linear issue. The comment
should appear authored by the app, not by you.

---

## Verifying which identity you're on

`crosscheck status` shows a **Linear** section whenever `linear.enabled` is true. It
resolves the configured identity for real — minting a T1 token if that's the mode —
and reports what a write would render as:

```
  Linear
  ✓ auth mode             client_credentials
    organization          Inductive Network
  ✓ writes as             crosscheck/<step> (app actor)
```

On T0 it names the human account instead, because that's the state worth seeing:

```
  Linear
  ✓ auth mode             api_key
    organization          Inductive Network
  ✗ writes as             yi@example.com (human — switch to client_credentials)
```

Run this before and after a cutover. The `✗` is the condition to eliminate.

---

## Deploying with an existing OAuth app

If your organization already operates a gateway app, point the daemon at its
credentials rather than creating a second app. Only the env var *names* go in config:

```yaml
linear:
  enabled: true
  auth:
    mode: client_credentials
    client_id_env: LINEAR_HB_AGENT_GATEWAY_CLIENT_ID
    client_secret_env: LINEAR_HB_AGENT_GATEWAY_CLIENT_SECRET
  identity:
    actor: crosscheck
    per_step_actor: true
```

Cutover sequence:

1. Make the gateway credentials available to the **daemon's** environment — not just
   your interactive shell. A systemd unit or launchd plist needs them explicitly.
2. Run `crosscheck status` and confirm `writes as ... (app actor)`.
3. Run one review end to end and confirm the Linear comment is authored by the app.
4. Only then retire the old personal API key from the daemon's environment.

Step 4 last, deliberately: until steps 2 and 3 pass, the old key is your rollback.

---

## How crosscheck finds the issue

Checked in order — branch name, then PR title, then PR body. Within each, an explicit
URL wins over a bare identifier.

1. **A `linear.app` issue URL** — `https://linear.app/acme/issue/IN-2269/slug`. Works
   with no configuration, because it is unambiguous.
2. **A bare identifier** — `IN-2269`, matched case-insensitively so a branch like
   `feat/in-2269-thing` resolves. **Only for keys listed in `team_keys`.**

That second restriction is deliberate. `UTF-8`, `SHA-256`, `ISO-8601`, `GPT-5` and
`RFC-2119` all have the same shape as a Linear identifier. Reading the wrong issue is
harmless; *commenting* on the wrong issue is not. So bare matching stays off until you
name your team keys.

If no issue is found, crosscheck skips the Linear write and the review proceeds
normally.

---

## Security properties

- **Secrets never reach argv.** The mint sends them in a POST body; the GraphQL token
  rides in a header. Nothing shows up in `ps`.
- **Secrets never reach logs or error traces.** Failure messages carry HTTP status
  codes, not credentials.
- **Tokens are minted per run** and held in memory only. Linear app tokens have a ~30
  day TTL, but crosscheck treats them as ephemeral.
- **A failed T1 mint aborts the run.** crosscheck will not fall back to `api_key` when
  you configured `client_credentials` — a silent downgrade would put agent writes back
  under a human's name, which is the exact failure this feature exists to prevent. You
  get a non-zero exit and a message naming the env var to fix.
- **Config holds env var *names*, never values.**

---

## Troubleshooting

| Symptom | Cause |
|---|---|
| `LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET is not set` | Env vars missing from the daemon's environment (not just your shell) |
| `token mint rejected (HTTP 401)` | Client credentials toggle off, or wrong secret |
| `Linear API error: Access denied` | Scope too narrow — needs `write` |
| Comment never appears, no error | No issue ref found. Set `team_keys`, or put a `linear.app` URL in the PR body |
| Comment appears as you, not the app | Still on `mode: api_key` |
