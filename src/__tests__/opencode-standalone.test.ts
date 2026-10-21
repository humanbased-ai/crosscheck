import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { opencodeSupportsStandalone, parseOpenCodeStandaloneSupport } from '../reviewers/opencode.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const v2Help = [
  'opencode run [message..]',
  '',
  'Options:',
  '      --standalone  run a private server instead of the shared one  [boolean]',
].join('\n')

const v1Help = [
  'opencode run [message..]',
  '',
  'Options:',
  '      --format  format: default (formatted) or json (raw JSON events)  [string]',
].join('\n')

function probeResult(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode } as Awaited<ReturnType<typeof execa>>
}

beforeEach(() => vi.resetAllMocks())

describe('parseOpenCodeStandaloneSupport', () => {
  it('detects the flag when the CLI lists it', () => {
    expect(parseOpenCodeStandaloneSupport(v2Help)).toBe(true)
  })

  it('returns false for a v1 help listing without the flag', () => {
    expect(parseOpenCodeStandaloneSupport(v1Help)).toBe(false)
  })

  it('ignores ANSI styling around the flag', () => {
    expect(parseOpenCodeStandaloneSupport('\x1b[32m--standalone\x1b[39m  private server')).toBe(true)
  })
})

describe('opencodeSupportsStandalone', () => {
  it('reads the flag from stdout or stderr for the current CLI', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(probeResult(v2Help))
      .mockResolvedValueOnce(probeResult('', v1Help))
    expect(await opencodeSupportsStandalone()).toBe(true)
    expect(await opencodeSupportsStandalone()).toBe(false)
  })

  it('fails closed when the probe cannot run', async () => {
    vi.mocked(execa).mockRejectedValueOnce(Object.assign(new Error('timed out'), { timedOut: true }))
    await expect(opencodeSupportsStandalone()).rejects.toThrow(/refusing to run without session isolation/)
  })

  it('fails closed on empty or unrecognisable help output', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(probeResult(''))
      .mockResolvedValueOnce(probeResult('something went wrong'))
    await expect(opencodeSupportsStandalone()).rejects.toThrow(/could not read 'opencode run --help'/)
    await expect(opencodeSupportsStandalone()).rejects.toThrow(/could not read 'opencode run --help'/)
  })

  it('fails closed when the probe exits non-zero', async () => {
    vi.mocked(execa).mockResolvedValueOnce(probeResult(v1Help, '', 1))
    await expect(opencodeSupportsStandalone()).rejects.toThrow(/exit 1/)
  })

  it('re-probes instead of caching a previous CLI answer', async () => {
    vi.mocked(execa)
      .mockResolvedValueOnce(probeResult('', v1Help))
      .mockResolvedValueOnce(probeResult(v2Help))
    expect(await opencodeSupportsStandalone()).toBe(false)
    expect(await opencodeSupportsStandalone()).toBe(true)
    expect(execa).toHaveBeenCalledTimes(2)
  })
})
