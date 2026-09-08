// Builds demo/arc.json from a real crosscheck run.
//
// Two sources, both authoritative and neither hand-written:
//   - the run's NDJSON in ~/.crosscheck/logs, for step timings and verdicts
//   - the PR's own comments via the GitHub API, for the review text verbatim
//
// Run this only when the fixture run changes. arc.json is committed so the
// replay and the recording work from a clean checkout with no credentials.
//
//   npm run demo:capture
//
// Everything it writes is a record of something that happened. If a beat needs to
// read better, change the fixture and re-capture — editing arc.json by hand makes
// demo/README.md's provenance note false.

import { readFileSync, writeFileSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { execFileSync } from 'node:child_process'

const REPO = 'humanbased-ai/crosscheck-proof-fixture'
const PR = 2

interface LogLine {
  ts: string
  event: string
  repo?: string
  pr?: number
  step_type?: string
  verdict?: string
  applied_count?: number
  tokens_used?: number
  duration_ms?: number
  sha?: string
  vendor?: string
  model?: string
  reviewer?: string
  files_changed?: number
  insertions?: number
  deletions?: number
  pr_class?: string
  tier?: string
  applied?: string[]
  configured?: string[]
  reason?: string
}

export interface ArcStep {
  /** Milliseconds from the first event of the run — the real elapsed shape. */
  atMs: number
  event: string
  stepType?: string
  verdict?: string
  appliedCount?: number
  tokensUsed?: number
  durationMs?: number
  vendor?: string
  model?: string
  sha?: string
  reason?: string
}

export interface Arc {
  capturedFrom: { repo: string; pr: number; url: string }
  /** ISO date of the capture, so a stale arc is obvious. */
  capturedAt: string
  pr: { title: string; branch: string; filesChanged?: number; insertions?: number; deletions?: number }
  strategy?: { prClass?: string; tier?: string; configured?: string[]; applied?: string[] }
  steps: ArcStep[]
  comments: { id: number; kind: string; verdict?: string; body: string }[]
}

function logDir(): string {
  return join(homedir(), '.crosscheck', 'logs')
}

// A long-running `watch` pins its log file at startup, so this run's events can sit
// in a file named for an earlier date. Scan every log rather than guessing today's.
function readRunLines(): LogLine[] {
  const dir = logDir()
  const out: LogLine[] = []
  for (const name of readdirSync(dir).filter(f => f.endsWith('.ndjson'))) {
    for (const raw of readFileSync(join(dir, name), 'utf8').split('\n')) {
      if (!raw.trim()) continue
      let line: LogLine
      try { line = JSON.parse(raw) as LogLine } catch { continue }
      if (line.repo === REPO && line.pr === PR) out.push(line)
    }
  }
  return out.sort((a, b) => a.ts.localeCompare(b.ts))
}

const KEPT_EVENTS = new Set([
  'review_started', 'review_complete', 'comment_posted', 'blocking_finding_posted',
  'fix_complete', 'fix_noop', 'step_skipped', 'workflow_complete',
])

function gh<T>(path: string): T {
  const raw = execFileSync('gh', ['api', path], { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 })
  return JSON.parse(raw) as T
}

function classifyComment(body: string): { kind: string; verdict?: string } {
  const verdict = /🚫\s*\*\*BLOCK\*\*/.test(body) ? 'BLOCK'
    : /⚠️\s*\*\*NEEDS WORK\*\*/.test(body) ? 'NEEDS WORK'
    : /✅\s*\*\*APPROVE\*\*/.test(body) ? 'APPROVE'
    : undefined
  const kind = body.startsWith('> Recheck of') || /### Recheck by/.test(body) ? 'recheck'
    : /### Code Review by/.test(body) ? 'review'
    : /### ✅ Auto-fix applied/.test(body) ? 'fix'
    : 'other'
  return verdict === undefined ? { kind } : { kind, verdict }
}

function main(): void {
  const lines = readRunLines()
  if (lines.length === 0) {
    throw new Error(`no log lines found for ${REPO}#${PR} in ${logDir()} — run the fixture PR through crosscheck first`)
  }

  const t0 = Date.parse(lines[0].ts)
  const steps: ArcStep[] = lines
    .filter(l => KEPT_EVENTS.has(l.event))
    .map(l => ({
      atMs: Date.parse(l.ts) - t0,
      event: l.event,
      ...(l.step_type !== undefined && { stepType: l.step_type }),
      ...(l.verdict !== undefined && { verdict: l.verdict }),
      ...(l.applied_count !== undefined && { appliedCount: l.applied_count }),
      ...(l.tokens_used !== undefined && { tokensUsed: l.tokens_used }),
      ...(l.duration_ms !== undefined && { durationMs: l.duration_ms }),
      ...(l.vendor !== undefined && { vendor: l.vendor }),
      ...(l.model !== undefined && { model: l.model }),
      ...(l.reviewer !== undefined && !l.vendor && { vendor: l.reviewer }),
      ...(l.sha !== undefined && { sha: l.sha }),
      ...(l.reason !== undefined && { reason: l.reason }),
    }))

  const complexity = lines.find(l => l.event === 'pr_complexity')
  const narrowed = lines.find(l => l.event === 'strategy_steps_narrowed')
  const resolved = lines.find(l => l.event === 'strategy_resolved')

  const pr = gh<{ title: string; head: { ref: string } }>(`repos/${REPO}/pulls/${PR}`)
  const rawComments = gh<{ id: number; body: string }[]>(`repos/${REPO}/issues/${PR}/comments`)

  const arc: Arc = {
    capturedFrom: { repo: REPO, pr: PR, url: `https://github.com/${REPO}/pull/${PR}` },
    capturedAt: new Date().toISOString().slice(0, 10),
    pr: {
      title: pr.title,
      branch: pr.head.ref,
      ...(complexity?.files_changed !== undefined && { filesChanged: complexity.files_changed }),
      ...(complexity?.insertions !== undefined && { insertions: complexity.insertions }),
      ...(complexity?.deletions !== undefined && { deletions: complexity.deletions }),
    },
    ...((narrowed ?? resolved) && {
      strategy: {
        ...(resolved?.pr_class !== undefined && { prClass: resolved.pr_class }),
        ...(resolved?.tier !== undefined && { tier: resolved.tier }),
        ...(narrowed?.configured !== undefined && { configured: narrowed.configured }),
        ...(narrowed?.applied !== undefined && { applied: narrowed.applied }),
      },
    }),
    steps,
    comments: rawComments.map(c => ({ id: c.id, ...classifyComment(c.body), body: c.body })),
  }

  const out = join(import.meta.dirname, 'arc.json')
  writeFileSync(out, `${JSON.stringify(arc, null, 2)}\n`)
  console.log(`captured ${steps.length} steps and ${arc.comments.length} comments -> ${out}`)
  for (const c of arc.comments) console.log(`  ${c.kind.padEnd(8)} ${c.verdict ?? '—'}  id=${c.id}`)
}

main()
