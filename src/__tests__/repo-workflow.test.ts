import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  parseRepoRef,
  parseRepoWorkflowSteps,
  perRepoWorkflowPath,
  readRepoWorkflowStepTypes,
  removeRepoWorkflowOverride,
  resolveRepoWorkflowSteps,
  writeRepoWorkflowStepTypes,
} from '../lib/repo-workflow.js'
import type { WorkflowStep } from '../lib/workflow.js'

const steps: WorkflowStep[] = [
  { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1 },
  { name: 'fix', type: 'fix', reviewer: 'origin', max_rounds: 1 },
  { name: 'recheck', type: 'recheck', reviewer: 'auto', max_rounds: 1 },
  { name: 'conflict-resolve', type: 'conflict-resolve', reviewer: 'auto', max_rounds: 1 },
]

describe('repo workflow helpers', () => {
  let dir: string
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'ccwf-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('parses supported GitHub repo references', () => {
    expect(parseRepoRef('humanbased-ai/xny-monorepo')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
    expect(parseRepoRef('github.com/humanbased-ai/xny-monorepo')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
    expect(parseRepoRef('https://github.com/humanbased-ai/xny-monorepo.git')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
  })

  it('rejects PR URLs and malformed refs', () => {
    expect(parseRepoRef('https://github.com/humanbased-ai/xny-monorepo/pull/12')).toBeNull()
    expect(parseRepoRef('xny-monorepo')).toBeNull()
    expect(parseRepoRef('')).toBeNull()
  })

  it('accepts any in-order subset of steps that begins with review', () => {
    expect(parseRepoWorkflowSteps('review')).toEqual(['review'])
    expect(parseRepoWorkflowSteps('[review,fix]')).toEqual(['review', 'fix'])
    expect(parseRepoWorkflowSteps('review, recheck')).toEqual(['review', 'recheck'])
    expect(parseRepoWorkflowSteps('review, fix, recheck')).toEqual(['review', 'fix', 'recheck'])
  })

  it('rejects step lists missing review, out of order, repeated, or with unknown steps', () => {
    expect(() => parseRepoWorkflowSteps('fix')).toThrow(/Expected steps/)              // missing review
    expect(() => parseRepoWorkflowSteps('recheck')).toThrow(/Expected steps/)          // missing review
    expect(() => parseRepoWorkflowSteps('fix,recheck')).toThrow(/Expected steps/)      // missing review
    expect(() => parseRepoWorkflowSteps('recheck,review')).toThrow(/Expected steps/)   // out of order
    expect(() => parseRepoWorkflowSteps('review,recheck,fix')).toThrow(/Expected steps/) // out of order
    expect(() => parseRepoWorkflowSteps('review,review')).toThrow(/Expected steps/)    // repeated step
    expect(() => parseRepoWorkflowSteps('review,bogus')).toThrow(/Expected steps/)     // unknown step
  })

  it('writes, reads, and removes a per-repo override file', () => {
    const path = writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review'], dir)
    expect(path).toBe(perRepoWorkflowPath('humanbased-ai', 'xny-monorepo', dir))
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toEqual(['review'])
    expect(removeRepoWorkflowOverride('humanbased-ai', 'xny-monorepo', dir)).toBe(true)
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toBeUndefined()
    // Second remove is a no-op, not an error.
    expect(removeRepoWorkflowOverride('humanbased-ai', 'xny-monorepo', dir)).toBe(false)
  })

  it('writes atomically — leaves no .tmp file, and overwrites cleanly', () => {
    writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review', 'fix'], dir)
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
    writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review'], dir)
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toEqual(['review'])
    expect(readdirSync(dir).filter(f => f.endsWith('.tmp'))).toEqual([])
  })

  it('reads and writes case-insensitively on owner/name', () => {
    writeRepoWorkflowStepTypes('Humanbased-AI', 'XNY-Monorepo', ['review'], dir)
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toEqual(['review'])
  })

  it('filters workflow.yml steps for a repo override; unset repo keeps the full workflow', () => {
    writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review'], dir)
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'xny-monorepo', steps, dir).map(s => s.type)).toEqual(['review'])
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'other', steps, dir).map(s => s.type)).toEqual(['review', 'fix', 'recheck', 'conflict-resolve'])
  })

  it('review-only override drops conflict-resolve', () => {
    writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review'], dir)
    const resolved = resolveRepoWorkflowSteps('humanbased-ai', 'xny-monorepo', steps, dir)
    expect(resolved.some(s => s.type === 'conflict-resolve')).toBe(false)
  })

  it('keeps conflict-resolve for fix-inclusive overrides (orthogonal to the depth ladder)', () => {
    writeRepoWorkflowStepTypes('humanbased-ai', 'api', ['review', 'fix'], dir)
    writeRepoWorkflowStepTypes('humanbased-ai', 'web', ['review', 'fix', 'recheck'], dir)
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'api', steps, dir).map(s => s.type))
      .toEqual(['review', 'fix', 'conflict-resolve'])
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'web', steps, dir).map(s => s.type))
      .toEqual(['review', 'fix', 'recheck', 'conflict-resolve'])
  })

  it('honours a review+recheck override: keeps recheck but drops fix and conflict-resolve', () => {
    const path = writeRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', ['review', 'recheck'], dir)
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toEqual(['review', 'recheck'])
    expect(path).toBe(perRepoWorkflowPath('humanbased-ai', 'xny-monorepo', dir))
    // review,recheck permits no code modification (no fix), so conflict-resolve is dropped too.
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'xny-monorepo', steps, dir).map(s => s.type))
      .toEqual(['review', 'recheck'])
  })

  it('falls back to the global workflow when the override file is malformed', () => {
    // An out-of-order/invalid step list must not narrow — fail open to the global workflow.
    writeFileSync(perRepoWorkflowPath('humanbased-ai', 'xny-monorepo', dir), 'steps: [fix]\n')
    expect(readRepoWorkflowStepTypes('humanbased-ai', 'xny-monorepo', dir)).toBeUndefined()
    expect(resolveRepoWorkflowSteps('humanbased-ai', 'xny-monorepo', steps, dir).map(s => s.type))
      .toEqual(['review', 'fix', 'recheck', 'conflict-resolve'])
  })
})
