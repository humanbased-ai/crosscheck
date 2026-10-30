import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import { checkOpenCodeAuth, parseOpenCodeAuthList, parseOpenCodeAuthListJson } from '../reviewers/opencode.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const ZERO_CREDENTIALS = [
  '\x1b[0m',
  '┌  Credentials \x1b[90m~/.local/share/opencode/auth.json',
  '│',
  '└  0 credentials',
  '',
  '┌  Environment',
  '│',
  '●  OpenAI \x1b[90mOPENAI_API_KEY',
  '│',
  '└  1 environment variable',
].join('\n')

const ONE_CREDENTIAL = [
  '\x1b[0m',
  '┌  Credentials \x1b[90m~/.local/share/opencode/auth.json',
  '│',
  '●  OpenCode \x1b[90mapi',
  '│',
  '└  1 credentials',
  '',
  '┌  Environment',
  '│',
  '●  OpenAI \x1b[90mOPENAI_API_KEY',
  '│',
  '└  3 environment variables',
].join('\n')

// opencode 2.x dropped the framed table and its summary row: one plain line per
// stored credential, ending in the credential's status.
const V2_STORED_CREDENTIALS = [
  'OpenCode Console  Default                     stored',
  'Anthropic         Work                        stored',
].join('\n')

const FIXTURES_DIR = join(fileURLToPath(import.meta.url), '..', 'fixtures-opencode')
const help1211 = readFileSync(join(FIXTURES_DIR, 'run-help-1.2.11.txt'), 'utf8')
const help1193 = readFileSync(join(FIXTURES_DIR, 'run-help-1.19.3.txt'), 'utf8')
const help2032 = readFileSync(join(FIXTURES_DIR, 'run-help-2.0.32.txt'), 'utf8')

// Readiness probes the CLI (`run --help`, `--version`), then runs `auth list`.
function mockCli(authStdout: string, runHelp: string, version = '1.19.3') {
  vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) => {
    if (args?.[0] === 'auth') return Promise.resolve({ stdout: authStdout })
    if (args?.[0] === '--version') return Promise.resolve({ stdout: version, stderr: '', exitCode: 0 })
    return Promise.resolve({ stdout: runHelp, stderr: '', exitCode: 0 })
  }) as unknown as typeof execa)
}

beforeEach(() => vi.resetAllMocks())

describe('parseOpenCodeAuthList', () => {
  it('reads the credential count from the plain listing', () => {
    expect(parseOpenCodeAuthList(ZERO_CREDENTIALS)).toBe(0)
    expect(parseOpenCodeAuthList(ONE_CREDENTIAL)).toBe(1)
  })

  it('anchors to the summary row when a label mentions credentials', () => {
    const ambiguous = [
      '┌  Credentials',
      '│',
      '●  Legacy 9 credentials',
      '│',
      '└  1 credentials',
    ].join('\n')
    expect(parseOpenCodeAuthList(ambiguous)).toBe(1)
  })

  it('accepts the singular form', () => {
    expect(parseOpenCodeAuthList('└  1 credential')).toBe(1)
  })

  it('ignores the environment-variable count', () => {
    expect(parseOpenCodeAuthList('└  3 environment variables')).toBeNull()
  })

  it('counts the stored credential rows when opencode 2.x prints no summary row', () => {
    expect(parseOpenCodeAuthList(V2_STORED_CREDENTIALS)).toBe(2)
    expect(parseOpenCodeAuthList(`\x1b[90m${V2_STORED_CREDENTIALS}\x1b[0m\n`)).toBe(2)
  })

  it('reads the opencode 2.x empty listing as zero credentials', () => {
    expect(parseOpenCodeAuthList('No authenticated integrations\n')).toBe(0)
    expect(parseOpenCodeAuthList('\x1b[90mNo authenticated integrations\x1b[0m')).toBe(0)
  })

  it('counts a row whose label and status are separated by a single space', () => {
    expect(parseOpenCodeAuthList('Anthropic Work stored')).toBe(1)
  })

  it('matches the stored status case-insensitively, like the summary row', () => {
    expect(parseOpenCodeAuthList('OpenCode Console  Default  Stored')).toBe(1)
  })

  it('does not count a bare status or a row with another status', () => {
    expect(parseOpenCodeAuthList('stored')).toBeNull()
    expect(parseOpenCodeAuthList('OpenCode Console  Default  expired')).toBeNull()
  })

  it('prefers the summary row over counting rows', () => {
    expect(parseOpenCodeAuthList(`${V2_STORED_CREDENTIALS}\n└  5 credentials`)).toBe(5)
  })

  it('returns null when the summary line is missing', () => {
    expect(parseOpenCodeAuthList('opencode auth list\n\nOptions:\n  -h  show help')).toBeNull()
  })
})

// `opencode auth list --format json` on v2.0.32: providers, each with its connections.
const V2_JSON_THREE_CREDENTIALS = JSON.stringify([
  {
    id: 'opencode',
    name: 'OpenCode Console',
    connections: [
      { type: 'credential', id: 'cred_1', label: 'Default', method: 'oauth' },
      { type: 'credential', id: 'cred_2', label: 'Default', method: 'oauth' },
      { type: 'credential', id: 'cred_3', label: 'Default', method: 'oauth' },
    ],
  },
], null, 2)

describe('parseOpenCodeAuthListJson', () => {
  it('counts credential connections across providers', () => {
    expect(parseOpenCodeAuthListJson(V2_JSON_THREE_CREDENTIALS)).toBe(3)
    const twoProviders = JSON.stringify([
      { id: 'opencode', connections: [{ type: 'credential' }] },
      { id: 'anthropic', connections: [{ type: 'credential' }, { type: 'credential' }] },
    ])
    expect(parseOpenCodeAuthListJson(twoProviders)).toBe(3)
  })

  it('reads an empty listing as zero credentials', () => {
    expect(parseOpenCodeAuthListJson('[]\n')).toBe(0)
  })

  it('does not count connections that are not credentials', () => {
    const envOnly = JSON.stringify([{ id: 'openai', connections: [{ type: 'environment', id: 'OPENAI_API_KEY' }] }])
    expect(parseOpenCodeAuthListJson(envOnly)).toBe(0)
  })

  it('treats a connections array with a non-connection element as unreadable, not logged out', () => {
    expect(parseOpenCodeAuthListJson('[{"id":"opencode","connections":["a",1,null]}]')).toBeNull()
    expect(parseOpenCodeAuthListJson('[{"id":"opencode","connections":[{"id":"cred_1"}]}]')).toBeNull()
  })

  it('returns null for text, help output, or a malformed listing', () => {
    expect(parseOpenCodeAuthListJson('No authenticated integrations')).toBeNull()
    expect(parseOpenCodeAuthListJson('opencode auth list\n\nOptions:\n  -h  show help')).toBeNull()
    expect(parseOpenCodeAuthListJson('{"providers":[]}')).toBeNull()
    expect(parseOpenCodeAuthListJson('[{"id":"opencode"}]')).toBeNull()
  })
})

describe('checkOpenCodeAuth', () => {
  it('asks opencode 2.x for JSON and reports its credentials', async () => {
    mockCli(V2_JSON_THREE_CREDENTIALS, help2032, '2.0.32')
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '3 provider(s) configured' })
    expect(execa).toHaveBeenCalledWith('opencode', ['auth', 'list', '--format', 'json'], { timeout: 10_000 })
    expect(execa).not.toHaveBeenCalledWith('opencode', ['auth', 'list'], expect.anything())
  })

  it('asks for a login when the opencode 2.x JSON listing is empty', async () => {
    mockCli('[]\n', help2032, '2.0.32')
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: false, detail: 'no providers configured — run: opencode auth login' })
  })

  it('falls back to the text listing when the CLI rejects --format as a usage error', async () => {
    const usage = ['DESCRIPTION', '  list integrations and credentials', '', 'USAGE', '  opencode auth list [flags]', '', 'Positionals:', '', 'Options:', '  --standalone'].join('\n')
    vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') return Promise.resolve({ stdout: '2.0.32', stderr: '', exitCode: 0 })
      if (args?.[0] === 'auth' && args.includes('--format')) return Promise.reject(Object.assign(new Error('exit 1'), { stderr: usage, exitCode: 1 }))
      if (args?.[0] === 'auth') return Promise.resolve({ stdout: V2_STORED_CREDENTIALS })
      return Promise.resolve({ stdout: help2032, stderr: '', exitCode: 0 })
    }) as unknown as typeof execa)
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '2 provider(s) configured' })
  })

  it.each([
    'ERROR\n  Unrecognized flag: --format in command opencode auth list',
    'ERROR\n  Invalid value for flag --format: "json". Expected: "default" | "table"',
  ])('falls back to the text listing when opencode 2.x rejects --format: %s', async (stderr) => {
    vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') return Promise.resolve({ stdout: '2.0.32', stderr: '', exitCode: 0 })
      if (args?.[0] === 'auth' && args.includes('--format')) return Promise.reject(Object.assign(new Error('exit 1'), { stderr, exitCode: 1 }))
      if (args?.[0] === 'auth') return Promise.resolve({ stdout: V2_STORED_CREDENTIALS })
      return Promise.resolve({ stdout: help2032, stderr: '', exitCode: 0 })
    }) as unknown as typeof execa)
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '2 provider(s) configured' })
  })

  it('does not fall back when the JSON command fails for a reason other than a usage rejection', async () => {
    vi.mocked(execa).mockImplementation(((_file: string, args?: readonly string[]) => {
      if (args?.[0] === '--version') return Promise.resolve({ stdout: '2.0.32', stderr: '', exitCode: 0 })
      if (args?.[0] === 'auth') return Promise.reject(Object.assign(new Error('exit 1'), { stderr: 'service unreachable', exitCode: 1 }))
      return Promise.resolve({ stdout: help2032, stderr: '', exitCode: 0 })
    }) as unknown as typeof execa)
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: false, detail: 'service unreachable' })
  })

  it('fails closed when opencode 2.x JSON output is unreadable', async () => {
    mockCli('No authenticated integrations\n', help2032, '2.0.32')
    const result = await checkOpenCodeAuth()
    expect(result.ok).toBe(false)
    expect(result.detail).toBe('could not read opencode auth list --format json output — run: opencode auth list --format json')
  })

  it('uses the plain auth list command and reports configured providers', async () => {
    mockCli(ONE_CREDENTIAL, help1193)
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '1 provider(s) configured' })
    expect(execa).toHaveBeenCalledWith('opencode', ['auth', 'list'], { timeout: 10_000 })
    expect(execa).not.toHaveBeenCalledWith('opencode', ['auth', 'list', '--format', 'json'], expect.anything())
  })

  it('reads the 2.x text rows when the probe does not classify the CLI as v2', async () => {
    mockCli(V2_STORED_CREDENTIALS, help1193, '2.0.32')
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '2 provider(s) configured' })
  })

  it('asks for a login on the 2.x empty text listing when the probe does not classify the CLI as v2', async () => {
    mockCli('No authenticated integrations\n', help1193, '2.0.32')
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: false, detail: 'no providers configured — run: opencode auth login' })
  })

  it('is not ready when the logged-in CLI lacks run --auto', async () => {
    mockCli(ONE_CREDENTIAL, help1211, '1.2.11')
    const result = await checkOpenCodeAuth()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/^opencode 1\.2\.11 .*does not support 'run --auto'/)
  })

  it('is not ready when the CLI probe itself fails', async () => {
    mockCli(ONE_CREDENTIAL, 'garbled output')
    const result = await checkOpenCodeAuth()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/could not read 'opencode run --help'/)
  })

  it('reports a logged-out install without claiming a broken CLI', async () => {
    mockCli(ZERO_CREDENTIALS, help1193)
    await expect(checkOpenCodeAuth()).resolves.toEqual({
      ok: false,
      detail: 'no providers configured — run: opencode auth login',
    })
  })

  it('fails closed on output it cannot read', async () => {
    mockCli('unexpected output', help1193)
    await expect(checkOpenCodeAuth()).resolves.toEqual({
      ok: false,
      detail: 'could not read opencode auth list output — run: opencode auth list',
    })
  })

  it('surfaces a missing executable', async () => {
    vi.mocked(execa).mockRejectedValue(new Error('spawn opencode ENOENT'))
    const result = await checkOpenCodeAuth()
    expect(result.ok).toBe(false)
    expect(result.detail).toMatch(/capability probe failed \(spawn opencode ENOENT\)/)
  })
})
