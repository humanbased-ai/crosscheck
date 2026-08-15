import { describe, expect, it } from 'vitest'
import { buildFixRecheckSteps, buildRunChildArgs, headShaForStalenessClaim, resolveWorkflowSteps } from '../commands/run.js'
import type { PRRef } from '../lib/pr-spec.js'
import type { WorkflowStep } from '../lib/workflow.js'

const reviewStep: WorkflowStep = {
  name: 'review',
  type: 'review',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'review instructions',
}

const fixStep: WorkflowStep = {
  name: 'fix',
  type: 'fix',
  reviewer: 'origin',
  max_rounds: 1,
  instructions: 'fix instructions',
}

const recheckStep: WorkflowStep = {
  name: 'recheck',
  type: 'recheck',
  reviewer: 'auto',
  max_rounds: 1,
  instructions: 'custom recheck',
}

describe('resolveWorkflowSteps', () => {
  it('synthesizes recheck when --steps asks for it but the workflow has only review+fix', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep], ['fix', 'recheck'], 'codex')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      type: 'recheck',
      reviewer: 'codex',
    })
  })

  it('preserves explicit recheck steps', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep, recheckStep], ['fix', 'recheck'], 'claude')

    expect(steps.map(step => step.name)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      instructions: 'custom recheck',
      reviewer: 'claude',
    })
  })

  it('pins --reviewer to review and recheck only', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep, recheckStep], undefined, 'codex', { reviewer: 'codex' })

    expect(steps.find(step => step.type === 'review')?.reviewer).toBe('codex')
    expect(steps.find(step => step.type === 'recheck')?.reviewer).toBe('codex')
    expect(steps.find(step => step.type === 'fix')?.reviewer).toBe('origin')
  })

  it('pins --fixer to fix only', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep, recheckStep], undefined, 'codex', { fixer: 'claude' })

    expect(steps.find(step => step.type === 'review')?.reviewer).toBe('codex')
    expect(steps.find(step => step.type === 'recheck')?.reviewer).toBe('codex')
    expect(steps.find(step => step.type === 'fix')?.reviewer).toBe('claude')
  })

  it('pins --vendor to review, recheck, and fix', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep, recheckStep], undefined, 'codex', { vendor: 'claude' })

    expect(steps.find(step => step.type === 'review')?.reviewer).toBe('claude')
    expect(steps.find(step => step.type === 'recheck')?.reviewer).toBe('claude')
    expect(steps.find(step => step.type === 'fix')?.reviewer).toBe('claude')
  })

  it('synthesizes conflict-resolve when --steps asks for it but the workflow has none', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep], ['conflict-resolve'], 'claude')

    expect(steps.map(step => step.type)).toEqual(['conflict-resolve'])
    expect(steps[0]).toMatchObject({ name: 'conflict-resolve', type: 'conflict-resolve', reviewer: 'claude' })
  })

  it('pins the synthesized conflict-resolve reviewer to --vendor', () => {
    const steps = resolveWorkflowSteps([reviewStep, fixStep], ['conflict-resolve'], 'codex', { vendor: 'claude' })

    expect(steps[0]).toMatchObject({ type: 'conflict-resolve', reviewer: 'claude' })
  })

  it('selects an existing conflict-resolve step instead of synthesizing', () => {
    const conflictStep: WorkflowStep = {
      name: 'conflict-resolve', type: 'conflict-resolve', reviewer: 'claude', max_rounds: 1, instructions: 'custom resolve',
    }
    const steps = resolveWorkflowSteps([reviewStep, conflictStep, fixStep], ['conflict-resolve'], 'codex')

    expect(steps).toHaveLength(1)
    expect(steps[0]).toMatchObject({ instructions: 'custom resolve' })
  })
})

describe('buildRunChildArgs', () => {
  const ref: PRRef = { owner: 'acme', repo: 'web', number: 245, url: 'https://github.com/acme/web/pull/245' }

  it('builds a bare run invocation with the default trigger', () => {
    expect(buildRunChildArgs(ref, {})).toEqual(['run', ref.url, '--trigger', 'run'])
  })

  it('forwards vendor, fixer, steps, and config flags', () => {
    const args = buildRunChildArgs(ref, { config: 'c.yml', reviewer: 'codex', fixer: 'claude', vendor: 'codex', steps: 'fix' })
    expect(args).toEqual(['run', ref.url, '-c', 'c.yml', '--reviewer', 'codex', '--fixer', 'claude', '--vendor', 'codex', '--steps', 'fix', '--trigger', 'run'])
  })

  it('passes --crazy and omits any timeout flag in round mode', () => {
    const args = buildRunChildArgs(ref, { roundMode: 'crazy', timeout: '300s' })
    expect(args).toContain('--crazy')
    expect(args).not.toContain('--timeout')
    expect(args).not.toContain('--no-timeout')
  })

  it('passes --half-crazy for halfcrazy round mode', () => {
    expect(buildRunChildArgs(ref, { roundMode: 'halfcrazy' })).toContain('--half-crazy')
  })

  it('passes --no-timeout when requested outside round mode', () => {
    const args = buildRunChildArgs(ref, { noTimeout: true })
    expect(args).toContain('--no-timeout')
    expect(args).not.toContain('--timeout')
  })

  it('forwards an explicit --timeout outside round mode', () => {
    expect(buildRunChildArgs(ref, { timeout: '600s' })).toEqual(['run', ref.url, '--timeout', '600s', '--trigger', 'run'])
  })

  it('forwards --dry-run', () => {
    expect(buildRunChildArgs(ref, { dryRun: true })).toContain('--dry-run')
  })
})

describe('buildFixRecheckSteps', () => {
  it('uses the full workflow for round-mode followups after an initial review-only run', () => {
    const steps = buildFixRecheckSteps([reviewStep], [reviewStep, fixStep], 'codex')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      type: 'recheck',
      reviewer: 'codex',
    })
  })

  it('prepends fix for round-mode followups after an initial recheck-only run', () => {
    const steps = buildFixRecheckSteps([recheckStep], [reviewStep, fixStep, recheckStep], 'claude')

    expect(steps.map(step => step.type)).toEqual(['fix', 'recheck'])
    expect(steps[1]).toMatchObject({
      name: 'recheck',
      instructions: 'custom recheck',
      reviewer: 'auto',
    })
  })
})

// The staleness line is the report's one claim about whether the standing
// verdict still describes the code. A fix step pushing a commit invalidates the
// head captured at dispatch, so the claim is measured against a fresh read.
describe('headShaForStalenessClaim', () => {
  const PRE_RUN_HEAD = 'df95a6b1111111111111111111111111111111a'
  const PUSHED_HEAD = '57ef3ef2d46d35af5b0361b362c8069394d7133c'

  it('measures against the head as it is now, not the one captured at dispatch', async () => {
    const head = await headShaForStalenessClaim(
      { verdict: 'BLOCK' },
      async () => PUSHED_HEAD,
    )

    expect(head).toBe(PUSHED_HEAD)
    expect(head).not.toBe(PRE_RUN_HEAD)
  })

  it('reads nothing when there is no standing verdict to measure', async () => {
    let fetched = false
    const head = await headShaForStalenessClaim(undefined, async () => {
      fetched = true
      return PUSHED_HEAD
    })

    expect(head).toBeUndefined()
    expect(fetched).toBe(false)
  })

  it('drops the claim rather than falling back to a stale head', async () => {
    const head = await headShaForStalenessClaim(
      { verdict: 'BLOCK' },
      async () => { throw new Error('HttpError: 502 Bad Gateway') },
    )

    expect(head).toBeUndefined()
  })
})
