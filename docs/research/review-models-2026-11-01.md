# Crosscheck model and pricing refresh — 2026-11-01

Reviewers need a model that catches actionable defects before merge. A cheaper
model that misses those defects, or forces another fix/recheck round, can raise
the cost of shipping. This refresh updates the available choices and makes
OpenCode tier selection work; it does not claim a new review-quality benchmark.

## Decision and evidence

Use Claude Haiku 5.5 / Sonnet 5.5 / Opus 5.5 as the built-in Claude tier map.
The current catalog lists these IDs; Sonnet 5.5 is $2/$10 and Opus 5.5 $4/$20
per million input/output tokens. Cache reads are $0.10/$0.20 respectively.
Haiku is $0.10/$0.50 up to 100k input tokens, then $0.50/$2.50.
[Anthropic catalog](https://platform.claude.com/docs/en/models/overview),
[pricing](https://platform.claude.com/docs/en/about-claude/pricing).

Keep the existing Codex API default map: GPT-6 Luna / GPT-6.1 Sol / GPT-6
Astra, with short-context rates $0.10/$0.50, $2/$10, $10/$50. GPT-6.1 Terra
($1/$5) is a cheaper evaluation candidate, not a replacement justified by
review evidence. Above 272k input, the listed GPT rates change. API rates do
not establish subscription usage costs or account availability.
[OpenAI pricing](https://developers.openai.com/api/docs/pricing).

OpenCode Console lists GLM-5.3-Flash, GLM-5.3, MiniMax M3, DeepSeek V4.1
Flash, DeepSeek V4 Pro and Kimi K3. The full comparison is maintained in
[the strategy table](../dynamic-thoroughness.md#65-the-strategy-table) and
`src/config/review-strategy.json`; all Console rows use `opencode/` IDs and
Console rates. Kimi cache writes cost $3/MTok. A public catalog entry is not
proof that a configured account can call that model.
[OpenCode Console models and prices](https://opencode.ai/v2/docs/console/models/).

Direct-provider rates are separate. DeepSeek's direct API now serves V4.1 Flash
under `deepseek-flash`, with peak/off-peak schedules; V4 Flash is retired.
Those prices cannot be assigned to `opencode/deepseek-v4-pro` or an arbitrary
Alibaba/OpenRouter route. [DeepSeek pricing and lifecycle](https://api-docs.deepseek.com/quick_start/pricing/).

Native reasoning controls are not proof of an OpenCode variant. DeepSeek
supports disabled thinking and low/high/max; Kimi K3 supports low/high/max
with always-on thinking. The OpenCode catalog does not establish the exact
variant names on every route. Until wire evidence exists, catalog candidates
have an empty `opencode_variants` ladder, retain provider defaults, and report
no requested effort. An operator can select a verified `#variant` explicitly.
[DeepSeek thinking controls](https://api-docs.deepseek.com/guides/thinking_mode/),
[Kimi K3 guide](https://platform.kimi.ai/docs/guide/kimi-k3-quickstart).

The proposed OpenCode tier profile (GLM Flash / GLM / Kimi) is an **evaluation
hypothesis** based on current availability and price. It is not auto-enabled.
No contemporary matched review experiment supports a quality ranking across
these models. Running the same underlying family through a different CLI does
not provide model independence. Existing routing and agent priority still own
assignment; this change does not add a family-aware router.

## Verify a profile before using it

1. Read the exact route's provider catalog and pricing, including cache writes,
   context tiers and fees. Check IDs with `opencode models`; separately confirm
   the operator's account can use them. Do not infer access from saved auth.
2. Set a complete `vendors.opencode.model_tiers` map in operator config, leaving
   `model` unset. An explicit global pin wins; missing tiers use the operator's
   CLI default. The schema is in `src/config/schema.ts`; precedence is tested
   in `src/__tests__/review-models.test.ts`.
3. Check the installed CLI's variant syntax. An explicit `#variant` is emitted
   as V1 `--variant` or a V2 suffix. `opencode-process.test.ts` verifies both.
   Record a wire fixture before populating `opencode_variants` in the policy;
   native API documentation alone is insufficient.
4. Replay the same frontend/backend PRs, seeded defects and risk-critical cases
   on each candidate. Record actionable recall, false positives, completion,
   latency, fixer regressions and total round cost. Compare author/reviewer
   model families, not just CLI names. No paid replay was run in this refresh.
5. Update both policy files, the strategy table and this evidence note when a
   model is promoted. Bump the strategy version for changed routing, refresh
   `updated`, then run `npm test`, `npm run typecheck`, `npm run build`,
   `npm run verify:strategy`, and `node scripts/verify-model-tier-sources.mjs`.
   Model source checks detect missing strings, not changed numeric prices;
   prices still need human/source comparison every 30 days.

Roll back the opt-in map to restore the operator's default. Reverting the
policy commit restores prior built-in Claude defaults. No standing daemon,
operator config, provider credit balance or merge gate is changed by this PR.
