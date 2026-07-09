// `crosscheck serve` is being sunset in favor of `crosscheck watch` with the smee
// tunnel backend (a hosted relay that survives restarts and queues events offline),
// which covers the always-on server use case serve was built for. See prd.md
// "Sunset `crosscheck serve`". This module holds the user-facing migration copy so
// it can be unit-tested without booting the whole command.

// The exact command a serve operator should switch to.
export const SERVE_MIGRATION_COMMAND = 'crosscheck watch  (set tunnel.backend: smee in config for always-on use)'

// Plain-text lines shown at startup. Chalk styling is applied at the call site so
// this stays trivially testable.
export function serveDeprecationNotice(): string[] {
  return [
    'crosscheck serve is deprecated and will be removed in a future release.',
    `Migrate to: ${SERVE_MIGRATION_COMMAND}`,
  ]
}
