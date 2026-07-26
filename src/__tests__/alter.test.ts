import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { resolveSteps, runAlter } from '../commands/alter.js'
import { readRepoWorkflowStepTypes } from '../lib/repo-workflow.js'

describe('runAlter (file-based per-repo overrides)', () => {
  let dir: string
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'ccalter-'))
    vi.spyOn(console, 'log').mockImplementation(() => {})
  })
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
    vi.restoreAllMocks()
  })

  it('--review-only writes a review-only override file', () => {
    runAlter('humanbased-ai/xny-monorepo', { reviewOnly: true, workflowsDir: dir })
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toEqual(['review'])
  })

  it('--steps writes the requested depth (accepting github.com/ forms)', () => {
    runAlter('github.com/humanbased-ai/api', { steps: 'review,fix,recheck', workflowsDir: dir })
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'api', dir)).toEqual(['review', 'fix', 'recheck'])
  })

  it('--reset removes an existing override', () => {
    runAlter('humanbased-ai/web', { steps: 'review,fix', workflowsDir: dir })
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'web', dir)).toEqual(['review', 'fix'])
    runAlter('humanbased-ai/web', { reset: true, workflowsDir: dir })
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'web', dir)).toBeUndefined()
  })

  it('--show never writes anything', () => {
    runAlter('humanbased-ai/xny-monorepo', { show: true, workflowsDir: dir })
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toBeUndefined()
  })
})

describe('resolveSteps', () => {
  it('maps --review-only to a review-only depth', () => {
    expect(resolveSteps({ reviewOnly: true })).toEqual(['review'])
  })

  it('parses an explicit --steps value', () => {
    expect(resolveSteps({ steps: 'review,fix' })).toEqual(['review', 'fix'])
    expect(resolveSteps({ steps: 'review,fix,recheck' })).toEqual(['review', 'fix', 'recheck'])
  })

  it('allows --review-only combined with the compatible --steps review', () => {
    expect(resolveSteps({ reviewOnly: true, steps: 'review' })).toEqual(['review'])
  })

  it('rejects --review-only combined with a deeper --steps value with the specific message', () => {
    expect(() => resolveSteps({ reviewOnly: true, steps: 'review,fix' }))
      .toThrow('--review-only cannot be combined with --steps unless --steps is review')
  })

  it('rejects --review-only combined with an invalid --steps value with the specific message (not the generic parse error)', () => {
    expect(() => resolveSteps({ reviewOnly: true, steps: 'fix' }))
      .toThrow('--review-only cannot be combined with --steps unless --steps is review')
  })

  it('requires a depth to be chosen when neither flag is given', () => {
    expect(() => resolveSteps({})).toThrow('Choose a workflow depth')
  })
})
