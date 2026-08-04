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

  it('recommends the bundled starter skill', () => {
    expect(RECOMMENDED_SKILL_NAMES).toEqual(['code-review-skill'])
  })
})
