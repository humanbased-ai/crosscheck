import { createHash } from 'crypto'
import { lstatSync, readFileSync, readdirSync, statSync } from 'fs'
import { join, relative, sep } from 'path'

export const MAX_SKILL_PACKAGE_FILES = 1_000
export const MAX_SKILL_PACKAGE_BYTES = 10 * 1024 * 1024

function packageFiles(rootDir: string, currentDir: string, files: string[]): void {
  for (const entry of readdirSync(currentDir, { withFileTypes: true })) {
    if (entry.name === '.git' || entry.name === '.crosscheck-skill.json') continue
    const path = join(currentDir, entry.name)
    if (lstatSync(path).isSymbolicLink()) throw new Error('Skill packages cannot contain symbolic links')
    if (entry.isDirectory()) packageFiles(rootDir, path, files)
    else if (entry.isFile()) {
      files.push(path)
      if (files.length > MAX_SKILL_PACKAGE_FILES) throw new Error(`Skill packages cannot contain more than ${MAX_SKILL_PACKAGE_FILES} files`)
    }
  }
}

export function computeSkillIntegrity(rootDir: string): string {
  const files: string[] = []
  packageFiles(rootDir, rootDir, files)
  files.sort((a, b) => relative(rootDir, a).localeCompare(relative(rootDir, b)))

  const totalBytes = files.reduce((sum, path) => sum + statSync(path).size, 0)
  if (totalBytes > MAX_SKILL_PACKAGE_BYTES) throw new Error('Skill packages cannot exceed 10 MiB')

  const hash = createHash('sha256')
  for (const path of files) {
    hash.update(relative(rootDir, path).split(sep).join('/')).update('\0')
    hash.update(readFileSync(path)).update('\0')
  }
  return `sha256:${hash.digest('hex')}`
}
