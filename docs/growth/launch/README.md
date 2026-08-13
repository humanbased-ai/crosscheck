# Launch assets — index and pre-publish checklist

Drafts for [#198](https://github.com/humanbased-ai/crosscheck/issues/198). Nothing here has been published, and nothing here should be published without the decisions below being made by a human.

| Asset | File | State |
|---|---|---|
| Long-form essay | [`essay-stop-letting-one-agent-review-its-own-code.md`](./essay-stop-letting-one-agent-review-its-own-code.md) | Draft, complete |
| X / LinkedIn posts | [`posts.md`](./posts.md#x--twitter) | Draft, three X variants + one LinkedIn |
| Show HN | [`posts.md`](./posts.md#hacker-news--show-hn) | Draft, two title options + first comment |
| Reddit / community | [`posts.md`](./posts.md#reddit) | Draft, r/ExperiencedDevs, r/ClaudeAI, r/ClaudeCode, r/ChatGPTCoding |
| README-linked demo clip | — | **Not produced.** Blocked on [#201](https://github.com/humanbased-ai/crosscheck/issues/201) |

## The argument these assets make

The product claim ("route agent PRs to a different agent") is not what earns attention — plenty of tools claim adjacent things. What earns attention is the census finding, which is genuinely counter-intuitive:

> The reviewer was essentially never wrong, and 62% of PRs merged past it anyway, median four minutes after the last review. Review quality was never the binding constraint. And fixing the gate first would have made it worse, because the loop was unbounded.

Every asset leads with that and arrives at the product second. Sequencing it the other way turns a defensible technical finding into an ad.

## Decisions needed before publishing

1. **Publication venue for the essay.** These drafts link to the repo. If it goes on `blog.humanbased.ai` alongside [What 295 Agentic PRs Taught Us](https://blog.humanbased.ai/posts/agentic-pr-quality-crosscheck/), the two overlap in evidence and should cross-link rather than restate — the earlier post covers PR quality, this one covers why a correct review still doesn't change a merge.
2. **Whether to publish the 4-minute number at all.** It is the strongest hook in the essay and it is also a public admission that our own team merged past correct findings 62% of the time. That is a deliberate credibility trade: it makes the piece believable and it says something unflattering about our discipline. Worth an explicit yes.
3. **Whether the gate has shipped by publish time.** The essay says "bound the loop, then gate" as the correct order without claiming the gate is done. If a merge-blocking status ships first, the essay should say so — otherwise a reader who installs it will find no gate and feel misled.
4. **Timing against [#200](https://github.com/humanbased-ai/crosscheck/issues/200)** (npm scope). Every draft says `npm install -g @humanbased/crosscheck`. If the scope isn't claimed and published, the first thing a reader does will fail.
5. **Demo clip.** [#201](https://github.com/humanbased-ai/crosscheck/issues/201) is a 90-second AI-slop → merge-ready clip. The Show HN comment and the essay both have a natural slot for it; neither currently references one, so no placeholder needs removing if it isn't ready.

## Fact-check trail

Every number in these drafts comes from [`docs/dynamic-thoroughness.md`](../../dynamic-thoroughness.md), census window 2026-07-30 → 2026-08-07:

| Claim | Source |
|---|---|
| 400 merged PRs, 199 crosscheck-engaged | Corpus line |
| 0 false positives of 40 sampled findings | §2 label table |
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
