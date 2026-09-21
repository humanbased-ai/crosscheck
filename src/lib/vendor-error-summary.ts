// Turns a failed vendor-CLI invocation into one readable line.
//
// Both CLIs are run with `--output-format json`, so when the API rejects the
// call the process exits non-zero with an *empty stderr* and the real reason
// sitting in a JSON envelope on stdout. execa's own `message` in that case is
// the whole command line followed by that envelope — hundreds of columns of
// `--mcp-config '{"mcpServers":…}'` and `{"duration_api_ms":0,…}` that used to
// be thrown verbatim, land in the error annotation, and wrap across the board's
// one-row PR slots. What an operator needs out of that payload is the `result`
// field ("…usage limit reached… resets Sep 23…") and the status code.

interface VendorEnvelope {
  result?: unknown
  error?: unknown
  api_error_status?: unknown
  is_error?: unknown
  subtype?: unknown
}

const MAX_SUMMARY_CHARS = 200

/** Collapse newlines/runs of whitespace and clamp, so the text occupies one row. */
export function oneLine(text: string, max: number = MAX_SUMMARY_CHARS): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function asEnvelope(candidate: string): VendorEnvelope | undefined {
  try {
    const parsed: unknown = JSON.parse(candidate)
    return parsed !== null && typeof parsed === 'object' ? parsed as VendorEnvelope : undefined
  } catch {
    return undefined
  }
}

// The envelope inside `text`. Whole `{…}` lines are tried first (the CLIs emit
// one object per line under `--output-format json`, and a `stream-json` run
// emits several — the last one is the result), then the span from the first `{`
// to the last `}` for output that shares a line with other text.
function parseEmbeddedJson(text: string): VendorEnvelope | undefined {
  const lines = text.split('\n').map(l => l.trim()).filter(l => l.startsWith('{') && l.endsWith('}'))
  for (let i = lines.length - 1; i >= 0; i--) {
    const envelope = asEnvelope(lines[i])
    if (envelope) return envelope
  }

  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  return start !== -1 && end > start ? asEnvelope(text.slice(start, end + 1)) : undefined
}

/**
 * The human-readable reason out of a vendor CLI's JSON output, or undefined when
 * `text` carries no envelope. The status code is kept in the line because the
 * error classifiers (`isSubscriptionLimitError`) match on `429`.
 */
export function summarizeVendorJson(text: string | undefined): string | undefined {
  if (!text || !text.includes('{')) return undefined
  const envelope = parseEmbeddedJson(text)
  if (!envelope) return undefined

  const detail = [envelope.result, envelope.error]
    .find((v): v is string => typeof v === 'string' && v.trim().length > 0)
  const status = typeof envelope.api_error_status === 'number' || typeof envelope.api_error_status === 'string'
    ? String(envelope.api_error_status)
    : undefined

  if (detail === undefined) {
    // An envelope that says it failed but names no reason still beats the raw
    // dump: report the status / subtype it does carry.
    if (envelope.is_error !== true) return undefined
    const subtype = typeof envelope.subtype === 'string' ? envelope.subtype : undefined
    const parts = [status && `API error ${status}`, subtype].filter(Boolean)
    return parts.length > 0 ? oneLine(parts.join(' — ')) : undefined
  }

  const prefix = status !== undefined && !detail.includes(status) ? `API error ${status} — ` : ''
  return oneLine(prefix + detail)
}

/**
 * One line naming why a vendor CLI failed, preferring, in order: the last real
 * stderr line, the JSON envelope the CLI printed on stdout, then execa's own
 * message with the command line stripped off.
 */
export function vendorFailureSummary(
  err: { stdout?: string; stderr?: string; message?: string },
  stderrSummary?: (stderr: string) => string | undefined,
): string {
  const stderr = err.stderr?.trim() ?? ''
  if (stderr.length > 0) {
    const picked = stderrSummary
      ? stderrSummary(stderr)
      : stderr.split('\n').map(l => l.trim()).filter(Boolean).at(-1)
    if (picked) return oneLine(picked)
  }

  const fromStdout = summarizeVendorJson(err.stdout)
  if (fromStdout) return fromStdout

  const message = err.message ?? ''
  // execa's message is "Command failed with exit code N: <argv>\n\n<output>".
  // The output half is where the envelope is; the argv half is never useful.
  const fromMessage = summarizeVendorJson(message.slice(message.indexOf('\n') + 1))
  if (fromMessage) return fromMessage

  const firstLine = message.split('\n').map(l => l.trim()).find(Boolean)
  return firstLine ? oneLine(firstLine) : 'unknown error'
}
