# Demo: BLOCK → fix → APPROVE

Produces the two assets [#201](https://github.com/humanbased-ai/crosscheck/issues/201) asks for:

| Asset | Cut | Purpose |
|---|---|---|
| `assets/demo-block-to-approve.gif` | short (~34s, 1.1 MB) | README first viewport — has to loop fast and stay small |
| `assets/demo-block-to-approve.mp4` | full (~85s, 1.6 MB) | the 90-second clip, every round |

The two cuts come from the same `arc.json`; `--short` keeps the setup, the first
finding and the closing verdict, and drops the intermediate rounds — and says on
screen that it dropped them, with the round count, so the short cut does not read
as though one repair sufficed.

## What is real here, and what is not

Everything on screen is **verbatim output from one real crosscheck run** against a
public fixture PR. The review text, the finding, the fix commit, the recheck verdict
and the step timings were all captured from that run — not written for the demo.

What is *not* real is the wall clock: the recording is a **scripted replay** of the
captured run, so the recording is deterministic, needs no API tokens, and lasts 90
seconds instead of the several minutes the live run took. It is a re-enactment of a
real event, in the same way a screenshot of a terminal is not the terminal.

The live run it replays is public and permanently linked, so the claim is checkable
rather than taken on trust:

> https://github.com/humanbased-ai/crosscheck-proof-fixture/pull/2

Do not describe the recording as a live capture, and do not hand-edit `arc.json` to
make the demo read better. If the story needs to change, change the fixture and
re-capture — otherwise the provenance note above stops being true.

## What the run actually shows

Three review rounds, because that is how many it took:

| round | verdict | finding |
|---|---|---|
| 1 | 🚫 BLOCK | `ownerId: ctx.user.id` dropped from the `where` clause — any caller could read another user's transactions |
| — | 🔧 fix | restores the filter, adds a deterministic `id` sort |
| 2 | 🚫 BLOCK | the test still asserts the *old* query shape, so it now fails; and `Number.isInteger` admits huge offsets |
| — | 🔧 fix | updates the test, switches to `Number.isSafeInteger` |
| 3 | 🚫 BLOCK | `page` capped at 1,000,000 still allows ~100M-row offset scans |
| — | 🔧 fix | caps `page` at 100 |
| 4 | ✅ APPROVE | |

Round 2 is the one worth keeping. The first repair was correct in the source and
left a test asserting the bug — a regression introduced by the fix step itself,
caught by the next review. A cut that showed one clean BLOCK → fix → APPROVE would
be the more flattering edit and the less honest one, so the full cut walks all of it.

Round 3 is also left in: the defect was already gone (the reviewer says so in its
own summary) and it blocked anyway on a progressively more theoretical concern.
That is the unbounded-loop behaviour `docs/dynamic-thoroughness.md` documents, and
the demo does not hide it.

## Regenerating

```bash
# 1. capture — needs network + gh auth; rewrites arc.json from the live PR
npm run demo:capture

# 2. replay — offline, deterministic; prints the scripted run to your terminal
npm run demo:play            # full cut
npm run demo:play -- --short # the GIF cut
npm run demo:play -- --fast  # no waits, just checks it renders

# 3. time — prints each cut's length, to set the tapes' trailing Sleep
npm run demo:time

# 4. record — needs vhs (brew install vhs); writes both assets
npm run demo:record
```

Step 1 is only needed when the fixture run changes. `arc.json` is committed, so
steps 2 and 3 work from a clean checkout with no credentials.

`.github/workflows/demo.yml` runs steps 2 and 3 on `workflow_dispatch` and uploads
the assets as artifacts, so the recording can be regenerated without a local vhs.

## Layout

| File | Role |
|---|---|
| `capture.ts` | reads the run's NDJSON + the PR's comments → `arc.json` |
| `arc.json` | the captured run: timings, verdicts, real comment bodies |
| `replay.ts` | plays `arc.json` through the **real** `PRBoard` renderer |
| `block-to-approve.tape` | vhs script for the full cut → `.mp4` |
| `block-to-approve-short.tape` | vhs script for the short cut → `.gif` |
| `measure.ts` | prints each cut's real length, so the tapes' `Sleep` is measured, not guessed |
| `scenes/` | captured static panels (the diff, the passing test run) |

`replay.ts` drives `src/lib/board.ts` — the same class `crosscheck watch` uses — so
the pipeline view in the recording is the product's own UI, not a mock of it.
