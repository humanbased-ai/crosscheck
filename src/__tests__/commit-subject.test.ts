import { describe, it, expect } from 'vitest'
import { vendorDisplayName } from '../lib/vendor.js'
import {
  fixCommitSubject,
  fixPRCommitSubject,
  conflictResolveCommitSubject,
} from '../lib/runner.js'

describe('vendorDisplayName', () => {
  it('names each vendor the way the attribution footer does', () => {
    expect(vendorDisplayName('claude')).toBe('Claude Code')
    expect(vendorDisplayName('codex')).toBe('OpenAI Codex')
  })
})

// Every crosscheck commit subject ended in "— by Claude Code" regardless of who
// did the work, so a codex-authored fix landed in git history under Claude's
// name. The Crosscheck-Reviewer trailer on the same commit said codex — the
// subject and its own trailer disagreed.
describe('crosscheck commit subjects name the vendor that did the work', () => {
  describe('fixCommitSubject', () => {
    it('attributes a codex fix to codex', () => {
      expect(fixCommitSubject(3, 'codex')).toBe('[crosscheck] fix: apply 3 fixes from code review — by OpenAI Codex')
    })

    it('attributes a claude fix to claude', () => {
      expect(fixCommitSubject(3, 'claude')).toBe('[crosscheck] fix: apply 3 fixes from code review — by Claude Code')
    })

    it('keeps the singular for one fix', () => {
      expect(fixCommitSubject(1, 'claude')).toBe('[crosscheck] fix: apply 1 fix from code review — by Claude Code')
    })

    it('pluralises zero', () => {
      expect(fixCommitSubject(0, 'claude')).toContain('apply 0 fixes')
    })
  })

  describe('fixPRCommitSubject', () => {
    it('attributes a codex fix PR to codex', () => {
      expect(fixPRCommitSubject(2444, 'codex'))
        .toBe('[crosscheck] fix: apply CR fixes from review of PR #2444 — by OpenAI Codex')
    })

    it('attributes a claude fix PR to claude', () => {
      expect(fixPRCommitSubject(2444, 'claude'))
        .toBe('[crosscheck] fix: apply CR fixes from review of PR #2444 — by Claude Code')
    })
  })

  describe('conflictResolveCommitSubject', () => {
    // Only claude can resolve conflicts today, so this one was accidentally
    // correct. It takes the vendor anyway: the day codex support lands, the
    // subject should not need remembering.
    it('attributes a claude resolve to claude', () => {
      expect(conflictResolveCommitSubject(2, 'claude'))
        .toBe('[crosscheck] resolve: resolve 2 conflicts — by Claude Code')
    })

    it('keeps the singular for one conflict', () => {
      expect(conflictResolveCommitSubject(1, 'claude'))
        .toBe('[crosscheck] resolve: resolve 1 conflict — by Claude Code')
    })

    it('attributes a codex resolve to codex once codex can run the step', () => {
      expect(conflictResolveCommitSubject(2, 'codex'))
        .toBe('[crosscheck] resolve: resolve 2 conflicts — by OpenAI Codex')
    })
  })

  // The [crosscheck] prefix is what countCrosscheckCommitsForPR greps for to
  // enforce MAX_CROSSCHECK_COMMITS, and the step word is what detect-step reads
  // as fallback when a commit predates the trailers. Neither may move.
  it('keeps the [crosscheck] prefix and step word that history parsing depends on', () => {
    for (const subject of [
      fixCommitSubject(1, 'codex'),
      fixPRCommitSubject(1, 'codex'),
      conflictResolveCommitSubject(1, 'codex'),
    ]) {
      expect(subject.startsWith('[crosscheck] ')).toBe(true)
    }
    expect(fixCommitSubject(1, 'codex')).toContain('[crosscheck] fix:')
    expect(fixPRCommitSubject(1, 'codex')).toContain('[crosscheck] fix:')
    expect(conflictResolveCommitSubject(1, 'codex')).toContain('[crosscheck] resolve:')
  })
})
