import { describe, it, expect } from 'vitest'
import { classifyError } from '../lib/logger.js'

// Regression coverage for #191: transient model-API errors (429 / 529 / budget)
// were misclassified as `auth` because the broad auth pattern (which matches the
// bare word "token") ran before the more specific transient checks.
describe('classifyError — transient errors must not be mislabeled as auth', () => {
  it('classifies 429 rate-limit as rate_limit even when the body mentions a token', () => {
    expect(classifyError('Claude api_error_status: 429 rate limit — check token usage')).toBe('rate_limit')
  })

  it('classifies 529 overloaded as overloaded', () => {
    expect(classifyError('API Error: 529 Overloaded. Please try again in a moment.')).toBe('overloaded')
  })

  it('classifies budget exhaustion as budget', () => {
    expect(classifyError('error_max_budget_usd: Reached maximum budget ($2)')).toBe('budget')
  })

  it('does not match 429/529 digits embedded in durations or counts', () => {
    // Without word boundaries, "5290ms" matched /529/ and a timeout read as `overloaded`.
    expect(classifyError('Request timed out after 5290ms')).toBe('timeout')
    expect(classifyError('operation timed out after 4290ms')).toBe('timeout')
    expect(classifyError('processed 1529 records then exited with code 1')).toBe('subprocess')
  })

  it('still classifies genuine credential failures as auth', () => {
    expect(classifyError('Bad credentials (401): GITHUB_TOKEN is invalid')).toBe('auth')
    expect(classifyError('You are not logged in')).toBe('auth')
  })

  it('still classifies permission, network, timeout, and subprocess failures', () => {
    expect(classifyError('403 forbidden: insufficient scope (write:org)')).toBe('permission')
    expect(classifyError('fetch failed: ECONNREFUSED 140.82.0.1:443')).toBe('network')
    expect(classifyError('Request timed out after 180000ms')).toBe('timeout')
    expect(classifyError('Command failed: exited with code 1')).toBe('subprocess')
  })

  it('falls back to unknown for unrecognized messages', () => {
    expect(classifyError('something nobody anticipated')).toBe('unknown')
  })
})

describe('classifyError — SSL and auth failure patterns from real failures', () => {
  it('classifies LibreSSL SSL_ERROR_SYSCALL as network', () => {
    expect(classifyError(
      'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443',
    )).toBe('network')
  })

  it('classifies codex auth failure message as auth', () => {
    expect(classifyError('codex auth failure during fix step — run: codex login')).toBe('auth')
  })

  it('classifies claude auth failure message as auth', () => {
    expect(classifyError('claude auth failure during conflict-resolve step — run: claude auth login')).toBe('auth')
  })

  it('classifies generic auth failure text as auth', () => {
    expect(classifyError('auth failure: session expired')).toBe('auth')
  })
})

// The clone URL embeds `x-access-token` as its *username*, and the redactor keeps
// that literal while hiding the value. Every failed clone therefore carries the
// substring `token`, which the broad auth pattern matched — so a clone that failed
// for any reason at all was filed as an auth failure. In the logs behind this fix,
// the identical SSL error read `network` when it happened on a push (no URL in the
// message) and `auth` when it happened on a clone. 30 of them.
describe('classifyError — a failing clone is classified by its cause, not its URL', () => {
  const cloneCommand =
    "Command failed with exit code 128: git -c 'http.postBuffer=524288000' -c 'http.lowSpeedLimit=1000' " +
    "-c 'http.keepAlive=true' clone '--depth=50' --quiet " +
    "'https://x-access-token:[REDACTED]@github.com/acme/web.git' /tmp/crosscheck-repo-3BdU8R"

  it('classifies an SSL failure during clone as network, not auth', () => {
    expect(classifyError(
      `${cloneCommand}\n\nfatal: unable to access 'https://github.com/acme/web.git/': ` +
      'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443',
    )).toBe('network')
  })

  it('classifies a clone that timed out as timeout, not auth', () => {
    expect(classifyError(`${cloneCommand}\n\nfatal: the remote end hung up unexpectedly\ntimed out`)).toBe('timeout')
  })

  it('classifies a transient HTTP/2 framing clone failure as git', () => {
    expect(classifyError(`${cloneCommand}\n\nerror: RPC failed; curl 16 HTTP/2 framing layer error`)).toBe('git')
  })

  it('still classifies a clone rejected for bad credentials as auth', () => {
    expect(classifyError(
      `${cloneCommand}\n\nfatal: Authentication failed for 'https://github.com/acme/web.git/'`,
    )).toBe('auth')
  })

  it('still classifies a clone that could not read credentials as auth', () => {
    expect(classifyError(`${cloneCommand}\n\nfatal: could not read Username for 'https://github.com': terminal prompts disabled`)).toBe('auth')
  })

  it('still classifies an SSH clone rejected for a bad key as auth', () => {
    expect(classifyError(
      "Command failed with exit code 128: git clone 'git@github.com:acme/web.git'\n\n" +
      'git@github.com: Permission denied (publickey).\nfatal: Could not read from remote repository.',
    )).toBe('auth')
  })

  it('still classifies a repo the token cannot see as permission', () => {
    expect(classifyError(
      `${cloneCommand}\n\nremote: Repository not found.\nfatal: 403 Forbidden`,
    )).toBe('permission')
  })
})

describe('crosscheck fail-closed categories', () => {
  it('classifies an unresolvable base ref', () => {
    expect(classifyError(
      'base ref origin/chore/in-4439-registry-machine-ownership could not be resolved — the branch is deleted or renamed, '
      + 'so the PR diff cannot be computed. Retarget the PR to a live base branch and re-run.',
    )).toBe('base_ref')
  })

  it('classifies a reviewer that reported it could not review', () => {
    expect(classifyError('codex review inconclusive — reviewer reported it could not perform the review')).toBe('inconclusive')
  })

  it('does not let the base-ref message fall through to auth', () => {
    // The message contains no credential words, but the auth pattern is broad
    // enough that ordering matters — assert the outcome, not the intent.
    expect(classifyError('base ref origin/main could not be resolved')).not.toBe('auth')
  })
})
