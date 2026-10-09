import { beforeEach, describe, expect, it, vi } from 'vitest'
import { execa } from 'execa'
import { probeReviewerReadiness, setupReviewerTools, type ReviewerReadiness, type ReviewerSetupDependencies } from '../lib/reviewer-setup.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkOpenCodeAuth } from '../reviewers/opencode.js'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../reviewers/codex.js', () => ({ checkCodexAuth: vi.fn() }))
vi.mock('../reviewers/opencode.js', () => ({ checkOpenCodeAuth: vi.fn() }))
const ready: ReviewerReadiness = { installed: true, authenticated: true, detail: 'ready' }
const missing: ReviewerReadiness = { installed: false, authenticated: false, detail: 'not installed' }
const loggedOut: ReviewerReadiness = { installed: true, authenticated: false, detail: 'login needed' }
function dependencies(): ReviewerSetupDependencies {
  return { probe: vi.fn(async () => ready), select: vi.fn(async () => ['claude']), choose: vi.fn(async () => 0), run: vi.fn(async () => {}), report: vi.fn() }
}
beforeEach(() => vi.resetAllMocks())

describe('readiness probes', () => {
  it('does not treat an installed Claude CLI as authenticated', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'version' } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({ stdout: '{"loggedIn":false}' } as Awaited<ReturnType<typeof execa>>)
    expect(await probeReviewerReadiness('claude')).toMatchObject({ installed: true, authenticated: false })
    expect(execa).toHaveBeenLastCalledWith('claude', ['auth', 'status', '--json'], { timeout: 10_000 })
  })
  it('checks Claude login state without exposing the account payload', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'version' } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({ stdout: '{"loggedIn":true,"email":"private@example.com"}' } as Awaited<ReturnType<typeof execa>>)
    expect(await probeReviewerReadiness('claude')).toEqual({ ...ready, detail: 'logged in' })
  })
  it('fails closed on malformed Claude auth output', async () => {
    vi.mocked(execa).mockResolvedValueOnce({ stdout: 'version' } as Awaited<ReturnType<typeof execa>>)
      .mockResolvedValueOnce({ stdout: 'not json' } as Awaited<ReturnType<typeof execa>>)
    expect(await probeReviewerReadiness('claude')).toMatchObject({ installed: true, authenticated: false })
  })
  it('distinguishes missing executables from broken installations', async () => {
    vi.mocked(execa).mockRejectedValueOnce({ code: 'ENOENT' }).mockRejectedValueOnce({ exitCode: 1 })
    expect(await probeReviewerReadiness('codex')).toEqual(missing)
    expect(await probeReviewerReadiness('opencode')).toMatchObject({ installed: true, authenticated: false })
  })
  it.each(['codex', 'opencode'] as const)('uses the existing %s auth check', async vendor => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'version' } as Awaited<ReturnType<typeof execa>>)
    vi.mocked(checkCodexAuth).mockResolvedValue({ ok: true, detail: 'configured' })
    vi.mocked(checkOpenCodeAuth).mockResolvedValue({ ok: false, detail: 'no providers' })
    expect((await probeReviewerReadiness(vendor)).authenticated).toBe(vendor === 'codex')
  })
})

describe('guided selection, installation, and login', () => {
  it('shows all tools and status even when none are installed', async () => {
    const deps = dependencies()
    vi.mocked(deps.probe).mockResolvedValue(missing)
    vi.mocked(deps.select).mockResolvedValue([])
    await expect(setupReviewerTools(undefined, deps)).rejects.toThrow('No reviewer tools selected')
    const [items, options] = vi.mocked(deps.select).mock.calls[0]
    expect(items).toEqual(['claude', 'codex', 'opencode'])
    expect(options.getDescription?.('opencode')).toContain('not installed')
    expect(deps.run).not.toHaveBeenCalled()
  })
  it('preserves existing choices, including missing OpenCode, as checkboxes', async () => {
    const deps = dependencies()
    vi.mocked(deps.select).mockResolvedValue(['opencode'])
    expect(await setupReviewerTools(['opencode'], deps)).toEqual({ selected: ['opencode'], skipped: [] })
    expect(vi.mocked(deps.select).mock.calls[0][1].initialSelected).toEqual(['opencode'])
  })
  it('leaves OpenCode unchecked on a fresh mixed installation', async () => {
    const deps = dependencies()
    await setupReviewerTools(undefined, deps)
    expect(vi.mocked(deps.select).mock.calls[0][1].initialSelected).toEqual(['claude', 'codex'])
  })
  it('installs then logs in, and checks readiness after each command', async () => {
    const deps = dependencies()
    vi.mocked(deps.select).mockResolvedValue(['opencode'])
    let state = missing
    vi.mocked(deps.probe).mockImplementation(async vendor => vendor === 'opencode' ? state : ready)
    vi.mocked(deps.run).mockImplementation(async command => { state = command === 'npm' ? loggedOut : ready })
    expect(await setupReviewerTools(undefined, deps)).toEqual({ selected: ['opencode'], skipped: [] })
    expect(vi.mocked(deps.run).mock.calls).toEqual([
      ['npm', ['install', '--global', '@opencode/cli']], ['opencode', ['auth', 'login']],
    ])
    expect(vi.mocked(deps.probe).mock.calls.filter(([vendor]) => vendor === 'opencode')).toHaveLength(4)
  })
  it('rechecks manually installed tools without running commands', async () => {
    const deps = dependencies()
    vi.mocked(deps.probe).mockResolvedValueOnce(missing).mockResolvedValue(ready)
    vi.mocked(deps.choose).mockResolvedValue(1) // missing tool: Check again
    expect(await setupReviewerTools(undefined, deps)).toEqual({ selected: ['claude'], skipped: [] })
    expect(deps.run).not.toHaveBeenCalled()
  })
  it('allows installer failure followed by a skip while retaining another tool', async () => {
    const deps = dependencies()
    vi.mocked(deps.select).mockResolvedValue(['claude', 'codex'])
    vi.mocked(deps.probe).mockImplementation(async vendor => vendor === 'codex' ? missing : ready)
    vi.mocked(deps.run).mockRejectedValue(new Error('permission denied'))
    vi.mocked(deps.choose).mockResolvedValueOnce(0).mockResolvedValueOnce(2) // install, then skip
    expect(await setupReviewerTools(undefined, deps)).toEqual({ selected: ['claude'], skipped: ['codex'] })
    expect(deps.report).toHaveBeenCalledWith(expect.stringContaining('command failed'))
  })
  it('does not accept an installer exit as proof of authentication', async () => {
    const deps = dependencies()
    vi.mocked(deps.probe).mockResolvedValue(missing)
    vi.mocked(deps.choose).mockResolvedValueOnce(0).mockResolvedValueOnce(2)
    await expect(setupReviewerTools(undefined, deps)).rejects.toThrow('No selected reviewer is ready')
  })
  it('can retry a failed login', async () => {
    const deps = dependencies()
    let state = loggedOut
    vi.mocked(deps.probe).mockImplementation(async () => state)
    vi.mocked(deps.run).mockRejectedValueOnce(new Error('canceled')).mockImplementationOnce(async () => { state = ready })
    expect((await setupReviewerTools(undefined, deps)).selected).toEqual(['claude'])
    expect(deps.run).toHaveBeenCalledTimes(2)
  })
  it('can select all three tools', async () => {
    const deps = dependencies()
    vi.mocked(deps.select).mockResolvedValue(['claude', 'codex', 'opencode'])
    expect((await setupReviewerTools(undefined, deps)).selected).toEqual(['claude', 'codex', 'opencode'])
    expect(deps.run).not.toHaveBeenCalled()
  })
  it('aborts without enabling any tools', async () => {
    const deps = dependencies()
    vi.mocked(deps.probe).mockResolvedValue(loggedOut)
    vi.mocked(deps.choose).mockResolvedValue(4)
    await expect(setupReviewerTools(undefined, deps)).rejects.toThrow('canceled; config was not written')
    expect(deps.run).not.toHaveBeenCalled()
  })
  it('rejects a tool that loses auth while another is being set up', async () => {
    const deps = dependencies()
    vi.mocked(deps.probe).mockResolvedValueOnce(ready).mockResolvedValueOnce(ready).mockResolvedValueOnce(ready).mockResolvedValue(loggedOut)
    await expect(setupReviewerTools(undefined, deps)).rejects.toThrow('no longer ready')
  })
  it('rejects unknown selections before executing a command', async () => {
    const deps = dependencies()
    vi.mocked(deps.select).mockResolvedValue(['unknown'])
    await expect(setupReviewerTools(undefined, deps)).rejects.toThrow('Invalid reviewer tool')
    expect(deps.run).not.toHaveBeenCalled()
  })
})
