import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { execa } from 'execa'
import { runOpenCode, openCodeModelArgs } from '../reviewers/opencode-process.js'
import { runOpenCodeReview } from '../reviewers/opencode.js'
import { runClaudeReview } from '../reviewers/claude.js'
import { runCodexReview } from '../reviewers/codex.js'
import { resetCodexModelRejections } from '../lib/codex-model-fallback.js'
import { ConfigSchema } from '../config/schema.js'

vi.mock('execa', () => ({ execa: vi.fn() }))
vi.mock('../reviewers/opencode-process.js', async importOriginal => ({ ...await importOriginal<typeof import('../reviewers/opencode-process.js')>(), runOpenCode: vi.fn() }))
let repo: string
beforeEach(() => {
  vi.clearAllMocks(); resetCodexModelRejections()
  repo = mkdtempSync(join(tmpdir(), 'crosscheck-review-ceiling-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repo, stdio: 'ignore' })
  git('init'); git('config', 'user.name', 'Review fixture'); git('config', 'user.email', 'review@example.com')
  writeFileSync(join(repo, 'index.ts'), 'export const revision = 1\n')
  git('add', '.'); git('commit', '-m', 'review fixture'); git('update-ref', 'refs/remotes/origin/main', 'HEAD')
})
afterEach(() => { rmSync(repo, { recursive: true, force: true }); vi.restoreAllMocks() })

const approved = { stdout: JSON.stringify({ type: 'text', part: { text: 'No issues found.\n\nVERDICT: APPROVE' } }), stderr: '' }

describe('review policy at the subprocess boundary', () => {
  it('falls back from exhausted free usage only to an opted-in model and cools down the free route', async () => {
    vi.mocked(execa).mockResolvedValue({ stdout: 'Options:\n --auto\n --format json\n --standalone', stderr: '' } as never)
    vi.mocked(runOpenCode).mockRejectedValueOnce(new Error('Free usage limit reached')).mockResolvedValue(approved)
    const cfg = ConfigSchema.parse({ quality: { preference: 'cost-min', review_models: { opencode: [
      { id: 'private/free-flash', model_class: 'fast', source: 'cli', efforts: ['low', 'high'], input_usd_mtok: 0, output_usd_mtok: 0 },
      { id: 'private/paid-flash', model_class: 'fast', source: 'cli', efforts: ['high'], input_usd_mtok: .1, output_usd_mtok: .2 },
    ] } } })
    cfg.vendors.opencode.effort = 'none'
    const outcome = await runOpenCodeReview(repo, 'main', 'Review model discovery', cfg.quality, cfg.vendors.opencode)
    expect(outcome.model).toBe('private/paid-flash')
    expect(outcome.effort).toBe('high')
    expect(vi.mocked(runOpenCode).mock.calls[0][0]).toContain('private/free-flash#low')
    expect(vi.mocked(runOpenCode).mock.calls[1][0]).toContain('private/paid-flash#high')
    vi.mocked(runOpenCode).mockClear()
    await runOpenCodeReview(repo, 'main', 'Review after exhausted free usage', cfg.quality, cfg.vendors.opencode)
    expect(vi.mocked(runOpenCode).mock.calls[0][0]).toContain('private/paid-flash#high')
    expect(openCodeModelArgs('private/free-flash', 'low', false)).toEqual(['--model', 'private/free-flash', '--variant', 'low'])
  })

  it('rejects a flagship pin before spawning any reviewer and discards a substituted flagship verdict', async () => {
    const cfg = ConfigSchema.parse({ quality: { tier: 'thorough' }, vendors: { claude: { model: 'opus' } } })
    await expect(runClaudeReview(repo, 'main', 'Review ceiling', cfg.quality, cfg.vendors.claude, 1)).rejects.toThrow(/excluded/)
    expect(execa).not.toHaveBeenCalled()
    vi.mocked(execa).mockResolvedValue({ stdout: JSON.stringify({ result: 'VERDICT: APPROVE', modelUsage: { 'claude-opus-5-5': { outputTokens: 10 } } }), stderr: '' } as never)
    await expect(runClaudeReview(repo, 'main', 'Review ceiling', cfg.quality, { ...cfg.vendors.claude, model: null }, 1)).rejects.toThrow(/substituted an excluded flagship/)
    expect(vi.mocked(execa).mock.calls[0][1]).toContain('claude-sonnet-5-5')
    const invocation: readonly unknown[] = vi.mocked(execa).mock.calls[0]
    expect(invocation[2]).toMatchObject({ env: { CLAUDE_CODE_EFFORT_LEVEL: 'high' } })
  })

  it('never escapes a Codex allowlist to a flagship or unknown CLI default after model rejection', async () => {
    const cfg = ConfigSchema.parse({ quality: { review_models: { codex: [
      { id: 'gpt-6.1-sol', model_class: 'standard', source: 'cli', efforts: ['medium'] },
      { id: 'gpt-6-astra', model_class: 'standard', source: 'cli', efforts: ['high'] },
    ] } } })
    const rejection = JSON.stringify({ type: 'turn.failed', error: { message: 'model is not supported' } })
    vi.mocked(execa).mockRejectedValue(Object.assign(new Error('model rejected'), { stdout: rejection, exitCode: 1 }))
    await expect(runCodexReview(repo, 'main', 'Review fallback ceiling', cfg.quality, cfg.vendors.codex)).rejects.toThrow()
    expect(execa).toHaveBeenCalledTimes(1)
    expect(vi.mocked(execa).mock.calls[0][1]).toContain('model="gpt-6.1-sol"')
  })
})

it('omits unknown native effort controls rather than inventing a medium request', async () => {
  const cfg = ConfigSchema.parse({ quality: { review_models: {
    codex: [{ id: 'private-review', model_class: 'standard', source: 'configured', efforts: [] }],
    claude: [{ id: 'private-review', model_class: 'standard', source: 'configured', efforts: [] }],
  } } })
  vi.mocked(execa).mockResolvedValueOnce({ stdout: JSON.stringify({ type: 'item.completed', item: { type: 'agent_message', text: 'VERDICT: APPROVE' } }), stderr: '' } as never)
  const codex = await runCodexReview(repo, 'main', 'Custom model without an effort ladder', cfg.quality, cfg.vendors.codex)
  expect(codex.effort).toBeUndefined()
  expect(vi.mocked(execa).mock.calls[0][1]).not.toEqual(expect.arrayContaining([expect.stringContaining('model_reasoning_effort=')]))
  vi.mocked(execa).mockResolvedValueOnce({ stdout: JSON.stringify({ result: 'VERDICT: APPROVE' }), stderr: '' } as never)
  const claude = await runClaudeReview(repo, 'main', 'Custom model without an effort ladder', cfg.quality, cfg.vendors.claude, 1)
  expect(claude.effort).toBeUndefined()
  expect(vi.mocked(execa).mock.calls[1][1]).not.toContain('--effort')
})
