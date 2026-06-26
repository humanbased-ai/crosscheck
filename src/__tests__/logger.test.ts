import { describe, expect, it } from 'vitest'
import { classifyError } from '../lib/logger.js'

describe('classifyError', () => {
  describe('git errors', () => {
    it('classifies non-fast-forward push rejection', () => {
      const msg = 'Command failed: git push origin HEAD:feature\nTo github.com:org/repo.git\n ! [rejected] HEAD -> feature (fetch first)\nerror: failed to push some refs to \'github.com:org/repo.git\'\nhint: Updates were rejected because the remote contains work that you do not have locally.'
      expect(classifyError(msg)).toBe('git')
    })

    it('classifies curl 16 framing error', () => {
      const msg = 'Command failed: git clone --depth=50 --quiet https://x-access-token:token@github.com/org/repo.git /tmp/repo\nerror: RPC failed; curl 16 Error in the HTTP2 framing layer\nfatal: expected flush after ref listing'
      expect(classifyError(msg)).toBe('git')
    })

    it('classifies curl 18 partial transfer', () => {
      const msg = 'Command failed: git clone --depth=50 --quiet https://x-access-token:token@github.com/org/repo.git /tmp/repo\nerror: RPC failed; curl 18 Transferred a partial file\nerror: 3789 bytes of body are still expected\nfatal: early EOF'
      expect(classifyError(msg)).toBe('git')
    })

    it('classifies fetch-pack invalid', () => {
      const msg = 'fatal: fetch-pack: invalid index-pack output'
      expect(classifyError(msg)).toBe('git')
    })
  })

  describe('rate limit errors', () => {
    it('classifies 429 rate limit', () => {
      const msg = 'API Error: You\'ve hit your session limit · resets 5:30pm (rate limit)'
      expect(classifyError(msg)).toBe('rate_limit')
    })

    it('classifies secondary rate limit', () => {
      const msg = 'You have exceeded a secondary rate limit'
      expect(classifyError(msg)).toBe('rate_limit')
    })
  })

  describe('auth errors', () => {
    it('classifies bad credentials', () => {
      const msg = 'Bad credentials'
      expect(classifyError(msg)).toBe('auth')
    })

    it('classifies 401 unauthorized', () => {
      const msg = 'HTTP 401: Unauthorized'
      expect(classifyError(msg)).toBe('auth')
    })

    it('classifies not logged in', () => {
      const msg = 'Error: not logged in'
      expect(classifyError(msg)).toBe('auth')
    })
  })

  describe('network errors', () => {
    it('classifies connection refused', () => {
      const msg = 'Error: connect ECONNREFUSED 127.0.0.1:443'
      expect(classifyError(msg)).toBe('network')
    })

    it('classifies socket hang up', () => {
      const msg = 'Error: socket hang up'
      expect(classifyError(msg)).toBe('network')
    })
  })

  describe('timeout errors', () => {
    it('classifies timeout', () => {
      const msg = 'Error: timed out after 300s'
      expect(classifyError(msg)).toBe('timeout')
    })
  })

  describe('subprocess errors', () => {
    it('classifies exit code errors', () => {
      const msg = 'Command failed with exit code 1'
      expect(classifyError(msg)).toBe('subprocess')
    })
  })
})
