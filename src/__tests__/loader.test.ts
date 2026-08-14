import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { patchAllowedAuthors, resolveConfigPath } from '../config/loader.js'

let tmpDir: string

beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), 'crosscheck-loader-test-')) })
afterEach(() => { rmSync(tmpDir, { recursive: true, force: true }) })

function write(name: string, content: string): string {
  const p = join(tmpDir, name)
  writeFileSync(p, content)
  return p
}

function read(p: string): string {
  return readFileSync(p, 'utf8')
}

describe('patchAllowedAuthors', () => {
  // ── Case 1: commented-out placeholder ───────────────────────────────────

  it('case 1 — uncomments placeholder block', () => {
    const p = write('c1.yml', [
      'mode: cross-vendor',
      'routing:',
      '  # allowed_authors:',
      '  #   - beingzy',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
    expect(out).not.toContain('# allowed_authors')
  })

  // ── Case 2: multi-line empty (key present, no entries) ──────────────────

  it('case 2 — fills multi-line empty allowed_authors', () => {
    const p = write('c2.yml', [
      'routing:',
      '  allowed_authors:',
      '  codex_reviews_patterns: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  it('case 2 — fills allowed_authors that has only comment lines', () => {
    const p = write('c2b.yml', [
      'routing:',
      '  allowed_authors:',
      '  # - somebot',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  // ── Case 3: inline empty array ──────────────────────────────────────────

  it('case 3 — fills allowed_authors: []', () => {
    const p = write('c3a.yml', [
      'routing:',
      '  allowed_authors: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
    expect(out).not.toContain('[]')
  })

  it('case 3 — fills allowed_authors: [ ] (with space)', () => {
    const p = write('c3b.yml', [
      'routing:',
      '  allowed_authors: [ ]',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    expect(read(p)).toContain('    - alice')
  })

  // ── Case 4: routing: exists but no allowed_authors key ──────────────────

  it('case 4 — appends allowed_authors after routing: when key is absent', () => {
    const p = write('c4.yml', [
      'mode: cross-vendor',
      'routing:',
      '  codex_reviews_patterns: []',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('  allowed_authors:\n    - alice')
  })

  // ── Case 5 (new): no routing: section at all ────────────────────────────

  it('case 5 — appends routing block when no routing: section exists', () => {
    const p = write('c5.yml', 'mode: cross-vendor\n')
    expect(patchAllowedAuthors(p, 'alice')).toBe(true)
    const out = read(p)
    expect(out).toContain('routing:')
    expect(out).toContain('  allowed_authors:')
    expect(out).toContain('    - alice')
  })

  it('case 5 — works for completely minimal config (no trailing newline)', () => {
    const p = write('c5b.yml', 'mode: cross-vendor')
    expect(patchAllowedAuthors(p, 'bob')).toBe(true)
    const out = read(p)
    expect(out).toContain('routing:')
    expect(out).toContain('    - bob')
  })

  it('case 5 — added routing block is valid YAML structure', () => {
    const p = write('c5c.yml', 'mode: cross-vendor\n')
    patchAllowedAuthors(p, 'alice')
    const out = read(p)
    // routing: must be a top-level key (no leading spaces)
    expect(out).toMatch(/^routing:/m)
    // allowed_authors must be indented under routing
    expect(out).toMatch(/^ {2}allowed_authors:/m)
    // entry must be indented under allowed_authors
    expect(out).toMatch(/^ {4}- alice/m)
  })

  // ── Already-populated: should not modify ────────────────────────────────

  it('returns false when allowed_authors already has entries', () => {
    const p = write('populated.yml', [
      'routing:',
      '  allowed_authors:',
      '    - existingbot',
      '',
    ].join('\n'))
    expect(patchAllowedAuthors(p, 'alice')).toBe(false)
    expect(read(p)).not.toContain('alice')
  })

  // ── Login value ──────────────────────────────────────────────────────────

  it('uses the provided login in the written entry', () => {
    const p = write('login.yml', 'mode: cross-vendor\n')
    patchAllowedAuthors(p, 'mybot')
    expect(read(p)).toContain('    - mybot')
  })
})

describe('resolveConfigPath discovery order', () => {
  // Home is searched first so init/loadConfig never targets a sample file that a
  // repo happens to ship in cwd. See issue #95.

  let cwdDir: string
  let homeDir: string
  let originalCwd: string
  let originalHome: string | undefined

  beforeEach(() => {
    // realpathSync resolves /var/... → /private/var/... on macOS so paths returned
    // by resolveConfigPath (which goes through process.cwd()) compare equal.
    cwdDir = realpathSync(mkdtempSync(join(tmpdir(), 'crosscheck-cwd-')))
    homeDir = realpathSync(mkdtempSync(join(tmpdir(), 'crosscheck-home-')))
    mkdirSync(join(homeDir, '.crosscheck'), { recursive: true })
    originalCwd = process.cwd()
    originalHome = process.env.HOME
    process.chdir(cwdDir)
    process.env.HOME = homeDir
  })

  afterEach(() => {
    process.chdir(originalCwd)
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    rmSync(cwdDir, { recursive: true, force: true })
    rmSync(homeDir, { recursive: true, force: true })
  })

  it('prefers ~/.crosscheck/config.yml when both home and cwd configs exist', () => {
    writeFileSync(join(cwdDir, 'crosscheck.config.yml'), 'mode: cross-vendor\n')
    writeFileSync(join(homeDir, '.crosscheck', 'config.yml'), 'mode: cross-vendor\n')
    expect(resolveConfigPath()).toBe(join(homeDir, '.crosscheck', 'config.yml'))
  })

  it('falls back to cwd/crosscheck.config.yml when home config is absent', () => {
    writeFileSync(join(cwdDir, 'crosscheck.config.yml'), 'mode: cross-vendor\n')
    expect(resolveConfigPath()).toBe(join(cwdDir, 'crosscheck.config.yml'))
  })

  it('falls back to cwd/.crosscheck.yml when neither home nor crosscheck.config.yml exist', () => {
    writeFileSync(join(cwdDir, '.crosscheck.yml'), 'mode: cross-vendor\n')
    expect(resolveConfigPath()).toBe(join(cwdDir, '.crosscheck.yml'))
  })

  it('returns null when no config exists anywhere', () => {
    expect(resolveConfigPath()).toBeNull()
  })

  it('honors explicit path regardless of discovery order', () => {
    writeFileSync(join(homeDir, '.crosscheck', 'config.yml'), 'mode: cross-vendor\n')
    const explicit = join(cwdDir, 'custom.yml')
    expect(resolveConfigPath(explicit)).toBe(explicit)
  })
})
