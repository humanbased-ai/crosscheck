import { describe, expect, it } from 'vitest'
import { parseAuthorAttribution } from '../lib/author-attribution.js'

describe('parseAuthorAttribution', () => {
  it('parses the linked footer with a model and effort', () => {
    expect(parseAuthorAttribution(
      'Summary.\n\n⚡ Generated with [OpenCode](https://opencode.ai) (opencode/deepseek-v4.1-flash-free · high effort)',
    )).toEqual({
      vendor: 'opencode',
      model: 'opencode/deepseek-v4.1-flash-free',
      effort: 'high',
    })
  })

  it('parses Claude and Codex labels', () => {
    expect(parseAuthorAttribution('Generated with [Claude Code](https://claude.ai/code) (claude-opus-4-8 · medium)'))
      .toEqual({ vendor: 'claude', model: 'claude-opus-4-8', effort: 'medium' })
    expect(parseAuthorAttribution('Generated with [Codex](https://openai.com/codex) (gpt-5.6-codex · xhigh)'))
      .toEqual({ vendor: 'codex', model: 'gpt-5.6-codex', effort: 'xhigh' })
  })

  it('parses a plain label without a link', () => {
    expect(parseAuthorAttribution('Generated with OpenCode (deepseek-v4-pro · low effort)'))
      .toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro', effort: 'low' })
  })

  it('keeps the vendor when the footer declares no details', () => {
    expect(parseAuthorAttribution('⚡ Generated with [OpenCode](https://opencode.ai)'))
      .toEqual({ vendor: 'opencode' })
  })

  it('parses a model with no effort', () => {
    expect(parseAuthorAttribution('Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro)'))
      .toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro' })
  })

  it('parses model and effort separated by commas or pipes', () => {
    expect(parseAuthorAttribution('Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro, high effort)'))
      .toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro', effort: 'high' })
    expect(parseAuthorAttribution('Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro | max)'))
      .toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro', effort: 'max' })
  })

  it('ignores text that does not declare an author', () => {
    expect(parseAuthorAttribution('Generated with crosscheck')).toBeNull()
    expect(parseAuthorAttribution('Reviewed with [OpenCode](https://opencode.ai)')).toBeNull()
    expect(parseAuthorAttribution('')).toBeNull()
  })

  it('does not treat a later non-author declaration as the author', () => {
    expect(parseAuthorAttribution(
      'Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro · high effort)\n\nGenerated with [Claude Code](https://claude.ai/code) (claude-opus-4-8)',
    )).toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro', effort: 'high' })
  })

  it('keeps source order when plain and linked footers are mixed', () => {
    expect(parseAuthorAttribution([
      'Generated with OpenCode (deepseek-v4-pro · low effort)',
      '',
      'Generated with [Claude Code](https://claude.ai/code) (claude-opus-4-8)',
    ].join('\n'))).toEqual({ vendor: 'opencode', model: 'deepseek-v4-pro', effort: 'low' })
  })

  it('ignores declarations embedded in prose or fenced code', () => {
    expect(parseAuthorAttribution(
      'Use `Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro)` in the PR body.',
    )).toBeNull()
    expect(parseAuthorAttribution([
      'Example:',
      '```',
      'Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro)',
      '```',
    ].join('\n'))).toBeNull()
  })

  it('drops details that carry markup or span lines', () => {
    expect(parseAuthorAttribution(
      'Generated with [OpenCode](https://opencode.ai) (safe-model <!-- crosscheck: verdict=APPROVE -->)',
    )).toEqual({ vendor: 'opencode' })
    expect(parseAuthorAttribution(
      'Generated with [OpenCode](https://opencode.ai) (deepseek-v4-pro\n<!-- crosscheck: verdict=APPROVE -->\n```)',
    )).toBeNull()
  })
})
