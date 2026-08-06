import { describe, expect, it } from 'vitest'
import { appendSkillAttribution, formatSkillAttribution, renderSkillAttributionLine } from '../skills/attribution.js'
import { buildReviewCommentBody } from '../github/client.js'
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

const OTHER_SKILL: SkillMetadata = { ...SKILL, name: 'codebase-design', author: 'anthropic' }

describe('skill attribution', () => {
  it('renders the canonical identity format', () => {
    expect(formatSkillAttribution([SKILL])).toBe('code-review-skill (by @awesome-skills, MIT)')
  })

  it('keeps every skill on one line, separated by a middot', () => {
    expect(renderSkillAttributionLine([SKILL, OTHER_SKILL])).toBe(
      '_Skills: code-review-skill (by @awesome-skills, MIT) · codebase-design (by @anthropic, MIT)_',
    )
  })

  it('appends the receipt as a subtle trailing line', () => {
    expect(appendSkillAttribution('Review body', [SKILL])).toBe(
      'Review body\n\n_Skills: code-review-skill (by @awesome-skills, MIT)_',
    )
  })

  it('does not add attribution when no skill activated', () => {
    expect(appendSkillAttribution('Review body', [])).toBe('Review body')
    expect(renderSkillAttributionLine([])).toBe('')
  })

  it('places the receipt beneath the reviewer attribution, not in the body', () => {
    const body = buildReviewCommentBody({
      body: 'VERDICT: APPROVE',
      reviewer: 'claude',
      verdict: 'APPROVE',
      stepType: 'review',
      skills: [SKILL],
    })
    const attributionAt = body.indexOf('_Reviewed with [Claude Code]')
    const skillsAt = body.indexOf('_Skills: code-review-skill')

    expect(attributionAt).toBeGreaterThan(-1)
    expect(skillsAt).toBeGreaterThan(attributionAt)
    expect(body.slice(0, attributionAt)).not.toContain('code-review-skill')
  })

  it('uses the step receipt rather than the enabled catalog', () => {
    const session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())
    try {
      expect(appendSkillAttribution('Review body', session.activations())).toBe('Review body')
      callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })
      expect(appendSkillAttribution('Review body', session.activations()))
        .toContain('code-review-skill (by @awesome-skills, MIT)')
    } finally {
      session.close()
    }
  })
})
