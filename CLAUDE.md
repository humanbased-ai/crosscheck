# CLAUDE.md — crosscheck

## Workflow (mandatory)

### 1. Before writing any code

- Read the request. If it's ambiguous, ask — don't guess.
- Read the relevant source files to understand current state.
- Identify: which files change, what new files are needed, whether the public CLI API changes.

### 2. Branch

Always work on a feature branch. Never commit directly to `main`.

```bash
git checkout -b feat/<short-description>
git checkout -b fix/<short-description>
```

### 3. Build

For every change:

1. Implement the feature or fix.
2. Run the quality gate — all three must pass before committing:

```bash
npm run typecheck   # zero type errors
npm run build       # clean compile to dist/
```

3. Self-review every changed file: unused imports, broken references, incorrect types.
4. Adversarial check: what input or state would break this? Test it.

### 4. Commit

Use conventional commits:

```
feat: add --dry-run flag to review command
fix: codex review exits non-zero on empty diff
chore: update smee-client to 2.1.0
docs: document routing pattern examples
refactor: extract PR clone logic into shared helper
test: add edge cases for origin detector
```

One logical change per commit. Do not batch unrelated changes.

### 5. PR

Push the branch and open a PR targeting **`staging`** — never `main`.

```bash
gh pr create --base staging
```

Every PR must include:

- **What changed** — one-paragraph summary
- **Why** — the problem it solves or the capability it adds
- **How to test** — exact commands to verify the change

Do not merge the PR yourself.

### 6. Branch flow

```
feature branch → staging → main
```

| Branch | Purpose | How to get there |
|---|---|---|
| `feat/*` / `fix/*` | Active development | PR → `staging` |
| `staging` | Integration + pre-release validation | PR → `main` when ready to release |
| `main` | Production — triggers `@latest` npm publish | Merge from `staging` only |

- Merging to `staging` triggers CI and publishes `@beta` to npm.
- Merging `staging` → `main` triggers the production workflow and publishes `@latest` (requires manual approval in GitHub Actions).

### Enforcement

- **Never commit directly to `staging` or `main`**
- **Never open a PR targeting `main` directly from a feature branch**
- **Never open a PR with failing typecheck or build**
- **Never ship a breaking change to the CLI API without a major version bump**

---

## Project structure

```
src/
  cli.ts                  # Entry point — command definitions only, no logic
  commands/
    init.ts               # crosscheck init
    review.ts             # crosscheck review <pr-url>
    watch.ts              # crosscheck watch
    status.ts             # crosscheck status
  config/
    schema.ts             # Zod schema — single source of truth for config shape
    loader.ts             # File discovery, parsing, env var access
  github/
    client.ts             # Octokit wrapper, webhook signature verification
    detector.ts           # PR origin detection and reviewer assignment
    webhook.ts            # HTTP server for incoming webhook events
  reviewers/
    codex.ts              # codex CLI runner
    claude.ts             # claude CLI runner
crosscheck.config.example.yml   # Canonical example — keep in sync with schema.ts
get-started.md                  # Single-file documentation
```

### Rules

- `cli.ts` only wires commands to handlers — no business logic
- `schema.ts` is the authority on config shape; `loader.ts` reads it, nothing else defines config types
- Each `commands/` file owns one command end-to-end
- Reviewer runners (`codex.ts`, `claude.ts`) are pure functions: take inputs, return review text, throw on failure
- GitHub API calls go through `client.ts` — no raw `fetch` to `api.github.com` elsewhere

---

## Code standards

**TypeScript**
- `strict: true` — no exceptions
- No `any`, no `@ts-ignore`, no `as unknown as X` casts without a comment explaining why
- Explicit return types on all exported functions
- Use `unknown` for caught errors, narrow before accessing properties

**Error handling**
- Throw real `Error` objects with descriptive messages
- Catch at the command boundary (`commands/*.ts`), not inside utilities
- User-facing errors: print with `chalk.red()` and `process.exit(1)`
- Never swallow errors silently

**Dependencies**
- Do not add a dependency for something that can be done in 10 lines of stdlib
- Prefer `execa` over `child_process.exec` for spawning CLIs
- Do not import from `dist/` — always import from `src/`

**Async**
- All I/O is `async`/`await` — no callbacks
- Parallel where independent: `await Promise.all([...])`
- Never `await` inside a loop — batch with `Promise.all`

---

## Detection & Routing

These are settled architectural decisions. Do not redesign them without updating `prd.md` first.

### Two-phase model

Every PR event goes through exactly two phases:

**Phase 1 — Detection (should we review this PR?)**
Answer is YES when both conditions hold:
1. PR author passes the scope gate (`allowed_authors` if set; any author otherwise)
2. PR has no existing crosscheck review comment

Attribution is irrelevant here. A PR from an unknown author goes to Phase 2 just like a PR from a known agent.

**Phase 2 — Assignment (which vendor reviews it?)**
Attribution detection runs in this fixed order — stop at first match:
1. PR body text (configured patterns)
2. Commit messages (same patterns)
3. Branch name prefix
4. PR comments (scan for `<!-- crosscheck: origin=... -->` annotation tags)
5. `author_routes` config map
6. `routing.fallback_reviewer` (default: `skip`)

Never add a gate to Phase 1 that belongs in Phase 2. "We don't know who wrote this" is a Phase 2 concern.

### Annotation contract

`<!-- crosscheck: origin=<claude|codex> reviewer=<claude|codex> model=<model-id> type=<review|recheck|fix|conflict-resolve> round=<n> verdict=<APPROVE|NEEDS_WORK|BLOCK|UNKNOWN> service=<service-name> sha=<head-sha> -->`

This tag is embedded in every review comment crosscheck posts. It is the stable schema that Phase 2 step 4 reads. `sha=` is optional for older comments; parsers must tolerate unknown additive fields. **Changing or removing existing fields is a breaking change** — same rules as config schema changes (update `annotation.ts`, bump minor version, document in changelog).

### `routing.fallback_reviewer`

When Phase 2 returns `origin: 'human'` (all 6 steps inconclusive) in cross-vendor mode:
- `skip` (default) — no review posted; log why
- `claude` / `codex` — review posted using that vendor regardless of origin

In single-vendor mode, `fallback_reviewer` is unused — the one enabled vendor always reviews.

### File ownership

| Concern | File |
|---|---|
| Detection chain (Phase 2) | `src/github/detector.ts` |
| Phase 1 scope filter | `src/lib/filter.ts` |
| Annotation build/parse | `src/lib/annotation.ts` |
| Comment fetching for step 4 | `src/github/client.ts` → `listPRComments` |
| Vendor assignment logic | `src/github/detector.ts` → `assignReviewer` |

---

## CLI API contract

The public CLI surface is: command names, flag names, and exit codes.

Any change to these is a **breaking change** and requires a major version bump (`npm version major`).

| Exit code | Meaning |
|---|---|
| `0` | Success |
| `1` | User error (bad args, missing env var, auth failure) |
| `2` | Unexpected error (network failure, CLI crash) |

New flags must be additive and optional. Flags may not be renamed.

---

## Config schema contract

`crosscheck.config.yml` is read and written by users and agents. Any change to the schema must:

1. Update `schema.ts` with the new field (add a default so old configs stay valid)
2. Update `crosscheck.config.example.yml` with the new field, commented
3. Update the **Configuration** section of `get-started.md`

Never remove a config field or change its type — that is a breaking change.

---

## Environment variables

| Variable | Required | Used by |
|---|---|---|
| `GITHUB_TOKEN` | All commands that call GitHub API | `client.ts`, `watch.ts` |
| `CROSSCHECK_WEBHOOK_SECRET` | `watch` | `webhook.ts` |
| `GITHUB_WEBHOOK_SECRET` | Alias for above | `loader.ts` |

Never read env vars outside `config/loader.ts`.

---

## Versioning

Follow semver strictly.

| Change | Version bump |
|---|---|
| New command or flag | `minor` |
| Bug fix, internal refactor | `patch` |
| Removed/renamed command, flag, or config field | `major` |

Publishing is handled by CI/CD — do not run `npm publish` manually.

- `@beta` publishes automatically when `staging` is merged to `main` via the staging workflow.
- `@latest` publishes when a `v*` tag is pushed to `main` and approved in the production workflow:

```bash
git checkout main && git pull
npm version patch   # or minor / major — updates package.json and creates a git tag
git push origin main --follow-tags
```
