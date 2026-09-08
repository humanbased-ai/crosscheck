// Plays demo/arc.json as a scripted 90-second run.
//
// The pipeline view is rendered by `PRBoard` from src/lib/board.ts — the same class
// `crosscheck watch` drives in production — so the UI in the recording is the
// product's own, not a mock of it. The content comes from arc.json, captured from a
// real run against a public fixture PR.
//
// Offline and deterministic: no network, no API tokens, no vendor calls. The only
// thing invented is the clock, which is compressed so the recording is 90 seconds
// rather than the several minutes the real run took. See demo/README.md.
//
//   npm run demo:play          # play it in your terminal
//   npm run demo:play -- --fast   # no waits, for checking the script renders

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import chalk from 'chalk'
import { PRBoard } from '../src/lib/board.js'
import type { Config } from '../src/config/schema.js'
import type { WorkflowStep } from '../src/lib/workflow.js'
import type { Arc } from './capture.js'

const FAST = process.argv.includes('--fast')
// The GIF in the README first viewport has to loop in a few seconds and stay small
// enough to load, so it plays a condensed cut: the setup, the finding, and the
// closing verdict. The full cut — every round, including the one that caught the
// first repair's own regression — is the 90-second mp4.
const SHORT = process.argv.includes('--short')

// Total screen time, and how the captured run's elapsed shape is squeezed into it.
// The real run took ~150s of vendor time; the beats keep their relative order and
// rough proportions, but each pause is capped so no single step stalls the video.
const SCENE_PAUSE_MS = FAST ? 0 : SHORT ? 900 : 1_600
const TYPE_DELAY_MS = FAST ? 0 : SHORT ? 16 : 28
const STEP_MAX_MS = FAST ? 0 : SHORT ? 900 : 2_400

const sleep = (ms: number): Promise<void> => new Promise(resolve => setTimeout(resolve, ms))

function loadArc(): Arc {
  return JSON.parse(readFileSync(join(import.meta.dirname, 'arc.json'), 'utf8')) as Arc
}

function scene(name: string): string {
  return readFileSync(join(import.meta.dirname, 'scenes', name), 'utf8').replace(/\n+$/, '')
}

// Renders a shell prompt and the command "typed" into it, so the recording reads as
// somebody at a terminal rather than a wall of pre-printed output.
async function prompt(command: string): Promise<void> {
  process.stdout.write(chalk.cyan('❯ '))
  for (const ch of command) {
    process.stdout.write(ch)
    if (TYPE_DELAY_MS) await sleep(TYPE_DELAY_MS)
  }
  process.stdout.write('\n')
  await sleep(SCENE_PAUSE_MS / 2)
}

function say(text: string): void {
  console.log(`\n${chalk.dim('# ')}${chalk.bold(text)}\n`)
}

// The review body is long; the recording shows the part that carries the finding.
function findingLines(body: string, max = 6): string[] {
  const start = body.indexOf('## Critical Issues')
  if (start === -1) return []
  const rest = body.slice(start)
  const end = rest.indexOf('\n## ', 4)
  return (end === -1 ? rest : rest.slice(0, end))
    .split('\n')
    .filter(l => l.trim() !== '')
    .slice(0, max)
}

function verdictBadge(verdict?: string): string {
  if (verdict === 'APPROVE') return chalk.green('✅ APPROVE')
  if (verdict === 'BLOCK') return chalk.red('🚫 BLOCK')
  if (verdict === 'NEEDS WORK') return chalk.yellow('⚠  NEEDS WORK')
  return chalk.dim('—')
}

const boardConfig = {
  mode: 'crosscheck',
  quality: { tier: 'fast' },
  vendors: { claude: { enabled: true }, codex: { enabled: true } },
  display: {
    theme: {
      bar_fill: 'blue', bar_empty: 'dim',
      cr_approve: 'green', cr_needs_work: 'yellow', cr_block: 'red',
      fix_fill: 'cyan',
    },
  },
} as unknown as Config

const boardSteps: WorkflowStep[] = [
  { type: 'review', name: 'review', reviewer: 'auto', max_rounds: 1 },
  { type: 'fix', name: 'fix', reviewer: 'origin', max_rounds: 1 },
  { type: 'recheck', name: 'recheck', reviewer: 'auto', max_rounds: 1 },
]

async function main(): Promise<void> {
  const arc = loadArc()
  const key = `${arc.capturedFrom.repo}#${arc.capturedFrom.pr}`

  // ── Beat 1: an agent-written PR that looks finished ──────────────────────
  say('An agent opened a PR. It adds pagination, and it looks complete.')
  await prompt('git show --stat HEAD')
  console.log(scene('01-diff.txt'))
  await sleep(SCENE_PAUSE_MS * 2)

  // ── Beat 2: CI is green — this is why review matters ─────────────────────
  say('The test suite passes. Nothing here fails CI.')
  await prompt('npm test')
  console.log(scene(SHORT ? '02-tests-pass-short.txt' : '02-tests-pass.txt'))
  await sleep(SCENE_PAUSE_MS * 2)

  // ── Beat 3: crosscheck runs, rendered by the real board ──────────────────
  say('A different agent reviews it.')
  await prompt(`ck run ${arc.capturedFrom.url}`)

  const board = new PRBoard()
  board.setConfig(boardConfig, boardSteps)
  board.start()
  board.addPR(key, arc.capturedFrom.pr, arc.capturedFrom.repo, arc.pr.branch)

  let shown = 0
  for (const step of arc.steps) {
    const wait = Math.min(step.atMs - shown, STEP_MAX_MS)
    shown = step.atMs
    if (wait > 0) await sleep(wait)

    if (step.event === 'review_started' && step.stepType === 'review') {
      board.updatePR(key, { phase: 'reviewing', label: 'codex reviewing...' })
    } else if (step.event === 'review_complete' && step.stepType === 'review') {
      board.updatePR(key, {
        phase: 'reviewed',
        verdict: step.verdict ?? null,
        ...(step.tokensUsed !== undefined && { crTokens: step.tokensUsed }),
        ...(step.vendor !== undefined && { crReviewer: step.vendor }),
      })
    } else if (step.event === 'fix_complete') {
      board.updatePR(key, {
        phase: 'fixed',
        ...(step.appliedCount !== undefined && { fixCount: step.appliedCount }),
        ...(step.tokensUsed !== undefined && { fixTokens: step.tokensUsed }),
      })
    } else if (step.event === 'review_complete' && step.stepType === 'recheck') {
      board.updatePR(key, {
        phase: 'rechecked',
        recheckVerdict: step.verdict ?? null,
        ...(step.tokensUsed !== undefined && { recheckTokens: step.tokensUsed }),
      })
    }
  }

  const totalMs = arc.steps.length > 0 ? arc.steps[arc.steps.length - 1].atMs : 0
  board.completePR(key, { elapsedMs: totalMs, url: arc.capturedFrom.url })
  board.stop()
  await sleep(SCENE_PAUSE_MS)

  // ── Beats 4+: walk the real rounds ───────────────────────────────────────
  //
  // Narrated round by round rather than as one clean BLOCK → fix → APPROVE,
  // because that is not what happened: the first repair restored the ownership
  // filter and left a test asserting the old query shape, and the next review
  // caught it. Compressing that away would be the more flattering cut and the
  // less true one — and the fact that the loop catches a regression introduced
  // by its own fix step is the strongest thing the demo has to show.
  const verdicts = arc.comments.filter(c => c.verdict !== undefined)
  const fixes = arc.steps.filter(s => s.event === 'fix_complete')

  // The short cut keeps only the first finding and the closing verdict; the full
  // cut walks every round.
  const narrated = SHORT
    ? verdicts.filter((c, i) => i === 0 || c.verdict === 'APPROVE')
    : verdicts

  for (const [i, judgement] of narrated.entries()) {
    const first = i === 0
    const approved = judgement.verdict === 'APPROVE'

    if (approved) {
      // The short cut drops the intermediate rounds, so it has to say that it did.
      // Showing one repair followed by APPROVE when it actually took three is the
      // flattering edit this file's own header warns against, and the GIF is the
      // cut most people will ever see.
      const rounds = verdicts.filter(v => v.verdict !== 'APPROVE').length
      const elided = SHORT && rounds > 1
      say(elided
        ? `Judged again — and again. It took ${rounds} rounds to hold.`
        : rounds > 1 ? 'Judged again. This time it holds.' : 'Judged again, against the repair.')
      console.log(`  ${verdictBadge(judgement.verdict)}${elided ? chalk.dim(`   (rounds 2-${rounds} not shown — full run linked below)`) : ''}\n`)
      await sleep(SCENE_PAUSE_MS * 2)
      break
    }

    say(first
      ? 'It found what the tests could not.'
      : 'And it checked the repair, not just the original finding.')
    console.log(`  ${verdictBadge(judgement.verdict)}  ${chalk.dim(`round ${i + 1}`)}\n`)
    for (const line of findingLines(judgement.body, SHORT ? 3 : 6)) console.log(`  ${line}`)
    await sleep(SCENE_PAUSE_MS * 3)

    const repair = fixes[i]
    if (repair) {
      say(first ? 'The author agent repaired it.' : 'Repaired again.')
      const n = repair.appliedCount ?? 0
      console.log(`  ${chalk.cyan('🔧')} ${n} change${n === 1 ? '' : 's'} applied  ${chalk.dim(repair.sha ? repair.sha.slice(0, 9) : '')}`)
      await sleep(SCENE_PAUSE_MS * 2)
    }
  }

  // If the captured run never reached APPROVE, say so rather than letting the
  // recording trail off after the last finding. A demo that quietly stops at the
  // most flattering frame is the thing this whole project exists to catch.
  if (!verdicts.some(v => v.verdict === 'APPROVE')) {
    const last = verdicts.at(-1)
    say('The defect is gone. The reviewer is still asking for more.')
    console.log(`  ${verdictBadge(last?.verdict)}  ${chalk.dim('— the loop is bounded by policy, not by agreement')}\n`)
    await sleep(SCENE_PAUSE_MS * 2)
  }

  console.log(chalk.dim(`\n  the run above is real and public: ${arc.capturedFrom.url}\n`))
  console.log(chalk.bold('  npm install -g @humanbased/crosscheck\n'))
}

await main()
