// Authors declare which coding agent wrote a PR in a "Generated with ..."
// footer. Newer agents also declare the model and reasoning effort there, e.g.:
//
//   Generated with [OpenCode](https://opencode.ai) (opencode/deepseek-v4.1-flash-free · high effort)
//
// Crosscheck cannot infer either from the diff or the git metadata, so it reads
// the declaration when present and shows it on the comments it posts. The
// parser is deliberately tolerant: an absent parenthetical is still a valid
// author declaration, and unknown text is ignored rather than guessed at.
import type { Vendor } from './vendor.js'

export interface AuthorAttribution {
  vendor: Vendor
  /** Model ID exactly as the author declared it. */
  model?: string
  /** Reasoning effort exactly as the author declared it. */
  effort?: string
}

const EFFORT_LEVELS = ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'] as const
const EFFORT_RE = new RegExp(`^(${EFFORT_LEVELS.join('|')})(?:\\s+effort)?$`, 'i')

function vendorFromLabel(label: string): Vendor | null {
  // OpenCode first: "OpenCode" also contains "code", and checking codex first
  // would not match it, but keeping the most specific label first documents the
  // precedence for future vendor names.
  if (/open\s*code/i.test(label)) return 'opencode'
  if (/claude/i.test(label)) return 'claude'
  if (/codex/i.test(label)) return 'codex'
  return null
}

// Splits `model · effort`, `model, effort`, or `model | high effort` into its
// parts. Model IDs can contain dots, dashes, slashes and hashes; effort is the
// only token drawn from a closed vocabulary.
function splitRunDetail(detail: string | undefined): { model?: string; effort?: string } {
  if (!detail) return {}
  const parts = detail.split(/\s*(?:·|\||,)\s*/).map(part => part.trim()).filter(Boolean)
  const modelParts: string[] = []
  let effort: string | undefined
  for (const part of parts) {
    const match = EFFORT_RE.exec(part)
    if (match) {
      effort = match[1].toLowerCase()
      continue
    }
    modelParts.push(part)
  }
  const model = modelParts.join(' · ') || undefined
  return {
    ...(model && { model }),
    ...(effort && { effort }),
  }
}

// Two alternatives because the label is either a markdown link or plain text.
// The plain form is anchored to the end of its line so a lazy label cannot stop
// at the first character; the linked form needs no anchor because the closing
// parenthesis delimits it.
const LINKED_FOOTER_RE = /Generated with\s+\[([^\]]+)\]\([^)]*\)(?:\s*\(([^)]*)\))?/gi
const PLAIN_FOOTER_RE = /Generated with\s+([^\n([]+?)\s*(?:\(([^)]*)\))?\s*(?=\n|$)/gi

export function parseAuthorAttribution(text: string): AuthorAttribution | null {
  if (!text) return null
  const candidates: Array<{ label: string; detail?: string }> = []
  for (const match of text.matchAll(LINKED_FOOTER_RE)) {
    candidates.push({ label: match[1], detail: match[2] })
  }
  for (const match of text.matchAll(PLAIN_FOOTER_RE)) {
    candidates.push({ label: match[1], detail: match[2] })
  }
  for (const { label, detail } of candidates) {
    const vendor = vendorFromLabel(label)
    if (!vendor) continue
    return { vendor, ...splitRunDetail(detail) }
  }
  return null
}
