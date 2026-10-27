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

const MAX_DETAIL_PART_LENGTH = 120

// A declared model is display text taken from an untrusted PR body. Drop any
// part that carries markup or control characters rather than trying to render
// it: a newline could start a forged annotation line in the comment crosscheck
// posts, and backticks could open a fence that hides the real annotation.
function safeDetailPart(part: string): string | null {
  const trimmed = part.trim()
  if (!trimmed || trimmed.length > MAX_DETAIL_PART_LENGTH) return null
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f`<>]/.test(trimmed)) return null
  return trimmed
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
    const safe = safeDetailPart(part)
    if (safe) modelParts.push(safe)
  }
  const model = modelParts.join(' · ') || undefined
  return {
    ...(model && { model }),
    ...(effort && { effort }),
  }
}

// A declaration is a footer: the whole line, optionally preceded by the ⚡
// marker. Anchoring both ends keeps a `Generated with ...` mention embedded in
// prose from being read; limiting indentation to three spaces keeps a Markdown
// indented code example (four spaces or a tab) from passing as a footer. The
// scan below also skips fenced code blocks.
const LINKED_FOOTER_RE = /^ {0,3}(?:⚡\ufe0f?[ \t]*)?Generated with[ \t]+\[([^\]\n]+)\]\([^)\n]*\)(?:[ \t]*\(([^)\n]*)\))?[ \t]*$/
const PLAIN_FOOTER_RE = /^ {0,3}(?:⚡\ufe0f?[ \t]*)?Generated with[ \t]+([^\n([]+?)[ \t]*(?:\(([^)\n]*)\))?[ \t]*$/

export function parseAuthorAttribution(text: string): AuthorAttribution | null {
  if (!text) return null
  // Walk the body in source order and skip fenced blocks, so the first real
  // footer wins regardless of whether it uses the linked or plain form.
  let fence: { character: string; length: number } | null = null
  for (const line of text.split(/\r?\n/)) {
    const candidate = /^ {0,3}([\x60]{3,}|~{3,})(.*)$/.exec(line)
    if (fence) {
      if (
        candidate
        && candidate[1][0] === fence.character
        && candidate[1].length >= fence.length
        && /^[ \t]*$/.test(candidate[2])
      ) fence = null
      continue
    }
    if (candidate) {
      // Markdown forbids backticks in a backtick fence's info string.
      if (candidate[1][0] !== '\x60' || !candidate[2].includes('\x60')) {
        fence = { character: candidate[1][0], length: candidate[1].length }
      }
      continue
    }
    const match = LINKED_FOOTER_RE.exec(line) ?? PLAIN_FOOTER_RE.exec(line)
    if (!match) continue
    const vendor = vendorFromLabel(match[1])
    if (!vendor) continue
    return { vendor, ...splitRunDetail(match[2]) }
  }
  return null
}
