# Stop Letting One Agent Review Its Own Code

> **Draft for review — not published.** Every number below is sourced from
> [`docs/dynamic-thoroughness.md`](../../dynamic-thoroughness.md) (census window
> 2026-07-30 → 2026-08-07). Nothing is estimated or rounded up. See
> [`README.md`](./README.md) in this folder for what needs a decision before publishing.

---

Ask a coding agent to review the patch it just wrote and it will tell you the patch is good. Not because it is lying. Because the reasoning that produced the bug is the same reasoning now judging it, and it has already convinced itself once.

This is not a prompt problem. You cannot fix it with "be critical" or "review this as a skeptical senior engineer." The blind spot and the reviewer share a context window.

We build with agents all day, so we hit this constantly. And the failure mode isn't the one people expect.

## The failure isn't a broken build

Broken builds are fine. CI catches them, you fix them, nobody merges anything dangerous.

The dangerous output is what we've started calling **early victory**: a patch that passes CI, reads as complete, has a confident summary attached — and quietly carries a regression, an unhandled edge, or a fix that addresses the symptom the test caught and not the cause underneath.

Real examples, each one flagged by the reviewer, each one hand-verified against the source afterwards — and each one on a PR that merged without ever reaching an approving verdict:

- A function that accepts an `expected_mode` parameter for dual-control confirmation and never puts it in the request body. The parameter and the omission are two lines apart in the same function. Dual control silently bypassed.
- A `body.get("data")` sitting one line *outside* the `try` that catches JSON errors, so a non-object response raises an uncaught `AttributeError` instead of the handled failure the author intended.
- A promote payload sending three fields the receiving model no longer defines, against a schema set to `extra="forbid"`. Every promotion and every rollback returns 422. The feature is entirely broken, and the tests pass.

None of these look like mistakes. They look like finished work. That is the whole problem.

## So we pointed a second agent at it

The fix is structural and boring: **the agent that writes the patch does not review it.** A Claude-authored PR routes to Codex. A Codex-authored PR routes to Claude. Findings go back to the original author agent to repair, and a recheck runs before the PR is merge-ready.

```
PR  →  review  →  fix  →  recheck  →  merge-ready
       (codex)   (claude) (codex)
```

That is crosscheck. It runs through the `claude` and `codex` CLIs you already pay for — no hosted service, no per-review API bill, no new vendor holding your source.

Then we measured it, and the measurement did not say what we expected.

## The reviewer was right. That turned out not to be the point.

We took a census of 400 merged PRs, 199 of them crosscheck-engaged. Then we sampled 40 BLOCK findings and hand-read each one against the file it cited, at the sha it was reviewed at.

| | |
|---|---|
| Findings that were false | **0** |
| Findings that were genuine defects | **33 of 39** verifiable (~85%) |
| True but severity-inflated | 6 |
| Unverifiable (file since deleted) | 1 |

Zero false positives. The reviews were also doing work no linter does — reading the repo's own convention docs, cross-referencing design records, tracing call paths across services. One finding flagged a migration timestamp by citing the exact line of an internal conventions doc that says *never hand-write a round-number timestamp*, and referenced the prior incident that rule exists because of.

For calibration: CR-Bench reports 3.6–5.1% precision for review agents. That is not an apples-to-apples comparison — CR-Bench scores against a fixed ground-truth defect list and penalizes anything outside it, while we asked "is this claim true and worth fixing." Different questions. We're naming the gap rather than quoting the flattering number without it.

So: the reviewer lands before merge 94% of the time, and it is essentially never wrong.

And then:

| | |
|---|---|
| PRs that reached APPROVE | **38%** |
| Median gap, last review → merge | **4 minutes** |

62% of PRs merged past the findings. Of those, 56% merged within five minutes of the review — or before it landed at all.

We had built a reviewer that was fast and correct, and it was being merged straight past.

## Being right is not a gate

The reason was structural, and it was ours. Crosscheck read commit statuses and check-runs but never *created* a merge-blocking one. Its entire output was a comment. Branch protection required a size check and a CI gate; crosscheck was in neither list. GitHub merged the moment CI went green, and nothing on earth stopped a merge at minute four.

Two different failure modes hide in that number, and they need opposite fixes:

**The fast majority had no gate.** Merging before the review lands isn't a considered trade-off, it's an undisciplined default. No improvement to review quality, latency, or tone changes it — the review was never part of the merge decision.

**The slow tail had no terminal state.** Findings never stopped arriving. Round two produced new ones, round three produced more. That's tolerable when you can ignore it and merge. It becomes intolerable the moment you *can't*.

Which means the obvious fix is actively harmful if you do it first. Gate before bounding the loop and you convert "merged past findings in four minutes" into "blocked for two days." That is worse, not better. Bound the loop, then gate, then optimize latency — in that order.

This is the part we'd have gotten wrong without the census. The instinct was to make the reviewer smarter. The reviewer did not need to be smarter.

## What this means if you're running agents

Three things we'd now say to anyone shipping agent-authored code:

1. **Don't let the author review its own work.** Not as a policy preference — as an architectural constraint. Different model, different context, or it isn't review.
2. **Measure whether your review changes the merge decision.** Not findings-per-PR, not precision. The share of real defects fixed *inside the merge window*. A correct finding that arrives after merge is worth exactly nothing.
3. **Bound the loop before you enforce it.** An unbounded quality process that you're now required to satisfy is how teams learn to hate quality processes.

## Where crosscheck is honest about its limits

It never merges anything. There is no code path from a verdict to a merge — that decision stays with you.

It doesn't replace human review. It makes agent output reviewable, which is a smaller and more achievable claim.

Your diff reaches Anthropic or OpenAI through the `claude` and `codex` CLIs you're already authenticated to, under their terms. Crosscheck adds no separate upload path, and if a repo can't go to a model vendor, crosscheck isn't the tool that changes that.

And the census above is ours: one team, 400 PRs, one week, our conventions. Run it on your own repos and check whether it holds.

## Try it on one PR

Fully read-only. Clones, reviews, prints the comment it would post, exits without touching anything:

```bash
npm install -g @humanbased/crosscheck
crosscheck run https://github.com/your-org/your-repo/pull/123 --dry-run
```

When you want the comment but no code changes, drop `--dry-run` for `--review-only`.

- Repo: <https://github.com/humanbased-ai/crosscheck> (MIT)
- What leaves your machine, and what crosscheck can change: [`docs/trust.md`](https://github.com/humanbased-ai/crosscheck/blob/main/docs/trust.md)
- The full census, including the two analytical approaches we abandoned: [`docs/dynamic-thoroughness.md`](https://github.com/humanbased-ai/crosscheck/blob/main/docs/dynamic-thoroughness.md)

Your agents ship fast. Something other than the agent should decide whether they shipped right.
