import { describe, it, expect } from 'vitest'
import { extractTicketRefs, parseTicketId } from '../issues/ticket-ref.js'
import { formatIssueContext, type TrackerIssue } from '../issues/context.js'

describe('extractTicketRefs', () => {
  it('pulls the ref from a conventional-commit PR title', () => {
    const refs = extractTicketRefs({ title: 'fix(kyc): record biometric consent (IN-2017)' })
    expect(refs.map(r => r.id)).toEqual(['IN-2017'])
  })

  it('recovers and upper-cases the ref from a lower-case branch name', () => {
    const refs = extractTicketRefs({ branch: 'claude/in-2017-biometric-consent' })
    expect(refs).toEqual([{ key: 'IN', number: 2017, id: 'IN-2017' }])
  })

  it('finds the ref in the PR body', () => {
    const refs = extractTicketRefs({ body: 'Resolves IN-2017 and unblocks onboarding.' })
    expect(refs.map(r => r.id)).toEqual(['IN-2017'])
  })

  it('dedupes across sources, keeping first-seen order (title before body)', () => {
    const refs = extractTicketRefs({
      title: 'IN-2017 add consent record',
      branch: 'claude/in-2017',
      body: 'depends on ENG-42, resolves IN-2017',
    })
    expect(refs.map(r => r.id)).toEqual(['IN-2017', 'ENG-42'])
  })

  it('returns nothing when there is no ticket-shaped token', () => {
    expect(extractTicketRefs({ title: 'chore: bump deps', branch: 'claude/bump' })).toEqual([])
  })

  it('keeps only configured team keys when teamKeys is set', () => {
    const refs = extractTicketRefs(
      { title: 'IN-2017 and ENG-42 and UTF-8 handling' },
      ['IN'],
    )
    expect(refs.map(r => r.id)).toEqual(['IN-2017'])
  })

  it('matches any key (including false-positive shapes) when teamKeys is empty', () => {
    const refs = extractTicketRefs({ title: 'decode UTF-8 for IN-2017' })
    expect(refs.map(r => r.id)).toContain('IN-2017')
    expect(refs.map(r => r.id)).toContain('UTF-8')
  })
})

describe('parseTicketId', () => {
  it('parses a canonical id', () => {
    expect(parseTicketId('IN-2017')).toEqual({ key: 'IN', number: 2017, id: 'IN-2017' })
  })

  it('normalizes case and surrounding whitespace', () => {
    expect(parseTicketId('  in-2017 ')).toEqual({ key: 'IN', number: 2017, id: 'IN-2017' })
  })

  it('rejects a non-id string', () => {
    expect(parseTicketId('not-a-ticket-x')).toBeNull()
  })
})

describe('formatIssueContext', () => {
  const base: TrackerIssue = {
    id: 'IN-2017',
    title: 'Record biometric consent so identity verification stops failing',
    description: 'When a user completes the biometric step, persist their consent…',
    labels: ['Bug', 'kyc'],
    estimate: 3,
    priorityLabel: 'High',
    projectName: 'Online Bug Reports',
    url: 'https://linear.app/inductive-network/issue/IN-2017',
  }

  it('renders the id, title, metadata, url, and goal block', () => {
    const out = formatIssueContext(base)
    expect(out).toContain('Linked issue IN-2017: Record biometric consent')
    expect(out).toContain('project Online Bug Reports')
    expect(out).toContain('priority High')
    expect(out).toContain('estimate 3')
    expect(out).toContain('labels Bug, kyc')
    expect(out).toContain('https://linear.app/inductive-network/issue/IN-2017')
    expect(out).toContain('Goal / acceptance from the tracker:')
    expect(out).toContain('Review the change against this stated goal')
  })

  it('truncates a long description to the configured cap', () => {
    const long = { ...base, description: 'x'.repeat(500) }
    const out = formatIssueContext(long, 100)
    expect(out).toContain('…[truncated]')
    expect(out).not.toContain('x'.repeat(200))
  })

  it('omits the metadata parens and goal block when fields are empty', () => {
    const bare: TrackerIssue = {
      id: 'IN-9', title: 'Tiny fix', description: null,
      labels: [], estimate: null, priorityLabel: null, projectName: null, url: null,
    }
    const out = formatIssueContext(bare)
    expect(out).toContain('Linked issue IN-9: Tiny fix')
    expect(out).not.toContain('(')
    expect(out).not.toContain('Goal / acceptance')
  })
})
