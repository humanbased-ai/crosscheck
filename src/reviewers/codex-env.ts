// The environment handed to a codex subprocess.
//
// Codex reads attacker-controlled text: the PR diff, its title and body, the
// tracker issue, review comments. With `skills.codex_full_access` the sandbox is
// off, so a prompt-injected run can execute shell commands — and until now those
// commands inherited crosscheck's entire environment, `GITHUB_TOKEN` included.
// Nothing that is not in the process can be exfiltrated from it, so the fix is
// to not put it there.
//
// Allowlist, not denylist: a denylist has to predict every secret an operator
// might export (LINEAR_API_KEY, AWS_*, a CI token, whatever the next integration
// adds), and it silently fails open on the one nobody thought of. This fails
// closed — a variable codex genuinely needs and does not get produces a loud,
// reproducible failure, which is the direction to be wrong in.

/** Exact variable names codex needs to start, authenticate, and reach the network. */
const ALLOWED_KEYS: ReadonlyArray<string> = [
  // Process basics. HOME also locates ~/.codex/auth.json — without it codex
  // cannot authenticate at all.
  'PATH', 'HOME', 'USER', 'LOGNAME', 'SHELL', 'TERM', 'TMPDIR', 'TZ', 'LANG',
  // Codex's own configuration root.
  'CODEX_HOME',
  // Keep Git commands launched by the agent on Crosscheck's isolated config view.
  'GIT_CONFIG_NOSYSTEM', 'GIT_CONFIG_GLOBAL',
  // API-key auth, for installs that use it instead of ~/.codex/auth.json.
  'OPENAI_API_KEY', 'OPENAI_BASE_URL',
  // XDG paths — codex resolves config/cache through them on Linux.
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'XDG_RUNTIME_DIR',
  // TLS trust, for corporate roots and custom CA bundles.
  'SSL_CERT_FILE', 'SSL_CERT_DIR', 'NODE_EXTRA_CA_CERTS', 'CURL_CA_BUNDLE', 'REQUESTS_CA_BUNDLE',
  // Egress proxies — without these, codex cannot reach the API on many networks.
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY',
  'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy',
]

/** Prefixes kept wholesale — locale only, which is many keys and carries nothing. */
const ALLOWED_PREFIXES: ReadonlyArray<string> = ['LC_']

export function isAllowedCodexEnvKey(key: string): boolean {
  return ALLOWED_KEYS.includes(key) || ALLOWED_PREFIXES.some(prefix => key.startsWith(prefix))
}

/**
 * Builds the env for a codex subprocess from `source` (defaults to the current
 * process), keeping only what codex needs. Pair with execa's `extendEnv: false`,
 * or execa merges `process.env` back in and undoes the whole point.
 *
 * `overrides` is applied last and is not filtered — callers use it for values
 * they are deliberately setting, such as a PATH with the repo's node_modules/.bin
 * prepended.
 */
export function buildCodexEnv(
  overrides: Record<string, string> = {},
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(source)) {
    if (value !== undefined && isAllowedCodexEnvKey(key)) env[key] = value
  }
  return { ...env, ...overrides }
}
