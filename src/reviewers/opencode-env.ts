// The environment handed to an opencode subprocess.
//
// Same security posture as codex-env.ts: opencode reads attacker-controlled
// text (the PR diff, title, body, tracker issue, review comments), and a
// prompt-injected run can execute shell commands. Those commands inherit
// crosscheck's environment — GITHUB_TOKEN included — unless we strip it.
//
// Allowlist, not denylist, for the same reason: a denylist has to predict every
// secret an operator might export, and fails open on the one nobody thought of.
// A variable opencode genuinely needs and does not get produces a loud,
// reproducible failure, which is the direction to be wrong in.

/** Exact variable names opencode needs to start, authenticate, and reach the network. */
const ALLOWED_KEYS: ReadonlyArray<string> = [
  // Process basics. HOME also locates ~/.config/opencode — without it opencode
  // cannot read its provider/auth configuration at all.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'LANG',
  // OpenCode's own runtime overrides (database path, log level, standalone mode).
  'OPENCODE_DB', 'OPENCODE_LOG_LEVEL',
  // Keep Git commands launched by the agent on Crosscheck's isolated config view.
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
  // XDG paths — opencode resolves config/cache through them on Linux.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // TLS trust, for corporate roots and custom CA bundles.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  // Egress proxies — without these, opencode cannot reach the API on many networks.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

/** Prefixes kept wholesale — OpenCode's own namespace, plus locale (many keys, carries nothing). */
const ALLOWED_PREFIXES: ReadonlyArray<string> = ['OPENCODE_', 'LC_']

export function isAllowedOpenCodeEnvKey(key: string): boolean {
  return ALLOWED_KEYS.includes(key) || ALLOWED_PREFIXES.some(prefix => key.startsWith(prefix))
}

/**
 * Builds the env for an opencode subprocess from `source` (defaults to the
 * current process), keeping only what opencode needs. Pair with execa's
 * `extendEnv: false`, or execa merges `process.env` back in and undoes the
 * whole point.
 *
 * `overrides` is applied last and is not filtered — callers use it for values
 * they are deliberately setting, such as a PATH with the repo's node_modules/.bin
 * prepended.
 */
export function buildOpenCodeEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedOpenCodeEnvKey(key)) env[key] = value
  }
  return { ...env, ...overrides }
}
