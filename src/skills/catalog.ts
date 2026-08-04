import { existsSync, readFileSync, readdirSync, statSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { computeSkillIntegrity } from './integrity.js'

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

export const RECOMMENDED_SKILL_NAMES = ['code-review-skill', 'diagnosing-bugs'] as const

const BUNDLED_SKILLS_DIR = fileURLToPath(new URL('../../assets/skills/', import.meta.url))
export const INSTALLED_SKILLS_DIR = join(homedir(), '.crosscheck', 'skills')

export function readSkillFrontmatter(skillPath: string): SkillFrontmatter {
  const content = readFileSync(join(skillPath, 'SKILL.md'), 'utf8')
  const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content)
  if (!match) return {}
  const parsed: unknown = yaml.load(match[1])
  return typeof parsed === 'object' && parsed !== null ? parsed as SkillFrontmatter : {}
}

export function isValidSkillAuthor(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,37}[a-zA-Z0-9])?$/.test(value)
}

export function isValidSkillLicense(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9.+() -]{0,99}$/.test(value)
}

function isSkillReceipt(value: unknown): value is SkillReceipt {
  if (typeof value !== 'object' || value === null) return false
  const receipt = value as Record<string, unknown>
  return receipt.schemaVersion === 1
    && typeof receipt.name === 'string' && /^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(receipt.name)
    && isValidSkillAuthor(receipt.author)
    && isValidSkillLicense(receipt.license)
    && typeof receipt.source === 'string' && receipt.source.length > 0
    && typeof receipt.revision === 'string' && receipt.revision.length > 0
    && typeof receipt.integrity === 'string' && /^sha256:[0-9a-f]{64}$/.test(receipt.integrity)
}

function loadSkills(rootDir: string, skipInvalid: boolean): SkillIdentity[] {
  if (!existsSync(rootDir)) return []
  return readdirSync(rootDir, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && !entry.name.startsWith('.'))
    .flatMap(entry => {
      const path = join(rootDir, entry.name)
      try {
        const receiptPath = join(path, '.crosscheck-skill.json')
        if (statSync(receiptPath).size > 64 * 1024) throw new Error(`Invalid skill receipt: ${entry.name}`)
        const integrity = computeSkillIntegrity(path)
        const receipt: unknown = JSON.parse(readFileSync(receiptPath, 'utf8'))
        const frontmatter = readSkillFrontmatter(path)
        if (!isSkillReceipt(receipt) || receipt.name !== entry.name || frontmatter.name !== receipt.name
          || typeof frontmatter.description !== 'string' || !frontmatter.description.trim()
          || integrity !== receipt.integrity) {
          throw new Error(`Invalid skill package: ${entry.name}`)
        }
        return [{
          name: receipt.name,
          description: frontmatter.description.trim(),
          author: receipt.author,
          license: receipt.license,
          source: receipt.source,
          revision: receipt.revision,
          integrity: receipt.integrity,
          path,
        }]
      } catch (err: unknown) {
        if (skipInvalid) return []
        throw err
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))
}

export function loadBundledSkills(rootDir = BUNDLED_SKILLS_DIR): SkillIdentity[] {
  return loadSkills(rootDir, false)
}

export function loadInstalledSkills(rootDir = INSTALLED_SKILLS_DIR): SkillIdentity[] {
  return loadSkills(rootDir, true)
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
