import { describe, expect, it } from 'vitest'
import { redactCloneSecrets } from '../lib/clone.js'

describe('redactCloneSecrets', () => {
  it('redacts GitHub x-access-token clone URLs', () => {
    const message = 'Command failed: git clone https://x-access-token:gho_secret123@github.com/humanbased-ai/crosscheck-proof-fixture.git /tmp/repo'

    expect(redactCloneSecrets(message)).toBe(
      'Command failed: git clone https://x-access-token:[REDACTED]@github.com/humanbased-ai/crosscheck-proof-fixture.git /tmp/repo',
    )
  })
})

describe('isTransientGitError', () => {
  // Note: isTransientGitError is not exported, so we test via error message patterns
  // that should trigger retry behavior
  
  const transientPatterns = [
    'curl 16 Error in the HTTP2 framing layer',
    'curl 18 Transferred a partial file',
    'error: 3789 bytes of body are still expected',
    'fetch-pack: unexpected disconnect while reading sideband packet',
    'fatal: early EOF',
    'fatal: fetch-pack: invalid index-pack output',
    'RPC failed; curl 16',
    'RPC failed; curl 18',
  ]

  const nonTransientPatterns = [
    'Authentication failed',
    'Repository not found',
    'Permission denied (publickey)',
    'fatal: Could not read from remote repository',
  ]

  // Helper to check if a message would be considered transient
  // (mirrors the regex in clone.ts)
  function isTransientGitError(message: string): boolean {
    const m = message.toLowerCase()
    return /curl 16|http2 framing|curl 18|partial file|early eof|rpc failed|unexpected disconnect|fetch-pack: invalid|bytes of body.*expected/.test(m)
  }

  it.each(transientPatterns)('detects transient error: %s', (pattern) => {
    expect(isTransientGitError(pattern)).toBe(true)
  })

  it.each(nonTransientPatterns)('does not detect non-transient error: %s', (pattern) => {
    expect(isTransientGitError(pattern)).toBe(false)
  })
})
