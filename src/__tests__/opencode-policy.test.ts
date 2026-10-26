import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { describe, expect, it } from 'vitest'
import { isolateCheckoutOpenCodeConfig, opencodePolicy } from '../reviewers/opencode.js'

const ALLOWED_BASH = {
  '*': 'deny',
  'git status': 'allow',
  'git status *': 'allow',
  'git diff': 'allow',
  'git diff *': 'allow',
  'git log': 'allow',
  'git log *': 'allow',
  'git show': 'allow',
  'git show *': 'allow',
}

describe('opencodePolicy', () => {
  it('uses the v1 permission object for a v1 CLI', () => {
    expect(opencodePolicy(false, 'v1')).toEqual({
      permission: { bash: ALLOWED_BASH, edit: 'deny' },
    })
    expect(opencodePolicy(true, 'v1')).toEqual({
      permission: { bash: ALLOWED_BASH },
    })
  })

  it('uses the v2 permissions array for a v2 CLI', () => {
    const policy = opencodePolicy(false, 'v2') as {
      permissions: Array<{ action: string; resource: string; effect: string }>
    }
    expect(policy.permissions).toEqual([
      { action: 'shell', resource: '*', effect: 'deny' },
      { action: 'shell', resource: 'git status *', effect: 'allow' },
      { action: 'shell', resource: 'git diff *', effect: 'allow' },
      { action: 'shell', resource: 'git log *', effect: 'allow' },
      { action: 'shell', resource: 'git show *', effect: 'allow' },
      { action: 'edit', resource: '*', effect: 'deny' },
    ])
  })

  it('leaves edits allowed for the fix step on v2', () => {
    const policy = opencodePolicy(true, 'v2') as { permissions: Array<{ action: string }> }
    expect(policy.permissions.some(rule => rule.action === 'edit')).toBe(false)
  })
})

describe('isolateCheckoutOpenCodeConfig', () => {
  it('writes the policy shape the installed CLI accepts and restores the checkout', () => {
    const dir = mkdtempSync(join(tmpdir(), 'crosscheck-policy-test-'))
    try {
      writeFileSync(join(dir, 'opencode.json'), JSON.stringify({ original: true }))
      const restore = isolateCheckoutOpenCodeConfig(dir, false, 'v1')
      expect(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))).toEqual({
        permission: { bash: ALLOWED_BASH, edit: 'deny' },
      })
      restore()
      expect(JSON.parse(readFileSync(join(dir, 'opencode.json'), 'utf8'))).toEqual({ original: true })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
