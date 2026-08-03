# Linear identity: the shared contract

**Contract version: 1.1.** Additive changes bump the minor; removing or renaming a
field is a major bump and a breaking change for every adopter. 1.1 added
`identity.per_step_actor`, `identity.icon_url`, and the `{model}` / `{reviewer}` /
`{icon}` signature placeholders — all optional, all defaulted, so a 1.0
implementation stays conformant.

crosscheck and symphony are separate open-source products that both write to Linear.
This document is the contract they implement identically, so an operator configures
identity once and it means the same thing in both — and so a third product can adopt
it without inventing a fourth shape.

Humanbased's HB Agent Gateway is not special here. It is one `client_credentials`
configuration of this contract.

For step-by-step setup, see [linear-identity.md](linear-identity.md). This document is
the specification.

---

## Config shape

```yaml
linear:
  enabled: false                        # opt-in; default off
  auth:
    mode: api_key                       # api_key | client_credentials
    api_key_env: LINEAR_API_KEY
    client_id_env: LINEAR_CLIENT_ID
    client_secret_env: LINEAR_CLIENT_SECRET
    scopes: "read write"
  identity:
    actor: crosscheck                   # product name; symphony uses `symphony`
    signature: "🤖 {actor} · {product}"
    per_step_actor: true                # suffix the actor with the unit of work
```

Every key under `auth` ending in `_env` names an **environment variable**, never a
secret. A product implementing this contract must not accept an inline credential in
config. Non-credential fields (`mode`, `scopes`, everything under `identity`) are
ordinary config values and are written literally.

---

## Tiers

| Tier | Mode | Setup | Attribution |
|---|---|---|---|
| **T0** | `api_key` | none | Operator's account; signature line only |
| **T1** | `client_credentials` | one OAuth app | The app itself (botActor), via `createAsUser` |
| **T2** | public app | none (future) | Centrally operated app — see IN-2272 |

T0 is the default so an existing `api_key` config keeps working unchanged. T2 is not
implemented; it is gated on T1 adoption feedback.

---

## Required behaviours

A conforming implementation must:

1. **Lead every write with the rendered signature.** `{actor}` and `{product}` are the
   defined placeholders. This is T0's entire attribution mechanism and is retained in
   T1 as fallback text.

2. **Mint T1 tokens per run, not per write.** Linear app tokens carry roughly a 30-day
   TTL; treat them as ephemeral anyway. Resolve identity at run start so a
   misconfiguration fails before any expensive work.

3. **Abort when a configured T1 mint fails.** Never fall back to `api_key`. A silent
   downgrade re-attributes agent writes to a human, which is the failure the whole
   contract exists to prevent. Surface the env var name that needs fixing.

4. **Keep secrets off argv.** The mint sends credentials in a POST body; the token
   travels in an `Authorization` header. Nothing reaches a process list. Failure
   messages carry HTTP status codes, never credential material.

5. **Preserve backward compatibility.** An existing `api_key` configuration must keep
   working with T0 semantics and no new required keys.

---

## Per-worker actors

`per_step_actor: true` suffixes the actor with the unit of work, so a fleet does not
collapse into one indistinguishable bot:

| Product | Unit of work | Example actor |
|---|---|---|
| crosscheck | workflow step | `crosscheck/review`, `crosscheck/fix`, `crosscheck/recheck` |
| symphony | worker | `symphony/worker-3` |

In T1 the suffixed name is what `createAsUser` sends, so it is what Linear renders. In
T0 it reaches only the signature line — still worth doing, since that is all T0 has.

The suffix composes: deriving twice yields `crosscheck/review/shard-2`. Deriving must
not mutate the base identity, so one run can produce several scoped identities from a
single minted token.

---

## The token mint

```
POST https://api.linear.app/oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=client_credentials&client_id=<id>&client_secret=<secret>&scope=read+write
```

Response: `{ "access_token": "..." }`, used as `Authorization: Bearer <token>`.

T0 keys are sent **bare** — `Authorization: <key>` with no `Bearer` prefix. Getting
this backwards is the most common integration bug.

---

## Two Linear gotchas worth encoding

Both cost real debugging time and neither is discoverable from the API:

- The OAuth application form **requires a Redirect URI** even though
  `client_credentials` never uses one. Any placeholder on a domain you control works.
- `read write` does **not** cover initiatives. `initiative:read` and `initiative:write`
  are separate scopes.

---

## Reference implementation

crosscheck's lives in `src/linear/`:

| Concern | File |
|---|---|
| Auth resolution, token mint, `withWorker` | `identity.ts` |
| All Linear API traffic | `client.ts` |
| Which issue a write targets | `ref.ts` |
| Credential reads (the only place) | `../config/loader.ts` |
