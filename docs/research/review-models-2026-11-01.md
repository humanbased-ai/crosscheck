# User-specific Crosscheck review models — 2026-11-01

A public model catalog does not tell a reviewer which agents a user installed,
which custom deployment they configured, or which free tier still has quota.
`ck init` now records that user's model pool and budget preference. `ck watch`
can update advertised free candidates during its session without changing an
active review or opting into a new paid route.

The user confirmed a ceiling on **every provider's flagship**, including free
listings. Defaults therefore stop at Sonnet 5.5 and GPT-6 Sol. Fable, Opus,
Astra, Kimi K3, GLM 5.3, DeepSeek Pro and MiniMax M3 remain excluded reference
models. Unknown custom deployments require explicit non-flagship classification;
an opaque name alone cannot establish that classification.

## What the scan establishes

| Agent | Source | Interpretation |
|---|---|---|
| Codex | `debug models` and user `config.toml`, including active profile | CLI-visible model IDs and efforts; configured custom providers are reported separately |
| Claude | User settings, model allow/deny lists, alias overrides, picker metadata and allowlisted model variables | User preference and declared model identity; unknown deployments require classification |
| OpenCode | `models --verbose --pure`, `debug config --pure` in a temporary directory | Runtime-visible provider/model IDs, advertised prices, exact variant names and configured default |

None of these is a paid inference request or proof of account entitlement.
OpenCode's scanner projects only model IDs/family, price and variant names;
provider headers, options, endpoint URLs, hooks and credentials are not saved.
Read failures report a bounded generic diagnostic rather than raw CLI output.
Zero placeholders on a private route are treated as unknown unless its ID advertises a free variant; built-in OpenCode-provider free prices are retained.
External plugins are disabled during OpenCode discovery. A CLI that cannot
provide this metadata leaves the prior strategy intact.

Codex's isolated executor uses `--ignore-user-config`, so it drops custom provider
definitions. A configured custom Codex provider is therefore not auto-selected;
use its supported OpenCode route instead. Codex's official app-server
`model/list` is an alternative future discovery source; it also distinguishes
catalog capabilities from account-dependent availability.
[Codex developer commands](https://learn.chatgpt.com/docs/developer-commands),
[app-server models](https://learn.chatgpt.com/docs/app-server#models).

Claude aliases such as `best` and `opusplan`, model overrides, and custom picker
`behavesAs` fields can hide a premium identity. The scan resolves known identities
before filtering. The runner also rejects a reported flagship substitution.
[Claude model configuration](https://code.claude.com/docs/en/model-config),
[settings](https://code.claude.com/docs/en/settings-reference).

OpenCode's CLI inventory can differ from its public Console catalog. A read-only
scan during this session returned a free GLM Flash listing and DeepSeek variants
but not every paid model on the public page. Derive the pool from the installed
CLI rather than assuming the public list is usable. Prices and variants are
route-specific; native provider rates and effort names cannot be copied to an
arbitrary gateway route.
[OpenCode CLI](https://opencode.ai/docs/cli/),
[configuration](https://opencode.ai/docs/config/),
[models](https://opencode.ai/docs/models/),
[Console prices](https://opencode.ai/v2/docs/console/models/).

## Preferences and limits

`balanced` favors a standard eligible model for normal/risky work. `speed-max`
favors a fast class and lower effort; these classes are heuristics, not measured
latency. `cost-min` favors advertised free and cheaper allowed models while
raising effort on risk and unresolved findings. Price comparisons use a fixed
100k-input/48k-output scenario; they are API-equivalent estimates, not subscription
invoices. Unknown prices are never treated as zero.
[Anthropic pricing](https://platform.claude.com/docs/en/about-claude/pricing),
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).

The saved review pool takes precedence over legacy global authoring/fixing pins.
Reviews and rechecks share the ceiling. Risk does not unlock a flagship or
unbounded effort. At the allowed ceiling, the judge holds and the scope narrows;
existing round limits still stop the loop. Free quota is not assumed: an exhausted
route cools down for 15 minutes, with retries restricted to already permitted
models. A failed stream cannot produce an approving verdict.

## Configure and verify

1. Run `ck init`. Inspect the detected agents, warnings, model sources and price
   labels; select a preference and allowed models. Classify a custom deployment
   only when its underlying non-flagship identity is known. Reruns preserve the
   selected model IDs, saved preference, disabled agents and unrelated settings.
2. Inspect `quality.review_models`, `preference`, and `excluded_models` in the
   saved configuration. Keep private route prices explicit or unknown. No raw
   provider configuration or credentials belong in this inventory.
3. Set `refresh_free_models: true` to let `ck watch` refresh metadata before new
   reviews after `model_refresh_sec` (900 seconds by default). Only enabled agents
   participate. A removed, newly paid or unknown-price free route is dropped from
   the session pool; active review snapshots remain unchanged. The watcher does
   not rewrite the user's configuration.
4. Replay seeded defects and the same PRs before making quality claims. Measure
   actionable recall, false positives, completion, latency, fixer regressions and
   total round cost. No paid replay or quality superiority is claimed here.
5. Run `npm test`, `npm run lint`, `npm run typecheck`, `npm run build`,
   `npm run verify:strategy`, `node scripts/verify-model-tier-sources.mjs`, and
   `node scripts/smoke-init.mjs` (POSIX fixture agents; build first).
   Source-string checks do not verify numeric price changes; read the actual
   provider prices each month.

Rollback: disable free refresh or remove the saved review pool to return to the
bounded built-in review defaults. The flagship ceiling remains enforced. Revert
the policy commit to restore prior behavior. This change does not deploy or
restart a standing watcher.
