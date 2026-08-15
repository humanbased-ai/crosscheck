# Metrics: what Crosscheck records, and where it stays

Crosscheck records what it did so you can tell whether it is working. Every number comes from local log files, and **nothing is transmitted**: there is no endpoint, no account, no upload, and no network call in any of the code that produces or reads these metrics. Telemetry is opt-in in the strongest available sense — it does not exist yet.

This document is the field-by-field inventory. If you find a field written to disk that is not listed here, that is a bug worth reporting.

---

## Where it lives

| | |
|---|---|
| Location | `~/.crosscheck/logs/<YYYY-MM-DD>.ndjson` — one JSON object per line |
| On by default | Yes (`logs.enabled: true`) |
| Retention | `logs.retention_days`, default 30 — older files are deleted at startup |
| Turn it off | `logs.enabled: false` in `crosscheck.config.yml` |

Turning logging off is supported and costs you the reader commands: `crosscheck adoption`, `impact`, `diagnose`, and `optimize` all read these files and have nothing else to read.

---

## Reading it

```bash
crosscheck adoption                      # activation, usage, weekly active repos, latency, first-run failures
crosscheck adoption --json               # the same report as JSON
crosscheck adoption --since 2026-07-01   # narrow the window
```

`crosscheck adoption` answers "is this being used, and does a PR get a verdict fast enough to matter". Its sibling `crosscheck impact` prices reviews that already happened. Both read the same files and neither makes a network call.

What the report shows:

| Metric | Derived from |
|---|---|
| onboard started / completed / abandoned | `onboard_started`, `onboard_completed` |
| reviews started / completed | `review_started`, `review_complete` |
| rechecks completed | `review_complete` with `step_type: recheck` |
| blocking findings posted | `blocking_finding_posted` |
| fixes applied | `fix_complete` with `applied_count > 0` |
| active repos, weekly active repos | distinct `repo` on `review_complete`, bucketed by ISO week |
| PR open → verdict (median, p90, slowest) | `open_to_verdict_ms` on `review_complete` |
| first-run failures | first `error` in a session that never logged a `review_complete` |

Two honest limits worth knowing before you quote a number:

- **Latency is only measured when the PR event carried an open time.** Hand-built events and some third-party webhook redeliveries do not. Those verdicts are excluded and counted separately as `unmeasured` rather than being given an invented start time.
- **Everything is bounded by the retention window.** A 30-day default means a "total" is a 30-day total. Raise `logs.retention_days` if you need a longer baseline.

---

## What is recorded

Identifying fields, on every event that has them:

| Field | Example | Why |
|---|---|---|
| `ts` | `2026-07-08T10:00:00.000Z` | ordering, weekly bucketing |
| `event` | `review_complete` | what happened |
| `repo` | `acme/web` | which repo — this is a name, and it is the most identifying field written |
| `pr` | `245` | which PR number |

Everything else is a count, an enum, a duration, or a commit sha:

| Field | Shape |
|---|---|
| `verdict` | `APPROVE` / `NEEDS WORK` / `BLOCK` |
| `reviewer`, `model`, `effort` | vendor and model identifiers |
| `step_type`, `step_name`, `round`, `trigger` | which step ran, and why |
| `duration_ms` | how long the reviewer ran |
| `open_to_verdict_ms` | PR open → verdict, in ms |
| `tokens_used`, `input_tokens`, `output_tokens` | integer counts |
| `applied_count`, `commentCount` | integer counts |
| `sha`, `head_sha` | commit shas |
| `category` | error class: `auth`, `permission`, `rate_limit`, `overloaded`, `budget`, `timeout`, `network`, `git`, `subprocess`, `unknown` |
| `message`, `stack`, `stderr` | on error events only — the failure text, truncated |
| `outcome`, `stage` | on `onboard_completed`: `completed` / `abandoned`, and where it stopped |
| `deployment`, `repos`, `orgs`, `quality_tier`, `quality_mode`, `pipeline`, `tunnel`, `linear` | on `onboard_completed`: the **shape** of the setup — counts and enums, never repo or org names |

## What is not recorded

Standard logs never contain:

- **source code or diffs**
- **reviewer prompts**
- **review text** — the verdict is recorded; the prose is not
- **PR titles or bodies**
- **PR author logins**
- **tokens, keys, or secrets** — the one place a token could appear is the clone URL, which is redacted to `x-access-token:[REDACTED]` on every path that could log it

Error events are the one place free text lands, because a failure you cannot read is a failure you cannot fix. `message`, `stack`, and `stderr` come from the failing subprocess or API call and are truncated. They can quote a file path or a git ref. They are local files, like everything else here.

### The extended tier

Richer fields — PR title, body, file paths, review text, author — exist behind `logs.extended.enabled`, which is:

- **off by default**,
- **not settable from any CLI flag** and not offered by `crosscheck onboard`, so it can only be turned on by hand-editing config, and
- **tagged** — every line it writes carries `"_extended": true`, so it can be filtered or scrubbed independently of standard logs.

If you have not deliberately edited your config, this tier is off and nothing in the product will nudge you toward it.

---

## Transmission

There is none. To be specific about what that means:

- No Crosscheck-operated server exists, so there is nowhere for a payload to go.
- No code in `src/lib/adoption.ts` or `src/commands/adoption.ts` opens a socket.
- Reporting is a local CLI command that prints to your terminal.

If opt-in transmission is ever built, it will be per-category, individually documented, off unless you turn it on, and it will print the payload that leaves your machine. Until then, "opt-in telemetry" describes a design in `prd.md`, not shipped behaviour — and the metrics above are yours alone.

Related: [docs/trust.md](./trust.md) covers what leaves your machine during normal operation, which is a different question from what gets logged.
