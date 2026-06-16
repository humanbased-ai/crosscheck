// Parses an ad-hoc PR "spec" into a concrete list of PR references.
//
// A spec is a comma-separated list of tokens. Each token is either:
//   - a full PR URL:  https://github.com/owner/repo/pull/123  (scheme optional)
//   - a bare number:  123      (inherits owner/repo from the preceding URL token)
//   - a range:        123-130  (inclusive; works in a URL tail or as a bare token)
//
// Examples:
//   https://github.com/acme/web/pull/245,255
//     -> acme/web#245, acme/web#255
//   https://github.com/acme/web/pull/245-247
//     -> acme/web#245, acme/web#246, acme/web#247
//   https://github.com/acme/web/pull/245,https://github.com/other/api/pull/210
//     -> acme/web#245, other/api#210
//
// The first token must establish a repository (a full URL); a bare number with no
// preceding URL is an error because the repository is unknown.

export interface PRRef {
  owner: string
  repo: string
  number: number
  /** Canonical https URL for the PR. */
  url: string
}

export interface ParsePRSpecOptions {
  /** Hard cap on the number of PRs a single spec may expand to. */
  maxPRs?: number
}

export const DEFAULT_MAX_PRS = 100

// Full-URL token: optional scheme, github.com host, owner/repo, /pull/<numspec>.
// Anything trailing (e.g. /files, query string) is ignored.
const URL_TOKEN_RE = /^(?:https?:\/\/)?github\.com\/([^/\s]+)\/([^/\s]+)\/pull\/(\d+(?:-\d+)?)\b/i
// Bare numeric token: a single number or an inclusive range.
const NUM_TOKEN_RE = /^\d+(?:-\d+)?$/

function expandNumspec(numspec: string, maxPRs: number): number[] {
  const range = numspec.match(/^(\d+)-(\d+)$/)
  if (!range) return [parseInt(numspec, 10)]

  const start = parseInt(range[1], 10)
  const end = parseInt(range[2], 10)
  if (end < start) {
    throw new Error(`Invalid PR range "${numspec}": end (${end}) is before start (${start}).`)
  }
  if (end - start + 1 > maxPRs) {
    throw new Error(`PR range "${numspec}" expands to ${end - start + 1} PRs (>${maxPRs}). Narrow the range or split into multiple commands.`)
  }
  const out: number[] = []
  for (let n = start; n <= end; n++) out.push(n)
  return out
}

export function parsePRSpec(spec: string, options: ParsePRSpecOptions = {}): PRRef[] {
  const maxPRs = options.maxPRs ?? DEFAULT_MAX_PRS
  const tokens = spec.split(',').map(t => t.trim()).filter(t => t.length > 0)
  if (tokens.length === 0) {
    throw new Error('No PR reference provided. Expected a PR URL like https://github.com/owner/repo/pull/123')
  }

  let base: { owner: string; repo: string } | null = null
  const refs: PRRef[] = []
  const seen = new Set<string>()

  for (const token of tokens) {
    let owner: string
    let repo: string
    let numspec: string

    const urlMatch = token.match(URL_TOKEN_RE)
    if (urlMatch) {
      owner = urlMatch[1]
      repo = urlMatch[2]
      numspec = urlMatch[3]
      base = { owner, repo }
    } else if (NUM_TOKEN_RE.test(token)) {
      if (!base) {
        throw new Error(`"${token}" is a bare PR number but no repository is known yet. Put a full PR URL first, e.g. https://github.com/owner/repo/pull/${token}`)
      }
      owner = base.owner
      repo = base.repo
      numspec = token
    } else {
      throw new Error(`Invalid PR reference "${token}". Expected a PR URL (https://github.com/owner/repo/pull/123), a number (123), or a range (123-130).`)
    }

    for (const number of expandNumspec(numspec, maxPRs)) {
      const key = `${owner}/${repo}#${number}`
      if (seen.has(key)) continue
      seen.add(key)
      refs.push({ owner, repo, number, url: `https://github.com/${owner}/${repo}/pull/${number}` })
      if (refs.length > maxPRs) {
        throw new Error(`Too many PRs requested (>${maxPRs}). Narrow the ranges or split into multiple commands.`)
      }
    }
  }

  return refs
}
