import { readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

export interface SkillIdentity {
  name: string
  description: string
  author: string
  license: string
  source: string
  revision: string
  path: string
}

interface SkillReceipt extends Omit<SkillIdentity, 'description' | 'path'> {
  schemaVersion: 1
}

interface SkillFrontmatter {
  name?: string
  description?: string
}

export const RECOMMENDED_SKILL_NAMES = ['code-review-skill'] as const

const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../assets/skills/', import.meta.url))

function readFrontmatter(skillPath: string): SkillFrontmatter {
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  return match ? (yaml.load(match[1]) as SkillFrontmatter) : {}
}

export function loadBundledSkills(rootDir = BUNDLED_SKILLS_DIR): SkillIdentity[] {
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory())
    .map(entry => {
      const path = join(rootDir, entry.name)
      const receipt = JSON.parse(readFileSync(join(path, '.crosscheck-skill.json'), 'utf8')) as SkillReceipt
      const frontmatter = readFrontmatter(path)
      return {
        name: receipt.name,
        description: frontmatter.description?.trim() ?? '',
        author: receipt.author,
        license: receipt.license,
        source: receipt.source,
        revision: receipt.revision,
        path,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function formatSkillIdentity(skill: SkillIdentity): string {
  return `${skill.name} (by @${skill.author}, ${skill.license})`
}
