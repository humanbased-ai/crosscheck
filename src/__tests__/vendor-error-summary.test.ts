import { describe, it, expect } from 'vitest'
import { oneLine, summarizeVendorJson, vendorFailureSummary } from '../lib/vendor-error-summary.js'

// The shape `claude --print --output-format json` exits with on a 429: nothing on
// stderr, the reason inside an envelope on stdout, and execa's message carrying
// the whole command line plus that envelope.
const ENVELOPE = JSON.stringify({
  duration_api_ms: 0,
  is_error: true,
  subtype: 'success',
  api_error_status: 429,
  result: "Claude AI usage limit reached · your weekly limit resets Sep 23 at 12am (Asia/Shanghai)",
})

describe('oneLine', () => {
  it('collapses newlines and runs of whitespace', () => {
    expect(oneLine('a\n\n  b\tc')).toBe('a b c')
  })

  it('clamps to the requested width with an ellipsis', () => {
    expect(oneLine('x'.repeat(50), 10)).toBe(`${'x'.repeat(9)}…`)
  })
})

describe('summarizeVendorJson', () => {
  it('pulls the result field out of a vendor envelope and keeps the status code', () => {
    const summary = summarizeVendorJson(ENVELOPE)
    expect(summary).toContain('API error 429')
    expect(summary).toContain('usage limit reached')
    expect(summary).not.toContain('{')
  })

  it('takes the last envelope when the CLI streamed several', () => {
    const streamed = `{"type":"system","result":"first"}\n${ENVELOPE}`
    expect(summarizeVendorJson(streamed)).toContain('usage limit reached')
  })

  it('reports the status alone when the envelope names no reason', () => {
    expect(summarizeVendorJson('{"is_error":true,"api_error_status":500}')).toBe('API error 500')
  })

  it('returns undefined for output with no envelope', () => {
    expect(summarizeVendorJson(undefined)).toBeUndefined()
    expect(summarizeVendorJson('plain stderr line')).toBeUndefined()
    expect(summarizeVendorJson('{not json')).toBeUndefined()
  })

  it('does not treat a successful envelope as a failure reason', () => {
    expect(summarizeVendorJson('{"is_error":false,"api_error_status":200}')).toBeUndefined()
  })
})

describe('vendorFailureSummary', () => {
  it('prefers the last real stderr line', () => {
    const summary = vendorFailureSummary({ stderr: 'warming up\nfatal: bad credentials\n', stdout: ENVELOPE })
    expect(summary).toBe('fatal: bad credentials')
  })

  it('honours a caller-supplied stderr picker', () => {
    const summary = vendorFailureSummary(
      { stderr: 'error: boom\ntrailing noise' },
      stderr => stderr.split('\n').find(l => l.startsWith('error:')),
    )
    expect(summary).toBe('error: boom')
  })

  it('falls back to the stdout envelope when stderr is empty', () => {
    expect(vendorFailureSummary({ stderr: '   ', stdout: ENVELOPE })).toContain('usage limit reached')
  })

  it('digs the envelope out of execa message when stdout was not annotated', () => {
    const message = `Command failed with exit code 1: claude --print --mcp-config '{"mcpServers":{"crosscheck":{}}}'\n\n${ENVELOPE}`
    const summary = vendorFailureSummary({ message })
    expect(summary).toContain('usage limit reached')
    expect(summary).not.toContain('mcpServers')
  })

  it('keeps just the first line of a message with no envelope at all', () => {
    const summary = vendorFailureSummary({ message: 'Command failed with exit code 2: codex exec\n\nstack trace here' })
    expect(summary).toBe('Command failed with exit code 2: codex exec')
  })

  it('reports unknown error when there is nothing to go on', () => {
    expect(vendorFailureSummary({})).toBe('unknown error')
  })

  it('never returns a multi-line string', () => {
    const summary = vendorFailureSummary({ stdout: JSON.stringify({ is_error: true, result: 'line one\nline two' }) })
    expect(summary).not.toContain('\n')
  })
})
