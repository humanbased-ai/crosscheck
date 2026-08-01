import { describe, it, expect, vi } from 'vitest'
import { renderSignature, renderIcon, resolveLinearAuth, type FetchLike } from '../linear/identity.js'
import { buildLinearCommentBody } from '../linear/comment.js'
import { notifyLinear } from '../linear/notify.js'
import { LinearConfigSchema } from '../config/schema.js'

function cfg(overrides: Record<string, unknown> = {}) {
  return LinearConfigSchema.parse({ enabled: true, team_keys: ['IN'], ...overrides })
}

const VARS = { actor: 'crosscheck/review', product: 'crosscheck' }

describe('renderSignature — model and reviewer', () => {
  it('expands {model}', () => {
    expect(renderSignature('🤖 {actor} · {model}', { ...VARS, model: 'claude-opus-4.5' }))
      .toBe('🤖 crosscheck/review · claude-opus-4.5')
  })

  it('expands {reviewer}', () => {
    expect(renderSignature('{reviewer} · {model}', { ...VARS, reviewer: 'codex', model: 'gpt-5' }))
      .toBe('codex · gpt-5')
  })

  it('preserves hyphens in model names', () => {
    // The separator tidier must not touch `-`, or claude-opus-4.5 gets mangled.
    expect(renderSignature('{model}', { ...VARS, model: 'claude-opus-4.5' })).toBe('claude-opus-4.5')
  })

  it('drops the trailing separator when the model is unknown', () => {
    expect(renderSignature('🤖 {actor} · {product} · {model}', VARS)).toBe('🤖 crosscheck/review · crosscheck')
  })

  it('drops a stranded separator in the middle', () => {
    expect(renderSignature('{actor} · {model} · {product}', VARS)).toBe('crosscheck/review · crosscheck')
  })

  it('handles every optional placeholder being empty', () => {
    expect(renderSignature('🤖 {icon} {actor} · {model} · {reviewer}', VARS)).toBe('🤖 crosscheck/review')
  })

  it('is unchanged when the template uses no optional placeholders', () => {
    expect(renderSignature('🤖 {actor} · {product}', VARS)).toBe('🤖 crosscheck/review · crosscheck')
  })
})

describe('renderIcon', () => {
  it('wraps a URL as inline markdown', () => {
    expect(renderIcon('https://example.com/logo.png')).toBe('![](https://example.com/logo.png)')
  })

  it('returns empty for an unset or blank URL', () => {
    expect(renderIcon('')).toBe('')
    expect(renderIcon('   ')).toBe('')
  })

  it('composes into a signature', () => {
    const signature = renderSignature('{icon} {actor} · {model}', {
      ...VARS, model: 'gpt-5', icon: renderIcon('https://example.com/logo.png'),
    })
    expect(signature).toBe('![](https://example.com/logo.png) crosscheck/review · gpt-5')
  })
})

describe('default signature template', () => {
  it('includes the model placeholder', () => {
    expect(cfg().identity.signature).toBe('🤖 {actor} · {model}')
  })

  it('renders cleanly at auth time, when no model is known yet', async () => {
    const auth = await resolveLinearAuth(cfg(), { apiKey: 'k' })
    expect(auth.signature).toBe('🤖 crosscheck')
  })

  it('defaults icon_url to empty so nothing renders unless configured', () => {
    expect(cfg().identity.icon_url).toBe('')
  })
})

describe('comment body — model on the verdict line', () => {
  const BASE = {
    signature: '🤖 crosscheck · crosscheck',
    verdict: 'APPROVE',
    reviewer: 'codex',
    origin: 'claude',
    prUrl: 'https://github.com/acme/app/pull/12',
    prTitle: 'feat: widget',
  }

  it('names the model beside the reviewer', () => {
    expect(buildLinearCommentBody({ ...BASE, model: 'gpt-5' }))
      .toContain('**APPROVE** — codex (gpt-5) review of')
  })

  it('omits the parenthetical when the model is `default`', () => {
    const body = buildLinearCommentBody({ ...BASE, model: 'default' })
    expect(body).toContain('**APPROVE** — codex review of')
    expect(body).not.toContain('(default)')
  })

  it('still records the model in the machine-readable annotation', () => {
    expect(buildLinearCommentBody({ ...BASE, model: 'default' })).toContain('model=default')
  })
})

describe('notifyLinear — end-to-end branding', () => {
  const AUTH = {
    mode: 'client_credentials' as const,
    token: 'minted',
    bearer: true,
    actor: 'crosscheck/review',
    signature: '🤖 crosscheck/review · crosscheck',
    signatureTemplate: '🤖 {icon} {actor} · {product} · {model}',
    product: 'crosscheck',
    createAsUser: 'crosscheck/review',
  }
  const PR = { branch: 'feat/in-2269-x', title: 'feat: x', body: '', url: 'https://github.com/a/b/pull/1' }

  function scriptedFetch(): FetchLike {
    let call = 0
    return vi.fn(async () => {
      call++
      if (call === 1) {
        return new Response(JSON.stringify({
          data: { issues: { nodes: [{ id: 'u1', identifier: 'IN-2269', url: 'https://linear.app/x/i' }] } },
        }), { status: 200 })
      }
      return new Response(JSON.stringify({
        data: { commentCreate: { success: true, comment: { id: 'c1', url: 'https://linear.app/x/c1' } } },
      }), { status: 200 })
    })
  }

  async function postedFirstLine(config: ReturnType<typeof cfg>, model: string): Promise<string> {
    const fetchImpl = scriptedFetch()
    await notifyLinear(
      { auth: AUTH, config, pr: PR, verdict: 'NEEDS_WORK', reviewer: 'codex', origin: 'claude', model },
      { fetchImpl },
    )
    const calls = (fetchImpl as ReturnType<typeof vi.fn>).mock.calls
    return (JSON.parse(calls[1][1].body as string).variables.body as string).split('\n')[0]
  }

  it('puts the real model in the posted signature', async () => {
    expect(await postedFirstLine(cfg(), 'claude-opus-4.5'))
      .toBe('🤖 crosscheck/review · crosscheck · claude-opus-4.5')
  })

  it('renders the configured icon into the posted signature', async () => {
    const config = cfg({ identity: { icon_url: 'https://example.com/logo.png' } })
    expect(await postedFirstLine(config, 'gpt-5'))
      .toBe('🤖 ![](https://example.com/logo.png) crosscheck/review · crosscheck · gpt-5')
  })

  it('omits the model rather than printing `default`', async () => {
    expect(await postedFirstLine(cfg(), 'default')).toBe('🤖 crosscheck/review · crosscheck')
  })
})
