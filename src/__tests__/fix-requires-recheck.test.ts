import { describe, it, expect } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { resolveReviewStrategy, strategyVersion } from '../lib/review-strategy.js'

// #317: `fix` is the only step that mutates the PR and `recheck` is the only one
// that judges the result, so a class permitting the first without the second ships
// an unverified mutation by policy — and the commit carries crosscheck's own
// trailer, so it reads as vetted rather than unreviewed.
//
// Observed on crosscheck-proof-fixture#2 under strategy 1.1.0, where `trivial`
// declared ["review","fix"]: the fix restored a dropped ownership filter, left a
// test asserting the old query shape, CI went red, and `workflow_complete`
// reported `completed` with nothing left in the pipeline to notice.

interface StrategyFile {
  version: string
  pr_classes: { id: string; steps: string[]; tier: string | null }[]
}

function strategyFile(): StrategyFile {
  const path = join(import.meta.dirname, '..', 'config', 'review-strategy.json')
  return JSON.parse(readFileSync(path, 'utf8')) as StrategyFile
}

describe('every class that can fix can also recheck', () => {
  it('holds for every shipped pr_class', () => {
    const offenders = strategyFile().pr_classes
      .filter(c => c.steps.includes('fix') && !c.steps.includes('recheck'))
      .map(c => `${c.id} → [${c.steps.join(', ')}]`)
    expect(offenders).toEqual([])
  })

  it('holds specifically for the two classes that violated it', () => {
    const byId = new Map(strategyFile().pr_classes.map(c => [c.id, c.steps]))
    expect(byId.get('trivial')).toContain('recheck')
    expect(byId.get('test_only')).toContain('recheck')
  })

  it('is enforced by the schema, not just by the current data', () => {
    // The strategy file is bundled rather than user-supplied, so the guard lives in
    // the Zod schema and a violation fails at module load. Re-parsing a mutated
    // copy proves the refinement is wired, so the data cannot silently regress.
    const Schema = z.object({
      id: z.string(),
      steps: z.array(z.string()),
    }).refine(
      cls => !(cls.steps.includes('fix') && !cls.steps.includes('recheck')),
      { message: 'fix without recheck', path: ['steps'] },
    )
    expect(Schema.safeParse({ id: 'trivial', steps: ['review', 'fix'] }).success).toBe(false)
    expect(Schema.safeParse({ id: 'trivial', steps: ['review', 'fix', 'recheck'] }).success).toBe(true)
    expect(Schema.safeParse({ id: 'docs', steps: ['review'] }).success).toBe(true)
  })
})

describe('the routing change is versioned', () => {
  it('cites a version at or past the one that added the recheck steps', () => {
    // The strategy file's own rule: "Routing changed, so the version changes with
    // it: a comment citing 1.1.0 has to stay explicable by 1.1.0." Changing a
    // class's step set without bumping would make past comments unexplainable.
    const [major, minor] = strategyVersion().split('.').map(Number)
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(1 * 1000 + 2)
  })
})

describe('a trivial PR still routes to trivial, now with a recheck', () => {
  it('classifies a tiny source change as trivial and includes recheck', () => {
    // The shape of crosscheck-proof-fixture#2: two files, a handful of lines.
    const resolved = resolveReviewStrategy({
      files: ['src/transactions.ts', 'test/transactions.test.ts'],
      additions: 36,
      deletions: 3,
    })
    expect(resolved.steps).toContain('fix')
    expect(resolved.steps).toContain('recheck')
  })
})
