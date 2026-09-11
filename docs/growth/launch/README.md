# Launch assets — index and pre-publish checklist

Drafts for [#198](https://github.com/humanbased-ai/crosscheck/issues/198). Nothing here has been published, and nothing here should be published without the decisions below being made by a human.

| Asset | File | State |
|---|---|---|
| Long-form essay | [`essay-stop-letting-one-agent-review-its-own-code.md`](./essay-stop-letting-one-agent-review-its-own-code.md) | Draft, complete |
| X / LinkedIn posts | [`posts.md`](./posts.md#x--twitter) | Draft, three X variants + one LinkedIn |
| Show HN | [`posts.md`](./posts.md#hacker-news--show-hn) | Draft, two title options + first comment |
| Reddit / community | [`posts.md`](./posts.md#reddit) | Draft, r/ExperiencedDevs, r/ClaudeAI, r/ClaudeCode, r/ChatGPTCoding |
| README-linked demo clip | [`assets/demo-block-to-approve.mp4`](../../../assets/demo-block-to-approve.mp4) · [`.gif`](../../../assets/demo-block-to-approve.gif) | **Produced** ([#201](https://github.com/humanbased-ai/crosscheck/issues/201)). 85s full cut and a 34s README loop, recorded from [`crosscheck-proof-fixture#2`](https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/2) |

## The argument these assets make

The product claim ("route agent PRs to a different agent") is not what earns attention — plenty of tools claim adjacent things. What earns attention is the census finding, which is genuinely counter-intuitive:

> The reviewer was essentially never wrong, and 62% of PRs merged past it anyway, median four minutes after the last review. Review quality was never the binding constraint. And fixing the gate first would have made it worse, because the loop was unbounded.

Every asset leads with that and arrives at the product second. Sequencing it the other way turns a defensible technical finding into an ad.

## Decisions needed before publishing

1. **Publication venue for the essay.** These drafts link to the repo. If it goes on `blog.humanbased.ai` alongside [What 295 Agentic PRs Taught Us](https://blog.humanbased.ai/posts/agentic-pr-quality-crosscheck/), the two overlap in evidence and should cross-link rather than restate — the earlier post covers PR quality, this one covers why a correct review still doesn't change a merge.
2. **Whether to publish the 4-minute number at all.** It is the strongest hook in the essay and it is also a public admission that our own team merged past correct findings 62% of the time. That is a deliberate credibility trade: it makes the piece believable and it says something unflattering about our discipline. Worth an explicit yes.
3. **Whether the operator-run gate is in the published package by publish time.** `crosscheck merge <pr-url>` is implemented on `staging`: by default it requires an `APPROVE` covering the exact head commit and GitHub must report the PR mergeable. It is not a branch-protection status and no verdict, webhook, or scheduled run invokes it automatically. Before publishing these drafts, verify that the released npm version includes the command; otherwise defer publication or revise the new current-product wording in the essay and Show HN comment.
4. ~~**Timing against [#200](https://github.com/humanbased-ai/crosscheck/issues/200)** (npm scope).~~ **Resolved.** `@humanbased/crosscheck` is published — `latest` is `1.3.0`, both the `crosscheck` and `ck` bins ship, and `@motivation-labs/crosscheck` is deprecated with a migration message pointing at the new scope. The install line every draft uses now works, so this no longer gates publishing.
5. ~~**Demo clip.**~~ **Produced** — but read this before linking it. The clip runs the real arc from [`crosscheck-proof-fixture#2`](https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/2), and that arc took **three rounds**: the first repair restored a dropped ownership filter and left a test asserting the old query shape, and the next review caught the regression its own fix step had introduced. The full cut shows all of it, deliberately.

   That is an asset and a liability at once, and it is the same trade as decision 2. It is the most convincing thing in the recording — a loop that catches its own mistakes is a much stronger claim than one clean pass — and it also shows the fix step shipping a broken test, and a third round blocking on a concern the reviewer's own summary had already called resolved. Both of those are now filed as bugs ([#317](https://github.com/humanbased-ai/crosscheck/issues/317), [#318](https://github.com/humanbased-ai/crosscheck/issues/318)) and fixed, so the clip records behaviour that no longer ships. **Decide whether to re-record against the fixed pipeline before launch, or to lead with the three-round version as the honest artifact.** The drafts still reference no clip, so either choice needs an edit rather than a removal.

   Note also that the Show HN comment and the essay both have a natural slot for it, and neither uses one yet.

## Fact-check trail

Every number in these drafts comes from [`docs/dynamic-thoroughness.md`](../../dynamic-thoroughness.md), census window 2026-07-30 → 2026-08-07:

| Claim | Source |
|---|---|
| 400 merged PRs, 199 crosscheck-engaged | Corpus line |
| 40 sampled findings: 39 verifiable, 0 false; 1 unverifiable | §2 label table |
| 33 of 39 verifiable were defect-grade (~85%) | §2 label table + calibration note |
| 6 true but severity-inflated | §2 label table |
| 94% of reviews land before merge | §0 measured table |
| 38% of PRs reach APPROVE | §0 measured table |
| Median 4 minutes, last review → merge | §0 measured table |
| 62% merged past; 56% of those within 5 min | §0 narrative |
| CR-Bench 3.6–5.1% precision, non-comparable | §2 calibration note |
| The three concrete defects (#8, #6, #13) | §2 representative confirmed defects |

If that document is revised, these drafts are stale and must be re-checked against it before posting.

## Posting order, once approved

1. Publish the essay. Everything else links to it.
2. Show HN, weekday morning US Eastern. Be present for the first two hours.
3. X and LinkedIn the same morning, after the HN post is live.
4. Reddit last, and only where the sidebar permits it. Check each community's self-promotion rule — several ban it outright and moderators enforce it.

Do not seed upvotes or comments anywhere. It is detectable and it ends the launch.
