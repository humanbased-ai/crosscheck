import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execFileSync } from 'child_process'
import { pathToFileURL } from 'url'
import { installSkill } from '../skills/installer.js'
import { loadInstalledSkills } from '../skills/catalog.js'

let tempDir: string
let sourceDir: string
let installDir: string

beforeEach(() => {
  tempDir = mkdtempSync(join(tmpdir(), 'crosscheck-skill-install-'))
  sourceDir = join(tempDir, 'source')
  installDir = join(tempDir, 'installed')
  mkdirSync(sourceDir)
  writeFileSync(join(sourceDir, 'SKILL.md'), `---
name: test-skill
description: Test guidance
author: acme
---

# Test skill
`)
  writeFileSync(join(sourceDir, 'LICENSE'), 'MIT License\n\nCopyright (c) 2026 Acme\n')
})

afterEach(() => {
  rmSync(tempDir, { recursive: true, force: true })
})

describe('installSkill', () => {
  it('installs a local skill with a provenance and integrity receipt', async () => {
    const skill = await installSkill(sourceDir, { installDir })
    const receipt = JSON.parse(readFileSync(join(installDir, 'test-skill', '.crosscheck-skill.json'), 'utf8')) as Record<string, unknown>

    expect(skill).toMatchObject({ name: 'test-skill', author: 'acme', license: 'MIT' })
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      name: 'test-skill',
      author: 'acme',
      license: 'MIT',
      source: sourceDir,
      revision: 'local',
    })
    expect(receipt.integrity).toMatch(/^sha256:[0-9a-f]{64}$/)
    expect(loadInstalledSkills(installDir)).toHaveLength(1)
  })

  it('does not overwrite an installed skill', async () => {
    await installSkill(sourceDir, { installDir })
    await expect(installSkill(sourceDir, { installDir })).rejects.toThrow('already installed')
  })

  it('records the commit when installing from a Git source', async () => {
    execFileSync('git', ['init'], { cwd: sourceDir })
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: sourceDir })
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: sourceDir })
    execFileSync('git', ['add', '.'], { cwd: sourceDir })
    execFileSync('git', ['commit', '-m', 'test skill'], { cwd: sourceDir })

    const skill = await installSkill(pathToFileURL(sourceDir).href, { installDir })

    expect(skill.revision).toMatch(/^[0-9a-f]{40}$/)
  })

  it('rejects unsafe skill names', async () => {
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: ../escape\ndescription: nope\n---\n')
    await expect(installSkill(sourceDir, { installDir })).rejects.toThrow('Invalid skill name')
    expect(existsSync(join(tempDir, 'escape'))).toBe(false)
  })

  it('rejects symbolic links in a package', async () => {
    symlinkSync(join(sourceDir, 'LICENSE'), join(sourceDir, 'linked-license'))
    await expect(installSkill(sourceDir, { installDir })).rejects.toThrow('symbolic links')
  })

  it('does not load an installed skill after its contents are modified', async () => {
    await installSkill(sourceDir, { installDir })
    writeFileSync(join(installDir, 'test-skill', 'SKILL.md'), '\nTampered\n', { flag: 'a' })

    expect(loadInstalledSkills(installDir)).toEqual([])
  })

  it('rejects oversized skill packages', async () => {
    writeFileSync(join(sourceDir, 'large.bin'), Buffer.alloc(10 * 1024 * 1024 + 1))

    await expect(installSkill(sourceDir, { installDir })).rejects.toThrow('cannot exceed 10 MiB')
  })

  it('rejects attribution fields that could inject terminal or Markdown output', async () => {
    writeFileSync(join(sourceDir, 'SKILL.md'), '---\nname: test-skill\ndescription: Test guidance\nauthor: "acme\\nspoof"\n---\n')

    await expect(installSkill(sourceDir, { installDir })).rejects.toThrow('Invalid skill author')
  })
})
