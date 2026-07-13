import { describe, expect, it } from 'vitest'
import { applyRepoWorkflowOverride } from '../commands/alter.js'

describe('applyRepoWorkflowOverride', () => {
  it('updates an existing repo entry and preserves unrelated fields', () => {
    const raw: Record<string, unknown> = {
      deployment: 'team',
      orgs: ['humanbased-ai'],
      repos: [
        { owner: 'humanbased-ai', name: 'xny-monorepo', note: 'keep me' },
        { owner: 'humanbased-ai', name: 'other' },
      ],
      routing: { fallback_reviewer: 'auto' },
    }

    applyRepoWorkflowOverride(raw, 'humanbased-ai', 'xny-monorepo', ['review'])

    expect(raw).toMatchObject({
      deployment: 'team',
      orgs: ['humanbased-ai'],
      routing: { fallback_reviewer: 'auto' },
      repos: [
        { owner: 'humanbased-ai', name: 'xny-monorepo', note: 'keep me', steps: ['review'] },
        { owner: 'humanbased-ai', name: 'other' },
      ],
    })
  })

  it('appends a repo entry when the repo is not already listed', () => {
    const raw: Record<string, unknown> = { orgs: ['humanbased-ai'], repos: [] }

    applyRepoWorkflowOverride(raw, 'humanbased-ai', 'xny-monorepo', ['review', 'fix'])

    expect(raw.repos).toEqual([
      { owner: 'humanbased-ai', name: 'xny-monorepo', steps: ['review', 'fix'] },
    ])
  })
})
