import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { probeOpenCodeCli, parseOpenCodeRunHelp } from '../reviewers/opencode.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const v2Help = [
  'opencode run [message..]',
  '',
  'Options:',
  '      --standalone  run a private server instead of the shared one  [boolean]',
  '      --auto        auto-approve permissions  [boolean]',
].join('\n')

const v1Help = [
  'opencode run [message..]',
  '',
  'Options:',
  '      --format  format: default (formatted) or json (raw JSON events)  [string]',
  '      --attach  attach to a running opencode server  [string]',
  '      --port    port for the local server (defaults to random port)  [number]',
  '      --auto    auto-approve permissions  [boolean]',
].join('\n')

function probeResult(stdout: string, stderr = '', exitCode = 0) {
  return { stdout, stderr, exitCode } as Awaited<ReturnType<typeof execa>>
}

// The probe runs `run --help` and `--version` side by side, so answer by argv
// rather than by call order.
function mockCli(help: Awaited<ReturnType<typeof execa>>, version = '9.9.9') {
  vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) =>
    Promise.resolve(args?.[0] === '--version' ? probeResult(version) : help)) as unknown as typeof execa)
}

beforeEach(() => vi.resetAllMocks())

describe('parseOpenCodeRunHelp', () => {
  it('detects --standalone when the CLI lists it', () => {
    expect(parseOpenCodeRunHelp(v2Help).supportsStandalone).toBe(true)
  })

  it('returns false for a v1 help listing without the flag', () => {
    expect(parseOpenCodeRunHelp(v1Help).supportsStandalone).toBe(false)
  })

  it('ignores ANSI styling around the flag', () => {
    expect(parseOpenCodeRunHelp('\x1b[32m--standalone\x1b[39m  private server').supportsStandalone).toBe(true)
  })

  it('does not mistake a longer flag for --auto', () => {
    expect(parseOpenCodeRunHelp('  --auto-approve  something  [boolean]').supportsAuto).toBe(false)
  })
})

describe('probeOpenCodeCli', () => {
  it('reads support from stdout or stderr for the current CLI', async () => {
    vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) =>
      Promise.resolve(args?.[0] === '--version' ? probeResult('1.0.0') : probeResult('', v1Help))) as unknown as typeof execa)
    expect(await probeOpenCodeCli()).toMatchObject({ supportsStandalone: false, policyFormat: 'v1', version: '1.0.0' })
    mockCli(probeResult(v2Help))
    expect(await probeOpenCodeCli()).toMatchObject({ supportsStandalone: true, policyFormat: 'v2' })
  })

  it('fails closed when the probe cannot run', async () => {
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('timed out'), { timedOut: true }))
    await expect(probeOpenCodeCli()).rejects.toThrow(/refusing to run without session isolation/)
  })

  it('fails closed on empty or unrecognisable help output', async () => {
    mockCli(probeResult(''))
    await expect(probeOpenCodeCli()).rejects.toThrow(/could not read 'opencode run --help'/)
    mockCli(probeResult('something went wrong'))
    await expect(probeOpenCodeCli()).rejects.toThrow(/could not read 'opencode run --help'/)
  })

  it('fails closed when the probe exits non-zero', async () => {
    mockCli(probeResult(v1Help, '', 1))
    await expect(probeOpenCodeCli()).rejects.toThrow(/exit 1/)
  })

  it('fails closed for help that does not match the known v1 shape', async () => {
    mockCli(probeResult('opencode run [message..]\n\nOptions:\n  --format  json  [string]'))
    await expect(probeOpenCodeCli()).rejects.toThrow(/refusing to run without session isolation/)
  })

  it('re-probes instead of caching a previous CLI answer', async () => {
    mockCli(probeResult('', v1Help))
    expect((await probeOpenCodeCli()).supportsStandalone).toBe(false)
    mockCli(probeResult(v2Help))
    expect((await probeOpenCodeCli()).supportsStandalone).toBe(true)
  })

  it('still probes when --version is unavailable', async () => {
    vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) =>
      args?.[0] === '--version' ? Promise.reject(new Error('boom')) : Promise.resolve(probeResult(v1Help))) as unknown as typeof execa)
    const info = await probeOpenCodeCli()
    expect(info.version).toBeUndefined()
    expect(info.supportsAuto).toBe(true)
  })
})
