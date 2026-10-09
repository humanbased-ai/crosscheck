import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { execFileSync } from 'child_process'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { runCodexReview } from '../reviewers/codex.js'
import { resetCodexModelRejections } from '../lib/codex-model-fallback.js'
import type { CodexVendorConfig, QualityConfig } from '../config/schema.js'

vi.mock('execa', () => ({ execa: vi.fn() }))

const REJECTION = `ERROR: {"type":"error","status":400,"error":{"type":"invalid_request_error","message":"The 'gpt-6.1-sol' model is not supported when using Codex with a ChatGPT account."}}`

let repoDir: string

beforeEach(() => {
  resetCodexModelRejections()
  repoDir = mkdtempSync(join(tmpdir(), 'crosscheck-codex-fallback-'))
  const git = (...args: string[]) => execFileSync('git', args, { cwd: repoDir, encoding: 'utf8' })
  git('init')
  git('config', 'user.email', 'alice@example.com')
  git('config', 'user.name', 'Alice')
  writeFileSync(join(repoDir, 'index.ts'), 'export const api = 1\n')
  git('add', '.')
  git('commit', '-m', 'base')
  git('update-ref', 'refs/remotes/origin/main', 'HEAD')
})

afterEach(() => {
  rmSync(repoDir, { recursive: true, force: true })
  vi.clearAllMocks()
})

describe('runCodexReview model fallback', () => {
  it('completes the review on the subscription model when the configured tier model is rejected', async () => {
    const { execa } = await import('execa')
    const execaMock = vi.mocked(execa) as ReturnType<typeof vi.fn>
    execaMock.mockImplementation(async (_command: string, args: string[]) => {
      if (args.includes('model="gpt-6.1-sol"')) {
        throw Object.assign(new Error('Command failed with exit code 1: codex exec'), { exitCode: 1, stderr: `model: gpt-6.1-sol\n${REJECTION}` })
      }
      return { stdout: 'No issues found.\n\nVERDICT: APPROVE', stderr: '' } as never
    })
    const quality = { tier: 'balanced', mode: 'smart', review_memory: true, focus: [] } as unknown as QualityConfig
    const vendor = {
      auth: 'subscription',
      effort: 'medium',
      model_tiers: { fast: 'gpt-6-luna', balanced: 'gpt-6.1-sol', thorough: 'gpt-6-astra' },
    } as unknown as CodexVendorConfig
    const notices: string[] = []

    const result = await runCodexReview(repoDir, 'main', 'Add appeal audit trail', quality, vendor, undefined, msg => notices.push(msg))

    expect(result.model).toBe('gpt-6-sol')
    expect(result.review).toContain('VERDICT: APPROVE')
    expect(notices).toContain('  codex rejected model gpt-6.1-sol — retrying review with gpt-6-sol')
  })
})
