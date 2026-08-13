import { describe, it, expect } from 'vitest'
import {
  planAutoFixDelivery,
  forceWithLeaseArgs,
  parseLsRemoteOid,
  isLeaseRejection,
} from '../lib/auto-fix-branch.js'

const FIX_BRANCH = 'fix/cr-2502-review-issues'
const REMOTE_OID = 'e358bdba70c1d2e3f4a5b6c7d8e9f0a1b2c3d4e5'

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
