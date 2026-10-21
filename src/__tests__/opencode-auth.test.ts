import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { checkOpenCodeAuth, parseOpenCodeAuthList } from '../reviewers/opencode.js'

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

  it('returns null when the summary line is missing', () => {
    expect(parseOpenCodeAuthList('opencode auth list\n\nOptions:\n  -h  show help')).toBeNull()
  })
})

describe('checkOpenCodeAuth', () => {
  it('uses the plain auth list command and reports configured providers', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: ONE_CREDENTIAL } as Awaited<ReturnType<typeof execa>>)
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: true, detail: '1 provider(s) configured' })
    expect(execa).toHaveBeenCalledWith('opencode', ['auth', 'list'], { timeout: 10_000 })
  })

  it('reports a logged-out install without claiming a broken CLI', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: ZERO_CREDENTIALS } as Awaited<ReturnType<typeof execa>>)
    await expect(checkOpenCodeAuth()).resolves.toEqual({
      ok: false,
      detail: 'no providers configured — run: opencode auth login',
    })
  })

  it('fails closed on output it cannot read', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'unexpected output' } as Awaited<ReturnType<typeof execa>>)
    await expect(checkOpenCodeAuth()).resolves.toEqual({
      ok: false,
      detail: 'could not read opencode auth list output — run: opencode auth list',
    })
  })

  it('surfaces a missing executable', async () => {
    vi.mocked(execa).mockRejectedValueOnce({ stderr: 'not found' })
    await expect(checkOpenCodeAuth()).resolves.toEqual({ ok: false, detail: 'not found' })
  })
})
