import { describe, expect, it } from 'vitest'
import { appendSkillAttribution, formatSkillAttribution } from '../skills/attribution.js'
import type { SkillMetadata } from '../skills/broker.js'
import { callSkillBrokerTool, createSkillActivationSession } from '../skills/broker.js'
import { loadBundledSkills } from '../skills/catalog.js'

const SKILL: SkillMetadata = {
  name: 'code-review-skill',
  description: 'Review guidance',
  author: 'awesome-skills',
  license: 'MIT',
  source: 'https://github.com/awesome-skills/code-review-skill',
  revision: 'a'.repeat(40),
  integrity: `sha256:${'b'.repeat(64)}`,
}

describe('skill attribution', () => {
  it('renders the canonical identity format', () => {
    expect(formatSkillAttribution([SKILL])).toBe('code-review-skill (by @awesome-skills, MIT)')
  })

  it('attributes only activated skills for the named step', () => {
    expect(appendSkillAttribution('Review body', [SKILL], 'recheck')).toBe(
      'Review body\n\n---\n🧩 **Skills activated for recheck:** code-review-skill (by @awesome-skills, MIT)',
    )
  })

  it('does not add attribution when no skill activated', () => {
    expect(appendSkillAttribution('Review body', [], 'review')).toBe('Review body')
  })

  it('uses the step receipt rather than the enabled catalog', () => {
    const session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())
    try {
      expect(appendSkillAttribution('Review body', session.activations(), 'review')).toBe('Review body')
      callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })
      expect(appendSkillAttribution('Review body', session.activations(), 'review'))
        .toContain('code-review-skill (by @awesome-skills, MIT)')
    } finally {
      session.close()
    }
  })
})
