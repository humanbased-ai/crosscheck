import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadHarnessSection } from '../lib/workflow.js'

// loadHarnessSection had no coverage, and its section matcher was built with
// `new RegExp(\`^## ${section}\s*$\`, 'm')` — a template literal, where `\s` is
// just `s`. The compiled pattern was `^## <section>s*$`: it failed on a heading
// with trailing whitespace (invisible in an editor, common in hand-written
// markdown) and matched any heading with extra trailing `s` characters. ESLint's
// no-useless-escape found it once the linter could actually run.
describe('loadHarnessSection', () => {
  let dir: string
  const write = (name: string, body: string): void => {
    const harnessDir = join(dir, 'harness')
    mkdirSync(harnessDir, { recursive: true })
    writeFileSync(join(harnessDir, name), body)
  }

  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'crosscheck-harness-')) })
  afterEach(() => { rmSync(dir, { force: true, recursive: true }) })

  it('extracts a section body', () => {
    write('h.md', '## Overview\nbody text\n\n## Other\nnot this\n')
    expect(loadHarnessSection('h.md#Overview', dir)).toBe('body text')
  })

  it('reads a heading that carries trailing whitespace', () => {
    write('h.md', '## Overview   \nbody text\n')
    expect(loadHarnessSection('h.md#Overview', dir)).toBe('body text')
  })

  it('does not match a heading that merely starts with the section name', () => {
    write('h.md', '## Overviewsss\nwrong section\n')
    expect(loadHarnessSection('h.md#Overview', dir)).toBeNull()
  })

  it('stops at the next section heading', () => {
    write('h.md', '## A\nfirst\n## B\nsecond\n')
    expect(loadHarnessSection('h.md#A', dir)).toBe('first')
  })

  it('returns null for a section that is not present', () => {
    write('h.md', '## Overview\nbody\n')
    expect(loadHarnessSection('h.md#Missing', dir)).toBeNull()
  })

  it('returns null for a malformed ref', () => {
    expect(loadHarnessSection('no-hash', dir)).toBeNull()
    expect(loadHarnessSection('#Section', dir)).toBeNull()
  })
})
