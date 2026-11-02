import { createHash } from 'crypto'
import { readFileSync } from 'fs'

const CHECK_INTERVAL_MS = 10_000

// Contents, not mtime: a `touch` changes nothing a restart would pick up, and
// reverting an edit should clear the warning. Null covers no file and an unreadable
// one alike — neither is what the session loaded, and a daemon's timer must not die
// over a file the operator is in the middle of replacing.
export function configFingerprint(path: string | null): string | null {
  if (path === null) return null
  try {
    return createHash('sha256').update(readFileSync(path)).digest('hex')
  } catch {
    return null
  }
}

/**
 * `watch` reads its config once, and most of it is spent at startup on webhooks, the
 * tunnel and the board, so an edit does nothing until a restart — and nothing says so.
 * Reports each transition between "the file matches this session" and "it does not".
 * Returns the function that stops the checks.
 */
export function watchConfigDrift(params: {
  /** What configFingerprint returned when this session loaded its config. */
  loaded: string | null
  /** Resolved on every check: a higher-priority config file may appear later. */
  resolvePath: () => string | null
  onChange: (drifted: boolean) => void
  intervalMs?: number
}): () => void {
  let drifted = false
  const timer = setInterval(() => {
    const now = configFingerprint(params.resolvePath()) !== params.loaded
    if (now === drifted) return
    drifted = now
    params.onChange(drifted)
  }, params.intervalMs ?? CHECK_INTERVAL_MS)
  return () => clearInterval(timer)
}
