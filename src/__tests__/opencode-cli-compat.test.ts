import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import {
  isOpenCodeAuthFailure,
  isOpenCodeUsageOutput,
  opencodeRunBaseArgs,
  parseOpenCodeRunHelp,
  probeOpenCodeCli,
  requireOpenCodeRun,
  type OpenCodeCliInfo,
} from '../reviewers/opencode.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

// Captured from `opencode run --help` on real installs.
const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures-opencode')
const help1211 = readFileSync(join(FIXTURES_DIR, 'run-help-1.2.11.txt'), 'utf8')
const help1193 = readFileSync(join(FIXTURES_DIR, 'run-help-1.19.3.txt'), 'utf8')

const syntheticV2Help = [
  'opencode run [message..]',
  '',
  'Options:',
  '      --standalone  run a private server  [boolean]',
  '      --auto        auto-approve  [boolean]',
].join('\n')

function mockCli(help: string, version: string) {
  vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) =>
    Promise.resolve(
      args?.[0] === '--version'
        ? { stdout: version, stderr: '', exitCode: 0 }
        : { stdout: help, stderr: '', exitCode: 0 },
    )) as unknown as typeof execa)
}

beforeEach(() => vi.resetAllMocks())

describe('parseOpenCodeRunHelp on real help output', () => {
  it('1.2.11 has no --auto and uses the v1 policy shape', () => {
    expect(parseOpenCodeRunHelp(help1211)).toEqual({ supportsAuto: false, supportsStandalone: false, v1Shape: true })
  })

  it('1.19.3 supports --auto and still uses the v1 policy shape', () => {
    expect(parseOpenCodeRunHelp(help1193)).toEqual({ supportsAuto: true, supportsStandalone: false, v1Shape: true })
  })

  it('a help listing with --standalone is v2', () => {
    expect(parseOpenCodeRunHelp(syntheticV2Help)).toMatchObject({ supportsAuto: true, supportsStandalone: true })
  })
})

describe('probeOpenCodeCli', () => {
  it('maps 1.19.3 to v1 with --auto', async () => {
    mockCli(help1193, '1.19.3\n')
    expect(await probeOpenCodeCli()).toMatchObject({
      version: '1.19.3', supportsAuto: true, supportsStandalone: false, policyFormat: 'v1',
    })
  })

  it('maps a synthetic v2 listing to v2', async () => {
    mockCli(syntheticV2Help, '2.0.0')
    expect(await probeOpenCodeCli()).toMatchObject({ supportsStandalone: true, policyFormat: 'v2' })
  })
})

describe('opencodeRunBaseArgs / requireOpenCodeRun', () => {
  const base: OpenCodeCliInfo = { version: '1.19.3', supportsAuto: true, supportsStandalone: false, policyFormat: 'v1' }

  it('builds the headless args, adding --standalone only when supported', () => {
    expect(opencodeRunBaseArgs(base)).toEqual(['run', '--format', 'json', '--auto'])
    expect(opencodeRunBaseArgs({ ...base, supportsStandalone: true, policyFormat: 'v2' }))
      .toEqual(['run', '--format', 'json', '--auto', '--standalone'])
  })

  it('names the version and path when --auto is missing', () => {
    expect(() => opencodeRunBaseArgs({ ...base, version: '1.2.11', path: '/opt/homebrew/bin/opencode', supportsAuto: false }))
      .toThrow("opencode 1.2.11 at /opt/homebrew/bin/opencode does not support 'run --auto' — upgrade it, or a newer install is shadowed on PATH (check: which -a opencode)")
  })

  it('refuses a 1.2.11 CLI before any run starts', async () => {
    mockCli(help1211, '1.2.11')
    await expect(requireOpenCodeRun()).rejects.toThrow(/1\.2\.11.*does not support 'run --auto'/)
  })

  it('returns args and policy format for a usable CLI', async () => {
    mockCli(help1193, '1.19.3')
    expect(await requireOpenCodeRun()).toEqual({
      baseArgs: ['run', '--format', 'json', '--auto'],
      policyFormat: 'v1',
    })
  })
})

describe('isOpenCodeUsageOutput', () => {
  it('recognises the usage printed by both real CLIs', () => {
    expect(isOpenCodeUsageOutput(help1211)).toBe(true)
    expect(isOpenCodeUsageOutput(help1193)).toBe(true)
  })

  it('recognises styled usage and the sections without the header', () => {
    expect(isOpenCodeUsageOutput('\x1b[1mopencode run [message..]\x1b[22m\n')).toBe(true)
    expect(isOpenCodeUsageOutput('Positionals:\n  message\n\nOptions:\n  -h, --help')).toBe(true)
  })

  it('is false for an ordinary error', () => {
    expect(isOpenCodeUsageOutput('{"type":"error","error":{"name":"APIError","message":"rate limited"}}')).toBe(false)
    expect(isOpenCodeUsageOutput('Error: model not found')).toBe(false)
    expect(isOpenCodeUsageOutput('')).toBe(false)
  })
})

describe('isOpenCodeAuthFailure', () => {
  it('does not treat usage text ("basic auth password") as an auth failure', () => {
    expect(help1193).toMatch(/auth/)
    expect(isOpenCodeAuthFailure(help1193, 'Command failed with exit code 1')).toBe(false)
    expect(isOpenCodeAuthFailure(help1211, help1211)).toBe(false)
  })

  it('matches real credential problems on stderr', () => {
    expect(isOpenCodeAuthFailure('Error: not logged in', '')).toBe(true)
    expect(isOpenCodeAuthFailure('provider returned 401 Unauthorized', '')).toBe(true)
    expect(isOpenCodeAuthFailure('invalid API key', '')).toBe(true)
    expect(isOpenCodeAuthFailure('authentication failed', '')).toBe(true)
  })

  it('does not match unrelated words that merely contain "auth"', () => {
    expect(isOpenCodeAuthFailure('author of the commit not found', '')).toBe(false)
    expect(isOpenCodeAuthFailure('credential helper missing for git', '')).toBe(false)
  })

  it('falls back to the message only when stderr is empty', () => {
    expect(isOpenCodeAuthFailure('', 'run: opencode auth login')).toBe(true)
    expect(isOpenCodeAuthFailure('   ', 'unauthorized')).toBe(true)
    expect(isOpenCodeAuthFailure('model not found', 'unauthorized')).toBe(false)
  })
})
