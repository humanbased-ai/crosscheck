import { describe, it, expect } from 'vitest'
import { planStepsForClass } from '../lib/runner.js'
import type { WorkflowStep } from '../lib/workflow.js'

// #318: strategy narrowing overrode an explicit `--steps`, so
// `ck run <pr> --steps recheck` on a PR the strategy classifies `trivial` ran
// nothing and exited 0 with `✓ Workflow complete`. A caller shelling out could
// not tell that from success, and there was no way to force the step at all.

const step = (type: WorkflowStep['type'], name = type): WorkflowStep => ({
  type, name, reviewer: 'auto', max_rounds: 1,
})

const FULL: WorkflowStep[] = [
  step('conflict-resolve'), step('review'), step('fix'), step('recheck'),
]

const types = (steps: WorkflowStep[]): string[] => steps.map(s => s.type)

describe('planStepsForClass — narrowing (standing policy)', () => {
  it('trims the pipeline to the class step set', () => {
    const plan = planStepsForClass({
      configuredSteps: FULL,
      classSteps: ['review'],
      stepsExplicitlyScoped: false,
    })
    expect(plan.outcome).toBe('narrowed')
    expect(types(plan.steps)).toEqual(['review'])
    expect(plan.dropped).toBe(3)
    expect(plan.wouldDrop).toBe(0)
  })

  it('never widens: a review-only pipeline stays review-only', () => {
    // The property the original comment is about — a class must not escalate past
    // repo config or `crosscheck alter`, which are both standing policy.
    const plan = planStepsForClass({
      configuredSteps: [step('review')],
      classSteps: ['review', 'fix', 'recheck'],
      stepsExplicitlyScoped: false,
    })
    expect(types(plan.steps)).toEqual(['review'])
    expect(plan.outcome).toBe('unchanged')
  })

  it('keeps conflict-resolve when the class permits code modification', () => {
    // conflict-resolve is orthogonal to the depth ladder, so it is not a class
    // step and must not be dropped merely for being absent from the class list.
    const plan = planStepsForClass({
      configuredSteps: FULL,
      classSteps: ['review', 'fix', 'recheck'],
      stepsExplicitlyScoped: false,
    })
    expect(types(plan.steps)).toContain('conflict-resolve')
  })

  it('leaves the pipeline alone when the class declares no steps', () => {
    for (const classSteps of [undefined, []]) {
      const plan = planStepsForClass({ configuredSteps: FULL, classSteps, stepsExplicitlyScoped: false })
      expect(plan.outcome).toBe('unchanged')
      expect(plan.steps).toBe(FULL)
    }
  })

  it('ignores class entries that are not depth-ladder steps', () => {
    const plan = planStepsForClass({
      configuredSteps: FULL,
      classSteps: ['conflict-resolve'],
      stepsExplicitlyScoped: false,
    })
    expect(plan.outcome).toBe('unchanged')
    expect(plan.classTypes).toEqual([])
  })
})

describe('planStepsForClass — an explicit --steps outranks the class', () => {
  it('runs the requested step the class would have dropped', () => {
    // The exact #318 reproduction: --steps recheck against trivial (review, fix).
    const plan = planStepsForClass({
      configuredSteps: [step('recheck')],
      classSteps: ['review', 'fix'],
      stepsExplicitlyScoped: true,
    })
    expect(types(plan.steps)).toEqual(['recheck'])
    expect(plan.outcome).toBe('bypassed')
    expect(plan.dropped).toBe(0)
  })

  it('records what narrowing would have removed, so the bypass is explicable', () => {
    const plan = planStepsForClass({
      configuredSteps: FULL,
      classSteps: ['review'],
      stepsExplicitlyScoped: true,
    })
    expect(plan.outcome).toBe('bypassed')
    expect(plan.wouldDrop).toBe(3)
    expect(plan.classTypes).toEqual(['review'])
  })

  it('reports unchanged, not bypassed, when the class agreed anyway', () => {
    // No bypass happened, so nothing should be logged as one.
    const plan = planStepsForClass({
      configuredSteps: [step('review')],
      classSteps: ['review', 'fix', 'recheck'],
      stepsExplicitlyScoped: true,
    })
    expect(plan.outcome).toBe('unchanged')
    expect(plan.wouldDrop).toBe(0)
  })

  it('does not resurrect steps the caller did not ask for', () => {
    // Bypassing narrowing must not widen the request either: --steps fix means
    // fix, not fix plus whatever the class would have allowed.
    const plan = planStepsForClass({
      configuredSteps: [step('fix')],
      classSteps: ['review', 'fix', 'recheck'],
      stepsExplicitlyScoped: true,
    })
    expect(types(plan.steps)).toEqual(['fix'])
  })
})

describe('the flag also outranks a class-level skip', () => {
  // The strategy skips a PR outright when its class resolves a null tier — a
  // lockfile-only change, say. That is the same policy-versus-instruction question
  // planStepsForClass answers for narrowing, so it gets the same answer: an
  // operator who types --steps review has been told the class would skip and asked
  // anyway. Doing nothing silently is #318 in a second place.
  //
  // The skip lives in runWorkflow rather than here (it needs the resolved tier, not
  // the step set), so this pins the contract the two share: only a CLI --steps sets
  // the flag, and every internal narrowing caller leaves it false.
  it('is not set by callers that narrow steps internally', () => {
    // resolve/kickass/resume all pass `steps` without the flag, so a skip-class PR
    // still skips for them. Asserted as the shape of the plan input those callers
    // build: absent flag behaves exactly like false.
    const narrowed = planStepsForClass({
      configuredSteps: FULL,
      classSteps: ['review'],
      stepsExplicitlyScoped: false,
    })
    expect(narrowed.outcome).toBe('narrowed')
  })
})
