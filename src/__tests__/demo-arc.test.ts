import { describe, it, expect } from 'vitest'
import { readFileSync, existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

// The demo's whole claim is that what it shows happened. These guard the two ways
// that claim rots silently: arc.json drifting away from a real captured run, and a
// scene file the replay reads going missing so a beat renders empty.
//
// `npm run demo:play -- --fast` in CI covers the rendering; this covers the data.

const demoDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'demo')

interface Arc {
  capturedFrom: { repo: string; pr: number; url: string }
  capturedAt: string
  pr: { title: string; branch: string }
  steps: { atMs: number; event: string; verdict?: string }[]
  comments: { id: number; kind: string; verdict?: string; body: string }[]
}

function arc(): Arc {
  return JSON.parse(readFileSync(join(demoDir, 'arc.json'), 'utf8')) as Arc
}

describe('demo/arc.json', () => {
  it('names the public run it was captured from', () => {
    const a = arc()
    // The provenance note in demo/README.md and the README caption both promise a
    // checkable source. A capture that lost it makes both of them lies.
    expect(a.capturedFrom.repo).toBe('humanbased-ai/crosscheck-proof-fixture')
    expect(a.capturedFrom.url).toBe(`https://github.com/${a.capturedFrom.repo}/pull/${a.capturedFrom.pr}`)
    expect(a.capturedAt).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('carries the beats the replay narrates', () => {
    const a = arc()
    expect(a.steps.some(s => s.event === 'review_complete')).toBe(true)
    expect(a.steps.some(s => s.event === 'fix_complete')).toBe(true)
    // A demo with no blocking finding has no story; this is the beat everything
    // else hangs off.
    expect(a.comments.some(c => c.verdict === 'BLOCK')).toBe(true)
  })

  it('keeps step timings monotonic, so the replay never waits backwards', () => {
    const times = arc().steps.map(s => s.atMs)
    expect(times).toEqual([...times].sort((x, y) => x - y))
    expect(times[0]).toBeGreaterThanOrEqual(0)
  })

  it('carries a real review body for every verdict it claims', () => {
    for (const c of arc().comments.filter(x => x.verdict !== undefined)) {
      // Verbatim bodies only — a placeholder here would put words in the
      // reviewer's mouth on camera.
      expect(c.body).toMatch(/Code Review by|Recheck by/)
      expect(c.body.length).toBeGreaterThan(200)
      expect(c.id).toBeGreaterThan(0)
    }
  })

  it('has the Critical Issues section the replay quotes from', () => {
    const blocking = arc().comments.find(c => c.verdict === 'BLOCK')
    expect(blocking?.body).toContain('## Critical Issues')
  })
})

describe('demo/scenes', () => {
  // Kept in step with the scene() calls in replay.ts. A missing file throws at
  // record time, which is a bad moment to find out.
  it.each(['01-diff.txt', '02-tests-pass.txt', '02-tests-pass-short.txt'])('%s exists and is not empty', name => {
    const path = join(demoDir, 'scenes', name)
    expect(existsSync(path)).toBe(true)
    expect(readFileSync(path, 'utf8').trim().length).toBeGreaterThan(0)
  })

  it('the diff scene still shows the ownership filter being removed', () => {
    // This single removed line is the defect the whole demo is about. If a
    // re-capture loses it, the recording no longer demonstrates anything.
    // The capture keeps git's colour codes, so the leading `-` is preceded by an
    // ANSI escape rather than sitting at the start of the line.
    // eslint-disable-next-line no-control-regex -- matching the ESC byte is the point
    const diff = readFileSync(join(demoDir, 'scenes', '01-diff.txt'), 'utf8').replace(/\x1B\[[0-9;]*m/g, '')
    expect(diff).toMatch(/^-\s+ownerId/m)
  })

  it('the passing-test scene shows a green suite', () => {
    const tests = readFileSync(join(demoDir, 'scenes', '02-tests-pass.txt'), 'utf8')
    expect(tests).toMatch(/Tests\s+2 passed/)
    expect(tests).not.toMatch(/failed/)
  })
})
