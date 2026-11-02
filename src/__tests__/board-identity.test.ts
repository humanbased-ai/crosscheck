import { describe, it, expect, beforeEach } from 'vitest'
import { PRBoard } from '../lib/board.js'
import { ConfigSchema } from '../config/schema.js'
import type { WorkflowStep } from '../lib/workflow.js'

const steps: WorkflowStep[] = [
  { type: 'review', name: 'review', reviewer: 'auto', max_rounds: 1 },
]

const ANSI = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g')
const strip = (s: string): string => s.replace(ANSI, '')

describe('PRBoard reviewer identity', () => {
  let board: PRBoard
  const panel = (): string =>
    (board as unknown as { renderConfigPanel: () => string[] })
      .renderConfigPanel()
      .map(strip)
      .join('\n')

  beforeEach(() => {
    board = new PRBoard()
    board.setConfig(ConfigSchema.parse({}), steps)
  })

  it('omits the line when the caller never sets an identity', () => {
    expect(panel()).not.toContain('reviewing as')
  })

  it('shows the app identity and its app id', () => {
    board.setReviewerIdentity({ label: 'crosscheck-bot[bot]', kind: 'app', appId: 1234567 })
    const rendered = panel()
    expect(rendered).toContain('reviewing as crosscheck-bot[bot]')
    expect(rendered).toContain('app 1234567')
    expect(rendered).not.toContain('comments only on your own PRs')
  })

  it('shows the operator identity with the self-review caveat', () => {
    board.setReviewerIdentity({ label: '@beingzy', kind: 'user' })
    const rendered = panel()
    expect(rendered).toContain('reviewing as @beingzy')
    expect(rendered).toContain('comments only on your own PRs')
  })

  it('can be cleared', () => {
    board.setReviewerIdentity({ label: '@beingzy', kind: 'user' })
    board.setReviewerIdentity(null)
    expect(panel()).not.toContain('reviewing as')
  })
})
