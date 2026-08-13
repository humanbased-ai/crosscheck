# Launch posts — drafts

> **Not published.** These are drafts for a human to post. Every number traces to
> [`docs/dynamic-thoroughness.md`](../../dynamic-thoroughness.md). Read
> [`README.md`](./README.md) in this folder before posting anything — particularly the
> self-promotion rules per community, which differ and are enforced.

The through-line in all of them: **the reviewer being correct was not the bottleneck.** That is the one non-obvious thing we learned, and it is what earns attention. Lead with it rather than with the product.

---

## X / Twitter

**Version A — the finding (recommended)**

> We built a code reviewer for agent-authored PRs. Hand-checked 40 of its BLOCK findings against the source: 0 false positives.
>
> Then: 62% of PRs merged past those findings anyway. Median gap from review to merge — 4 minutes.
>
> Being right isn't a gate. What we did about it: [link]

**Version B — the failure mode**

> Ask the agent that wrote the patch to review it and it'll tell you the patch is good. The reasoning that produced the bug is the one judging it.
>
> Not a prompt problem. The blind spot and the reviewer share a context window.
>
> So: Claude-authored PRs go to Codex, and back. [link]

**Version C — one concrete defect**

> A function took an `expected_mode` param for dual-control confirmation and never put it in the request body. Two lines apart. Dual control silently bypassed. Tests passed.
>
> The agent that wrote it called it done. A different agent caught it.
>
> [link]

Thread continuation for A or B, if you want one:

> 2/ The census: 400 merged PRs, 199 crosscheck-engaged, one week.
>
> Reviews landed before merge 94% of the time. 38% of PRs reached APPROVE. 56% of the rest merged within five minutes of the review — or before it landed.
>
> 3/ The reason was ours: crosscheck read commit statuses but never created one. Its whole output was a comment, and it wasn't in any branch protection list. GitHub merged the second CI went green.
>
> 4/ The trap: gating first would have made it worse. Findings never stopped arriving, so an enforced unbounded loop turns "merged in 4 minutes" into "blocked for two days."
>
> Bound the loop, then gate, then optimize latency. In that order.
>
> 5/ MIT, runs on the claude and codex CLIs you already pay for. No hosted service, no per-review API bill.
>
> Try it read-only on one PR: `crosscheck run <pr-url> --dry-run`
>
> [repo link]

---

## LinkedIn

> **We measured our AI code reviewer and the result inverted the roadmap.**
>
> We build with coding agents daily. The failure mode that costs us isn't a broken build — CI catches those. It's what we've started calling early victory: a patch that passes CI, reads as complete, has a confident summary attached, and quietly carries a regression or a half-finished fix.
>
> Asking the agent that wrote the patch to review it doesn't help. The reasoning that produced the bug is the reasoning now judging it.
>
> So we routed each PR to a *different* agent — Claude-authored PRs to Codex, and back — with findings returning to the author agent for repair and a recheck before merge.
>
> Then we ran a census: 400 merged PRs over one week, 199 of them reviewed by the system. We sampled 40 of its blocking findings and hand-read each against the file it cited.
>
> Zero false positives. ~85% were genuine defects. Reviews landed before merge 94% of the time.
>
> And 62% of PRs merged straight past them. Median gap from last review to merge: four minutes.
>
> The problem was never review quality. The reviewer produced a comment, and a comment is not part of a merge decision. It appeared in no branch protection rule, so GitHub merged the moment CI went green.
>
> The counter-intuitive part: adding the gate first would have made things worse. Findings never stopped arriving across rounds, and enforcing an unbounded loop converts "merged past findings in four minutes" into "blocked for two days." Bound the loop, then gate, then optimize latency.
>
> Two things I'd take to any team shipping agent-authored code:
>
> → Don't let the author review its own work. Treat it as an architectural constraint, not a prompt preference.
> → Measure whether your review changes the merge decision — the share of real defects fixed inside the merge window. Not findings per PR.
>
> Crosscheck is MIT and runs on the CLIs you already pay for. Full census, including the two analytical approaches we abandoned, is in the repo.
>
> [repo link]

---

## Hacker News — Show HN

**Title** (80 char limit; both fit)

- `Show HN: Crosscheck – route agent-authored PRs to a different agent for review`
- `Show HN: We measured our AI code reviewer; being correct wasn't the bottleneck`

Prefer the first for a Show HN — it says what the thing is. Use the second as a regular submission of the essay if the Show HN doesn't land.

**First comment** (post immediately after submitting)

> Author here. Crosscheck routes each agent-authored PR to a *different* agent than the one that wrote it — Claude-authored PRs to Codex and vice versa — then sends findings back to the author agent to fix and rechecks before the PR is merge-ready. It shells out to the `claude` and `codex` CLIs you're already authenticated to, so there's no hosted service and no per-review API bill.
>
> The motivating failure isn't broken builds. It's patches that pass CI, read as complete, and carry a regression or a fix that addresses the symptom rather than the cause. Asking the authoring agent to review its own work doesn't catch those — the reasoning that produced the bug is the one judging it.
>
> The part I'd actually like feedback on is what happened when we measured it. We censused 400 merged PRs over a week (199 crosscheck-engaged), sampled 40 BLOCK findings, and hand-read each against the file it cited at the reviewed sha: 0 false positives, ~85% genuine defects, 94% landing before merge.
>
> And 62% of PRs merged past them anyway, median four minutes after the last review. The cause was structural and ours: crosscheck read commit statuses but never created one, so it appeared in no branch protection rule and GitHub merged as soon as CI went green. Its entire output was a comment.
>
> What surprised me is that fixing that first would have been harmful. Findings kept arriving across rounds, so enforcing an unbounded loop turns "merged past findings in four minutes" into "blocked for two days." The order has to be: bound the loop, then gate, then reduce latency.
>
> Honest limits: it never merges anything (no code path from verdict to merge), it doesn't replace human review, and your diff reaches Anthropic/OpenAI through their own CLIs under their terms — crosscheck adds no separate upload path. The census is one team, one week, our conventions; I'd be interested in whether the 4-minute number reproduces elsewhere or whether we're just undisciplined.
>
> Read-only first run: `crosscheck run <pr-url> --dry-run` clones, reviews, prints the comment it would post, and exits without touching the PR.
>
> MIT: [repo link]. The census, including two analytical approaches we abandoned, is in docs/dynamic-thoroughness.md.

**Notes for the poster**

- Submit the repo URL, not the essay, for a Show HN.
- Be present for the first two hours. The questions to expect: "isn't this just two LLMs agreeing with each other," "what's the token cost per PR," "why not use existing review bots," and "0 false positives is not believable." Answer the last one with the labelling method (hand-read against the cited sha, seeded sample, 6 severity-inflated cases counted as *true*) rather than restating the number.
- Do not seed upvotes or comments. HN detects it and it ends the launch.

---

## Reddit

Community rules on self-promotion differ, several ban it outright, and moderators enforce it. Check each sidebar before posting; where promotion is restricted, post the essay's finding as a discussion and mention the tool only if asked.

### r/ExperiencedDevs — discussion framing, no product lead

**Title:** `We hand-checked our AI code reviewer's findings. 0 false positives — and 62% of PRs merged past them anyway.`

> We ship a lot of agent-authored PRs and built an independent reviewer for them (a different model than the one that wrote the patch). Before trusting it we ran a census: 400 merged PRs over a week, sampled 40 of its blocking findings, and hand-read each one against the file it cited at the sha it was reviewed at.
>
> 0 false. ~85% genuine defects. 94% of reviews landed before the merge.
>
> Then the uncomfortable number: only 38% of PRs reached an approving verdict, and the median gap between the last review and the merge was 4 minutes. Most PRs merged straight past correct findings.
>
> The cause turned out to be structural rather than about review quality: the reviewer's entire output was a PR comment. It created no commit status, appeared in no branch protection rule, so nothing stopped a merge the moment CI went green.
>
> What I didn't expect: adding the required check first would have made it worse. Findings kept arriving in later rounds, so enforcing an unbounded review loop converts "merged in 4 minutes" into "blocked for two days." We had to bound the loop before gating it.
>
> Curious whether others measuring review effectiveness see the same thing — that precision and latency aren't the binding constraint, and the review simply isn't part of the merge decision. And how you bounded the loop without capping it somewhere arbitrary.

### r/ClaudeAI and r/ClaudeCode — practitioner framing

**Title:** `Stopped letting Claude review its own PRs — routed them to Codex instead. Here's what the findings looked like.`

> I use Claude Code as my main author. Asking it to review its own patch was consistently useless — not wrong exactly, just agreeable. The reasoning that wrote the bug is the reasoning judging it, and it already convinced itself once.
>
> So I wired up cross-vendor review: Claude-authored PRs go to Codex, Codex-authored PRs go to Claude, findings return to the original author agent to fix, then a recheck.
>
> Sampled 40 of the blocking findings and hand-checked them against the source. Zero false positives. The good ones weren't lint-grade — they read the repo's own convention docs and traced call paths across services. One caught a function that accepted an `expected_mode` param for dual-control confirmation and never put it in the request body. Two lines apart, tests green.
>
> It runs through the `claude` and `codex` CLIs you're already logged into, so no API bill on top of your subscription. MIT.
>
> Read-only if you want to see it on one PR without it touching anything: `crosscheck run <pr-url> --dry-run`
>
> [repo link]

### r/ChatGPTCoding — same shape, Codex-first

Use the r/ClaudeAI draft with the vendors swapped: Codex as the author, Claude as the reviewer. Keep the concrete defect example — it is what makes the post land.

---

## What not to say

Guardrails, so nothing in this launch has to be walked back:

- **No invented numbers.** Everything quotable is in `docs/dynamic-thoroughness.md`. If a number isn't there, it doesn't get posted.
- **No comparison to CR-Bench precision without the caveat.** 3.6–5.1% vs ~85% is not apples to apples; quoting it bare is the kind of claim that gets correctly torn apart.
- **No "catches every bug."** 6 of 40 findings were severity-inflated. Say so when it comes up.
- **No fake adoption.** No user counts, no "teams are using," no testimonials we don't have.
- **No claim that it replaces human review.** It makes agent output reviewable.
- **No implication that source stays local.** It reaches the model vendors through their CLIs, and the trust doc says so plainly.
