import { describe, expect, it } from 'vitest'
import { ConfigSchema } from '../config/schema.js'
import {
  parseRepoRef,
  parseRepoWorkflowSteps,
  resolveRepoWorkflowSteps,
} from '../lib/repo-workflow.js'
import type { WorkflowStep } from '../lib/workflow.js'

const steps: WorkflowStep[] = [
  { name: 'review', type: 'review', reviewer: 'auto', max_rounds: 1 },
  { name: 'fix', type: 'fix', reviewer: 'origin', max_rounds: 1 },
  { name: 'recheck', type: 'recheck', reviewer: 'auto', max_rounds: 1 },
  { name: 'conflict-resolve', type: 'conflict-resolve', reviewer: 'auto', max_rounds: 1 },
]

describe('repo workflow helpers', () => {
  it('parses supported GitHub repo references', () => {
    expect(parseRepoRef('humanbased-ai/xny-monorepo')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
    expect(parseRepoRef('github.com/humanbased-ai/xny-monorepo')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
    expect(parseRepoRef('https://github.com/humanbased-ai/xny-monorepo.git')).toEqual({ owner: 'humanbased-ai', name: 'xny-monorepo' })
  })

  it('rejects PR URLs as repo references', () => {
    expect(parseRepoRef('https://github.com/humanbased-ai/xny-monorepo/pull/12')).toBeNull()
  })

  it('accepts the three repo workflow depths', () => {
    expect(parseRepoWorkflowSteps('review')).toEqual(['review'])
    expect(parseRepoWorkflowSteps('[review,fix]')).toEqual(['review', 'fix'])
    expect(parseRepoWorkflowSteps('review, fix, recheck')).toEqual(['review', 'fix', 'recheck'])
  })

  it('rejects unordered or partial step lists', () => {
    expect(() => parseRepoWorkflowSteps('fix')).toThrow(/Expected steps/)
    expect(() => parseRepoWorkflowSteps('review,recheck')).toThrow(/Expected steps/)
  })

  it('filters workflow.yml steps for a repo override', () => {
    const config = ConfigSchema.parse({
      repos: [{ owner: 'humanbased-ai', name: 'xny-monorepo', steps: ['review'] }],
    })

    expect(resolveRepoWorkflowSteps(config, 'humanbased-ai', 'xny-monorepo', steps).map(step => step.type)).toEqual(['review'])
    expect(resolveRepoWorkflowSteps(config, 'humanbased-ai', 'other', steps).map(step => step.type)).toEqual(['review', 'fix', 'recheck', 'conflict-resolve'])
  })
})
