import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { configFingerprint, watchConfigDrift } from '../lib/config-drift.js'

const CHECK_MS = 1_000

describe('watchConfigDrift', () => {
  let dir: string
  let path: string
  let transitions: boolean[]
  let stop: () => void

  const startWatching = (resolvePath: () => string | null = () => path): void => {
    stop = watchConfigDrift({
      loaded: configFingerprint(resolvePath()),
      resolvePath,
      onChange: drifted => transitions.push(drifted),
      intervalMs: CHECK_MS,
    })
  }

  beforeEach(() => {
    vi.useFakeTimers()
    dir = mkdtempSync(join(tmpdir(), 'crosscheck-config-drift-'))
    path = join(dir, 'config.yml')
    writeFileSync(path, 'mode: cross-vendor\n')
    transitions = []
    stop = () => {}
  })

  afterEach(() => {
    stop()
    vi.useRealTimers()
    rmSync(dir, { force: true, recursive: true })
  })

  it('reports an edit made after the session loaded the file, once', () => {
    startWatching()

    vi.advanceTimersByTime(CHECK_MS)
    expect(transitions).toEqual([])

    writeFileSync(path, 'mode: single-vendor\n')
    vi.advanceTimersByTime(CHECK_MS * 5)

    expect(transitions).toEqual([true])
  })

  it('clears the report when the edit is reverted', () => {
    startWatching()

    writeFileSync(path, 'mode: single-vendor\n')
    vi.advanceTimersByTime(CHECK_MS)
    writeFileSync(path, 'mode: cross-vendor\n')
    vi.advanceTimersByTime(CHECK_MS)

    expect(transitions).toEqual([true, false])
  })

  it('ignores a touch that leaves the contents alone', () => {
    startWatching()

    const later = new Date(Date.now() + 60_000)
    utimesSync(path, later, later)
    vi.advanceTimersByTime(CHECK_MS)

    expect(transitions).toEqual([])
  })

  it('reports a config file that was deleted', () => {
    startWatching()

    rmSync(path)
    vi.advanceTimersByTime(CHECK_MS)

    expect(transitions).toEqual([true])
  })

  it('reports a config file created after a session that started on defaults', () => {
    const late = join(dir, 'created-later.yml')
    let resolved: string | null = null
    startWatching(() => resolved)

    writeFileSync(late, 'mode: single-vendor\n')
    resolved = late
    vi.advanceTimersByTime(CHECK_MS)

    expect(transitions).toEqual([true])
  })

  it('stops checking once stopped', () => {
    startWatching()
    stop()

    writeFileSync(path, 'mode: single-vendor\n')
    vi.advanceTimersByTime(CHECK_MS * 5)

    expect(transitions).toEqual([])
  })
})
