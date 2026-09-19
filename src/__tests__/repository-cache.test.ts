import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync, readdirSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { cloneFromCache } from '../lib/repository-cache.js'

let root: string
let source: string
function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: 'pipe' }).trim()
}
function clone(destination: string, prNumber = 1) {
  return cloneFromCache({ source, repository: 'team/repo', prNumber, destination, root: join(root, 'cache') })
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'repository-cache-test-')); source = join(root, 'origin'); mkdirSync(source)
  git(source, 'init', '-q'); git(source, 'config', 'user.name', 'Test Reviewer'); git(source, 'config', 'user.email', 'reviewer@example.test')
  writeFileSync(join(source, 'file.txt'), 'first'); git(source, 'add', '.'); git(source, 'commit', '-qm', 'Initial')
  git(source, 'update-ref', 'refs/pull/1/head', 'HEAD'); git(source, 'update-ref', 'refs/pull/2/head', 'HEAD')
})
afterEach(() => rmSync(root, { recursive: true, force: true }))
describe('repository cache', () => {
  it('refreshes PR heads and creates independent checkouts that survive cache deletion', async () => {
    const first = join(root, 'first'); await clone(first)
    writeFileSync(join(source, 'file.txt'), 'second'); git(source, 'commit', '-am', 'Update'); git(source, 'update-ref', 'refs/pull/1/head', 'HEAD')
    const second = join(root, 'second'); await clone(second)
    expect(readFileSync(join(first, 'file.txt'), 'utf8')).toBe('first')
    expect(readFileSync(join(second, 'file.txt'), 'utf8')).toBe('second')
    expect(existsSync(join(second, '.git/objects/info/alternates'))).toBe(false)
    const cacheRepo = readdirSync(join(root, 'cache')).find(n => n.endsWith('.git'))!
    expect(readFileSync(join(root, 'cache', cacheRepo, 'config'), 'utf8')).not.toContain(source)
    rmSync(join(root, 'cache'), { recursive: true, force: true })
    expect(git(second, 'show', 'HEAD:file.txt')).toBe('second'); git(first, 'fsck', '--full')
  })
  it('serializes concurrent checkouts and releases the cache lock on fetch failure', async () => {
    await Promise.all([clone(join(root, 'one')), clone(join(root, 'two'), 2)])
    await expect(clone(join(root, 'bad'), 99)).rejects.toThrow()
    expect(readdirSync(join(root, 'cache')).some(n => n.endsWith('.lock'))).toBe(false)
    await clone(join(root, 'three'))
  })
})
