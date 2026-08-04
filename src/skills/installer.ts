import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'fs'
import { basename, join, resolve } from 'path'
import { tmpdir } from 'os'
import { execa } from 'execa'
import { INSTALLED_SKILLS_DIR, isValidSkillAuthor, isValidSkillLicense, loadBundledSkills, loadInstalledSkills, readSkillFrontmatter, type SkillIdentity } from './catalog.js'
import { computeSkillIntegrity } from './integrity.js'

export { computeSkillIntegrity } from './integrity.js'

export interface InstallSkillOptions {
  installDir?: string
}

export class SkillInstallError extends Error {}

export function redactSkillSource(source: string): string {
  if (existsSync(source)) return resolve(source)
  try {
    const url = new URL(source)
    url.username = ''
    url.password = ''
    return url.toString()
  } catch {
    return source
  }
}

function detectLicense(rootDir: string, declared?: unknown): string {
  if (typeof declared === 'string' && declared.trim()) return declared.trim()
  const licenseName = ['LICENSE', 'LICENSE.md', 'COPYING'].find(name => existsSync(join(rootDir, name)))
  if (!licenseName) return 'UNKNOWN'
  const license = readFileSync(join(rootDir, licenseName), 'utf8')
  if (/MIT License/i.test(license)) return 'MIT'
  if (/Apache License[\s\S]*Version 2\.0/i.test(license)) return 'Apache-2.0'
  if (/BSD 3-Clause/i.test(license)) return 'BSD-3-Clause'
  if (/ISC License/i.test(license)) return 'ISC'
  return 'UNKNOWN'
}

function detectAuthor(source: string, declared?: unknown): string {
  if (typeof declared === 'string' && declared.trim()) return declared.trim().replace(/^@/, '')
  return /github\.com[/:]([^/]+)/i.exec(source)?.[1] ?? 'local'
}

async function checkoutSource(source: string): Promise<{ path: string; revision: string; cleanup?: string }> {
  if (existsSync(source)) {
    const path = resolve(source)
    if (lstatSync(path).isSymbolicLink()) throw new SkillInstallError('Skill source cannot be a symbolic link')
    if (!statSync(path).isDirectory()) throw new SkillInstallError(`Skill source is not a directory: ${source}`)
    return { path, revision: 'local' }
  }

  const cleanup = mkdtempSync(join(tmpdir(), 'crosscheck-skill-clone-'))
  const path = join(cleanup, 'source')
  try {
    await execa('git', ['clone', '--depth', '1', source, path])
    const revision = (await execa('git', ['-C', path, 'rev-parse', 'HEAD'])).stdout.trim()
    return { path, revision, cleanup }
  } catch (err: unknown) {
    rmSync(cleanup, { recursive: true, force: true })
    throw new SkillInstallError(`Could not clone skill source: ${err instanceof Error ? err.message : String(err)}`)
  }
}

export async function installSkill(source: string, opts: InstallSkillOptions = {}): Promise<SkillIdentity> {
  const installDir = resolve(opts.installDir ?? INSTALLED_SKILLS_DIR)
  const checkout = await checkoutSource(source)
  try {
    if (!existsSync(join(checkout.path, 'SKILL.md'))) {
      throw new SkillInstallError('Skill package must contain SKILL.md')
    }
    try {
      computeSkillIntegrity(checkout.path)
    } catch (err: unknown) {
      throw new SkillInstallError(err instanceof Error ? err.message : String(err))
    }
    let frontmatter
    try {
      frontmatter = readSkillFrontmatter(checkout.path)
    } catch (err: unknown) {
      throw new SkillInstallError(`Invalid SKILL.md frontmatter: ${err instanceof Error ? err.message : String(err)}`)
    }
    const name = typeof frontmatter.name === 'string' ? frontmatter.name : ''
    if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) {
      throw new SkillInstallError(`Invalid skill name: ${name || '(missing)'}`)
    }
    if (typeof frontmatter.description !== 'string' || !frontmatter.description.trim()) {
      throw new SkillInstallError('Skill frontmatter must include a description')
    }
    if (loadBundledSkills().some(skill => skill.name === name)) {
      throw new SkillInstallError(`Skill ${name} is already bundled with Crosscheck`)
    }

    mkdirSync(installDir, { recursive: true })
    const target = join(installDir, name)
    if (existsSync(target)) {
      throw new SkillInstallError(`Skill ${name} is already installed`)
    }
    const pendingTarget = join(installDir, `.install-${name}-${process.pid}`)

    try {
      cpSync(checkout.path, pendingTarget, {
        recursive: true,
        filter: path => basename(path) !== '.git' && basename(path) !== '.crosscheck-skill.json',
      })
      const author = detectAuthor(source, frontmatter.author)
      const license = detectLicense(checkout.path, frontmatter.license)
      if (!isValidSkillAuthor(author)) throw new SkillInstallError(`Invalid skill author: ${author}`)
      if (!isValidSkillLicense(license)) throw new SkillInstallError(`Invalid skill license: ${license}`)
      const receipt = {
        schemaVersion: 1,
        name,
        author,
        license,
        source: redactSkillSource(source),
        revision: checkout.revision,
        integrity: computeSkillIntegrity(pendingTarget),
      }
      writeFileSync(join(pendingTarget, '.crosscheck-skill.json'), `${JSON.stringify(receipt, null, 2)}\n`)
      renameSync(pendingTarget, target)
      return loadInstalledSkills(installDir).find(skill => skill.name === name)!
    } catch (err: unknown) {
      rmSync(pendingTarget, { recursive: true, force: true })
      throw err
    }
  } finally {
    if (checkout.cleanup) rmSync(checkout.cleanup, { recursive: true, force: true })
  }
}
