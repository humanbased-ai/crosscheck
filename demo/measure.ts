// Prints how long each cut of the replay actually takes.
//
// The vhs tapes end with a fixed `Sleep`, and vhs stops recording there: too short
// truncates the ending, too long pads the loop with idle frames. Neither is
// visible from reading the tape, so measure instead of estimating.
//
//   npm run demo:time
//
// Then set each tape's trailing `Sleep` to the printed figure plus a couple of
// seconds of headroom.

import { spawn } from 'node:child_process'
import { join } from 'node:path'

async function timeCut(label: string, args: string[]): Promise<number> {
  const started = Date.now()
  await new Promise<void>((resolve, reject) => {
    const child = spawn('npx', ['tsx', join(import.meta.dirname, 'replay.ts'), ...args], {
      stdio: 'ignore',
      env: { ...process.env, FORCE_COLOR: '1' },
    })
    child.on('error', reject)
    child.on('exit', code => code === 0 ? resolve() : reject(new Error(`${label} exited ${code}`)))
  })
  const seconds = (Date.now() - started) / 1000
  console.log(`${label.padEnd(6)} ${seconds.toFixed(1)}s  → set that tape's trailing Sleep to ${Math.ceil(seconds) + 2}s`)
  return seconds
}

// Sequential, not parallel: both cuts run real timers, and sharing the CPU would
// make the measurement report a number the recording never reproduces.
await timeCut('full', [])
await timeCut('short', ['--short'])
