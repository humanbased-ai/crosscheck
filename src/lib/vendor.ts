export type Vendor = 'claude' | 'codex' | 'opencode'

const CLAUDE_ALIASES = new Set(['claude', 'claude-code', 'claudecode', 'cc', 'anthropic'])
const CODEX_ALIASES = new Set(['codex', 'openai'])
const OPENCODE_ALIASES = new Set(['opencode', 'open-code', 'oc'])

export function normalizeVendor(value: string | undefined): Vendor | null {
  if (!value) return null
  const normalized = value.toLowerCase().replace(/[_\s]/g, '-')
  if (CLAUDE_ALIASES.has(normalized)) return 'claude'
  if (CODEX_ALIASES.has(normalized)) return 'codex'
  if (OPENCODE_ALIASES.has(normalized)) return 'opencode'
  return null
}

export const VENDOR_ALIAS_HINT = 'claude (aliases: claude-code, cc, anthropic) | codex (aliases: openai) | opencode (aliases: open-code, oc)'

// The product name a vendor is credited under in anything a human reads —
// commit subjects and the attribution footer. One definition, so a commit
// cannot end up crediting one vendor while its own trailers name the other.
export function vendorDisplayName(vendor: Vendor): string {
  switch (vendor) {
    case 'codex':
      return 'OpenAI Codex'
    case 'opencode':
      return 'OpenCode'
    default:
      return 'Claude Code'
  }
}
