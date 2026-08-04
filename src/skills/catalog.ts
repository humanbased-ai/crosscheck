import { existsSync, readFileSync, readdirSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import yaml from 'js-yaml'

export interface SkillIdentity {
  name: string
  description: string
  author: string
  license: string
  source: string
  revision: string
  integrity: string
  path: string
}

interface SkillReceipt extends Omit<SkillIdentity, 'description' | 'path'> {
  schemaVersion: 1
}

export interface SkillFrontmatter {
  name?: string
  description?: string
  author?: string
  license?: string
}

export const RECOMMENDED_SKILL_NAMES = ['code-review-skill'] as const

const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../assets/skills/', import.meta.url))
export const INSTALLED_SKILLS_DIR = join(homedir(), '.crosscheck', 'skills')

export function readSkillFrontmatter(skillPath: string): SkillFrontmatter {
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  return match ? (yaml.load(match[1]) as SkillFrontmatter) : {}
}

function loadSkills(rootDir: string): SkillIdentity[] {
  if (!existsSync(rootDir)) return []
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .map(entry => {
      const path = join(rootDir, entry.name)
      const receipt = JSON.parse(readFileSync(join(path, '.crosscheck-skill.json'), 'utf8')) as SkillReceipt
      const frontmatter = readSkillFrontmatter(path)
      return {
        name: receipt.name,
        description: frontmatter.description?.trim() ?? '',
        author: receipt.author,
        license: receipt.license,
        source: receipt.source,
        revision: receipt.revision,
        integrity: receipt.integrity,
        path,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function loadBundledSkills(rootDir = BUNDLED_SKILLS_DIR): SkillIdentity[] {
  return loadSkills(rootDir)
}

export function loadInstalledSkills(rootDir = INSTALLED_SKILLS_DIR): SkillIdentity[] {
  return loadSkills(rootDir)
}

export function loadSkillCatalog(installedRoot = INSTALLED_SKILLS_DIR): SkillIdentity[] {
  const skills = new Map(loadBundledSkills().map(skill => [skill.name, skill]))
  for (const skill of loadInstalledSkills(installedRoot)) {
    if (!skills.has(skill.name)) skills.set(skill.name, skill)
  }
  return [...skills.values()].sort((a, b) => a.name.localeCompare(b.name))
}

export function formatSkillIdentity(skill: Pick<SkillIdentity, 'name' | 'author' | 'license'>): string {
  return `${skill.name} (by @${skill.author}, ${skill.license})`
}
