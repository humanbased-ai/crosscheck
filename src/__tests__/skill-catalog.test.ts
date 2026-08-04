import { describe, expect, it } from 'vitest'
import { formatSkillIdentity, loadBundledSkills, RECOMMENDED_SKILL_NAMES } from '../skills/catalog.js'

describe('bundled skill catalog', () => {
  it('loads the pinned recommended code-review skill with attribution', () => {
    const skill = loadBundledSkills().find(candidate => candidate.name === 'code-review-skill')

    expect(skill).toMatchObject({
      name: 'code-review-skill',
      author: 'awesome-skills',
      license: 'MIT',
      source: 'https://github.com/awesome-skills/code-review-skill',
    })
    expect(skill?.description).not.toBe('')
    expect(skill?.revision).toMatch(/^[0-9a-f]{40}$/)
    expect(skill?.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(formatSkillIdentity(skill!)).toBe('code-review-skill (by @awesome-skills, MIT)')
  })

  it('ships Matt Pocock engineering skills with attribution', () => {
    const skills = loadBundledSkills()

    expect(skills.filter(skill => skill.author === 'mattpocock').map(skill => skill.name)).toEqual([
      'code-review',
      'codebase-design',
      'diagnosing-bugs',
    ])
    expect(skills.filter(skill => skill.author === 'mattpocock').every(skill => (
      skill.license === 'MIT'
      && skill.source === 'https://github.com/mattpocock/skills'
      && /^[0-9a-f]{40}$/.test(skill.revision)
      && /^sha256:[0-9a-f]{64}$/.test(skill.integrity)
    ))).toBe(true)
  })

  it('preselects the review baseline and debugging discipline during onboarding', () => {
    expect(RECOMMENDED_SKILL_NAMES).toEqual(['code-review-skill', 'diagnosing-bugs'])
    expect(RECOMMENDED_SKILL_NAMES).not.toContain('code-review')
    expect(RECOMMENDED_SKILL_NAMES).not.toContain('codebase-design')
  })
})
