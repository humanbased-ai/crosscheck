# Proof Demo: BLOCK to APPROVE

The first public proof asset should be a real GitHub PR timeline plus a 60-90 second narrated screen recording. The video creates attention, but the public PR is the evidence.

Use the Humanbased field report as the proof-led top of funnel:

```text
Blog -> README quick start -> fixture PR review -> first useful verdict -> optional fix/recheck -> onboarding/watch
```

Field report:

```text
https://blog.humanbased.ai/posts/agentic-pr-quality-crosscheck/
```

The intended chain is:

```text
agent PR opened -> Crosscheck BLOCK finding -> [crosscheck] fix commit -> recheck APPROVE -> merge-ready
```

## Demo fixture

Repository:

```text
https://github.com/humanbased-ai/crosscheck-proof-fixture
```

PR title:

```text
Add account transaction pagination
```

Seed bug:

The PR adds pagination but accidentally drops tenant/user scoping.

```ts
// before: scoped to the authenticated user
where: { accountId, ownerId: ctx.user.id }

// buggy PR: ownerId dropped
where: { accountId }
```

Expected Crosscheck finding:

```text
BLOCK: Any authenticated user can read another account's transactions by guessing accountId.
```

## Demo commands

```bash
export PR_URL=https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/1

crosscheck detect-step "$PR_URL"

crosscheck run "$PR_URL" \
  --steps review \
  --reviewer codex \
  --timeout 10m

crosscheck detect-step "$PR_URL"

crosscheck run "$PR_URL" \
  --steps fix,recheck \
  --fixer claude \
  --reviewer codex \
  --timeout 10m

crosscheck scan --force --tidy
```

## Video beats

1. Open the PR: "An agent shipped a plausible feature."
2. Show the diff where `ownerId` was removed.
3. Run the review command.
4. Open Crosscheck's GitHub comment with the `BLOCK` finding.
5. Run fix and recheck.
6. Show the `[crosscheck] fix:` commit restoring authorization scope and adding or repairing a regression test.
7. Show the recheck comment with `APPROVE`.
8. End on `crosscheck scan` showing the PR as approved and ready for a human merge decision.

## Assets to produce

- `assets/demo-block-to-approve.mp4`
- `assets/demo-block-to-approve.gif`
- `assets/demo-pr-timeline.png`
- `assets/demo-crosscheck-comment-block.png`
- `assets/demo-recheck-approve.png`

## Launch-ready rubric

- A viewer understands the bug in under 15 seconds.
- The Crosscheck finding is genuinely blocking, not cosmetic.
- The finding explains the production risk.
- The fix commit is inspectable and clearly tied to the finding.
- The recheck comment closes the loop with `APPROVE`.
- The PR timeline is public and reproducible.
- The video is 60-90 seconds with no setup detours.
- The README first screen includes the proof before asking users to install.
- A skeptical engineer can say: "Yes, this would have prevented a bad merge."

## Trust guardrails

- Do not imply automatic merge.
- Do not imply guaranteed correctness.
- Say "merge-ready" as a human decision state, not a machine guarantee.
- Show review-only (`crosscheck alter <repo> --review-only`) as the conservative first step when discussing team adoption.
