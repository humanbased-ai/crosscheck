import { describe, it, expect } from 'vitest'
import {
  planAutoFixDelivery,
  forceWithLeaseArgs,
  parseLsRemoteOid,
  isLeaseRejection,
  assessFixBranchOwnership,
  isInvalidBaseError,
  type FixBranchPR,
} from '../lib/auto-fix-branch.js'
import { autoFixPRIntro } from '../github/superseded-fix-pr.js'

const SOURCE_PR = 2502
const FIX_BRANCH = 'fix/cr-2502-review-issues'
const REMOTE_OID = 'e358bdba70c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5'
const CROSSCHECK_LOGIN = 'crosscheck-bot'

describe('planAutoFixDelivery', () => {
  it('opens a follow-up PR against the source branch when it still exists', () => {
    expect(planAutoFixDelivery(true, 'feat/campaign-chip')).toEqual({
      kind: 'pull_request', base: 'feat/campaign-chip',
    })
  })

  // The PR-branch push failing because the PR merged and GitHub deleted the branch is
  // the fallback's most common trigger, and `pulls.create` rejects that missing base
  // with `field: base, code: invalid` — 19 such failures in the logs behind this fix.
  it('posts a diff instead when the source branch is gone', () => {
    expect(planAutoFixDelivery(false, 'feat/campaign-chip')).toEqual({
      kind: 'comment', reason: 'base_branch_gone',
    })
  })
})

describe('forceWithLeaseArgs', () => {
  it('states the remote sha it expects to replace', () => {
    expect(forceWithLeaseArgs(FIX_BRANCH, REMOTE_OID)).toEqual([
      'push',
      `--force-with-lease=refs/heads/${FIX_BRANCH}:${REMOTE_OID}`,
      'origin',
      `HEAD:${FIX_BRANCH}`,
    ])
  })

  it('expects the ref to be absent when the branch does not exist yet', () => {
    expect(forceWithLeaseArgs(FIX_BRANCH, null)).toEqual([
      'push',
      `--force-with-lease=refs/heads/${FIX_BRANCH}:`,
      'origin',
      `HEAD:${FIX_BRANCH}`,
    ])
  })
})

describe('parseLsRemoteOid', () => {
  it('reads the sha out of ls-remote output', () => {
    expect(parseLsRemoteOid(`${REMOTE_OID}\trefs/heads/${FIX_BRANCH}\n`)).toBe(REMOTE_OID)
  })

  it('returns null when the branch does not exist remotely', () => {
    expect(parseLsRemoteOid('')).toBeNull()
    expect(parseLsRemoteOid('\n  \n')).toBeNull()
  })

  it('returns null rather than a bad lease value for unexpected output', () => {
    expect(parseLsRemoteOid('fatal: could not read from remote repository')).toBeNull()
    expect(parseLsRemoteOid('abc123\trefs/heads/short-sha')).toBeNull()
  })
})

describe('isLeaseRejection', () => {
  // Verbatim from the logged failures this fix addresses.
  it('recognises the non-fast-forward rejection that lost 12 fixes', () => {
    expect(isLeaseRejection(
      `Command failed: git push origin HEAD:${FIX_BRANCH}\n` +
      ` ! [rejected]          HEAD -> ${FIX_BRANCH} (fetch first)\n` +
      'hint: Updates were rejected because the remote contains work that you do not\n' +
      "error: failed to push some refs to 'https://github.com/acme/web.git'",
    )).toBe(true)
  })

  it('recognises a stale lease', () => {
    expect(isLeaseRejection(`! [rejected] ${FIX_BRANCH} (stale info)`)).toBe(true)
  })

  it('does not treat an unrelated push failure as a lease rejection', () => {
    expect(isLeaseRejection(
      "fatal: unable to access 'https://github.com/acme/web.git/': " +
      'LibreSSL SSL_connect: SSL_ERROR_SYSCALL in connection to github.com:443',
    )).toBe(false)
  })
})

describe('assessFixBranchOwnership', () => {
  const crosscheckPR = (over: Partial<FixBranchPR> = {}): FixBranchPR => ({
    number: 2503,
    body: `${autoFixPRIntro(SOURCE_PR)}\n\nReview: https://github.com/acme/web/pull/${SOURCE_PR}`,
    user: { login: CROSSCHECK_LOGIN },
    head: { ref: FIX_BRANCH },
    ...over,
  })

  const assess = (candidates: FixBranchPR[], login: string | null = CROSSCHECK_LOGIN) =>
    assessFixBranchOwnership({ sourcePrNumber: SOURCE_PR, crosscheckLogin: login, candidates })

  it('owns a branch it opened a PR from', () => {
    expect(assess([crosscheckPR()])).toEqual({ owned: true, fixPrNumber: 2503 })
  })

  it('owns a branch whose fix PR has since been closed', () => {
    expect(assess([crosscheckPR({ number: 2410 })])).toEqual({ owned: true, fixPrNumber: 2410 })
  })

  // The check this replaces read the branch tip's commit message, which whoever pushes
  // the branch writes. Provenance has to come from something they cannot author.
  it('does not accept a PR another account opened with crosscheck\'s body', () => {
    expect(assess([crosscheckPR({ user: { login: 'contributor' } })]))
      .toEqual({ owned: false, reason: 'no_crosscheck_fix_pr' })
  })

  it('does not accept a PR from crosscheck that is not an auto-fix PR', () => {
    expect(assess([crosscheckPR({ body: 'Rebasing the release branch.' })]))
      .toEqual({ owned: false, reason: 'no_crosscheck_fix_pr' })
  })

  it('does not accept an auto-fix PR cut from a different source PR', () => {
    expect(assess([crosscheckPR({ body: autoFixPRIntro(SOURCE_PR + 1) })]))
      .toEqual({ owned: false, reason: 'no_crosscheck_fix_pr' })
  })

  it('does not accept a PR whose head is a different branch', () => {
    expect(assess([crosscheckPR({ head: { ref: 'fix/cr-2502-review-issues-v2' } })]))
      .toEqual({ owned: false, reason: 'no_crosscheck_fix_pr' })
  })

  it('leaves a hand-created branch with no PR alone', () => {
    expect(assess([])).toEqual({ owned: false, reason: 'no_crosscheck_fix_pr' })
  })

  it('refuses to claim ownership when the authenticated identity is unknown', () => {
    expect(assess([crosscheckPR()], null)).toEqual({ owned: false, reason: 'identity_unknown' })
  })

  it('matches the login case-insensitively, as GitHub does', () => {
    expect(assess([crosscheckPR({ user: { login: 'Crosscheck-Bot' } })]))
      .toEqual({ owned: true, fixPrNumber: 2503 })
  })
})

describe('isInvalidBaseError', () => {
  // The rejection `pulls.create` returns once the base branch is gone — 19 of these in
  // the logs behind this fix, and still reachable if the merge lands mid-run.
  it('recognises the base rejection from a structured octokit error', () => {
    expect(isInvalidBaseError({
      status: 422,
      message: 'Validation Failed',
      response: { data: { errors: [{ resource: 'PullRequest', field: 'base', code: 'invalid' }] } },
    })).toBe(true)
  })

  it('recognises the rejection embedded in the error message', () => {
    expect(isInvalidBaseError({
      status: 422,
      message: 'Validation Failed: {"resource":"PullRequest","field":"base","code":"invalid"}',
    })).toBe(true)
  })

  it('does not treat another validation failure as a missing base', () => {
    expect(isInvalidBaseError({
      status: 422,
      message: 'Validation Failed',
      response: { data: { errors: [{ resource: 'PullRequest', field: 'head', code: 'invalid' }] } },
    })).toBe(false)
  })

  it('does not treat a permission or network failure as a missing base', () => {
    expect(isInvalidBaseError({ status: 403, message: 'Resource not accessible by integration' })).toBe(false)
    expect(isInvalidBaseError(new Error('socket hang up'))).toBe(false)
    expect(isInvalidBaseError(undefined)).toBe(false)
  })
})
