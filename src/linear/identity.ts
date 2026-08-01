// Tiered Linear identity (IN-2267 / IN-2269).
//
//   T0 api_key            — operator supplies a personal/workspace key. Writes carry a
//                           `🤖 {actor} · {product}` signature line. Works everywhere,
//                           weakest attribution.
//   T1 client_credentials — operator creates an OAuth app in their own workspace and
//                           enables the Client credentials toggle. We mint a Bearer app
//                           token per run and pass `createAsUser` on every write, so
//                           Linear renders them as the app (botActor), not a human.
//
// Hard requirements this module enforces:
//   * Secrets travel in a POST body — never on argv, never in a URL, never logged.
//   * A configured-but-failing T1 mint ABORTS. It must never silently downgrade to
//     api_key, because that would re-attribute agent writes to a human account.

import type { LinearConfig } from '../config/schema.js'

const TOKEN_ENDPOINT = 'https://api.linear.app/oauth/token'

/** Injectable fetch, so tests never touch the network. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>

export type LinearAuthMode = 'api_key' | 'client_credentials'

/** Credentials read from the environment. Resolved in config/loader.ts — never here. */
export interface LinearCredentials {
  apiKey?: string
  clientId?: string
  clientSecret?: string
}

export interface ResolvedLinearAuth {
  mode: LinearAuthMode
  /** Bare API key (T0) or minted app token (T1). Never log this. */
  token: string
  /** T1 tokens need an `Authorization: Bearer` prefix; T0 keys are sent bare. */
  bearer: boolean
  actor: string
  /** Rendered `🤖 {actor} · {product}` line. Leads every write in both tiers. */
  signature: string
  /** Set in T1 only — Linear attributes the write to this display name. */
  createAsUser?: string
  /** Retained so withWorker() can re-render the signature for a derived actor. */
  signatureTemplate: string
  product: string
}

export interface MintOptions {
  fetchImpl?: FetchLike
}

export interface ResolveOptions extends MintOptions {
  /** Product name used in the signature template. */
  product?: string
}

const DEFAULT_PRODUCT = 'crosscheck'

// Misconfiguration (missing env var, rejected credentials) is a user error, so it
// must surface as exit 1 — the CLI contract reserves 2 for unexpected failures.
// commands/review.ts already exits 1 here; the workflow path has to agree.
export class LinearConfigError extends Error {
  readonly userError = true
  constructor(message: string) {
    super(message)
    this.name = 'LinearConfigError'
  }
}

export function isLinearConfigError(err: unknown): boolean {
  return err instanceof LinearConfigError
}

export function renderSignature(template: string, actor: string, product: string): string {
  return template.replaceAll('{actor}', actor).replaceAll('{product}', product)
}

// Linear's token endpoint documents scope as a COMMA-separated list, but OAuth 2.0
// itself specifies space-separated, so operators write it both ways. Accept either
// and always send commas.
export function normalizeScopes(scopes: string): string {
  return scopes.split(/[\s,]+/).filter(Boolean).join(',')
}

export async function mintAppToken(
  creds: { clientId: string; clientSecret: string; scopes: string },
  opts: MintOptions = {},
): Promise<string> {
  const doFetch = opts.fetchImpl ?? (globalThis.fetch as FetchLike)

  // URLSearchParams keeps the secret in the request body. Nothing here reaches argv.
  const body = new URLSearchParams({
    grant_type: 'client_credentials',
    client_id: creds.clientId,
    client_secret: creds.clientSecret,
    scope: normalizeScopes(creds.scopes),
  })

  let response: Response
  try {
    response = await doFetch(TOKEN_ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    })
  } catch (err: unknown) {
    // Transport failure — Linear is unreachable. Not a configuration problem, so
    // this stays a plain Error and classifies as an unexpected failure (exit 2).
    throw new Error(`Linear token mint failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    // 4xx means Linear rejected these credentials or scopes — the operator can fix
    // that. 5xx is an outage, and 429 is rate limiting: both are transient and must
    // not be blamed on the config.
    const message = `Linear token mint rejected (HTTP ${response.status})`
    const transient = response.status >= 500 || response.status === 429
    throw transient ? new Error(message) : new LinearConfigError(message)
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    throw new Error(`Linear token mint returned a non-JSON response (HTTP ${response.status})`)
  }

  const token = (parsed as { access_token?: unknown }).access_token
  if (typeof token !== 'string' || token.length === 0) {
    throw new Error('Linear token mint returned no access_token')
  }
  return token
}

export async function resolveLinearAuth(
  config: LinearConfig,
  creds: LinearCredentials,
  opts: ResolveOptions = {},
): Promise<ResolvedLinearAuth> {
  const product = opts.product ?? DEFAULT_PRODUCT
  const { actor, signature: template } = config.identity
  const signature = renderSignature(template, actor, product)

  if (config.auth.mode === 'client_credentials') {
    const missing: string[] = []
    if (!creds.clientId) missing.push(config.auth.client_id_env)
    if (!creds.clientSecret) missing.push(config.auth.client_secret_env)
    if (missing.length > 0) {
      // Abort rather than fall back — see the module header.
      throw new LinearConfigError(
        `Linear auth mode is client_credentials but ${missing.join(' and ')} ` +
        `${missing.length > 1 ? 'are' : 'is'} not set. ` +
        'Set them, or switch linear.auth.mode to api_key.',
      )
    }

    let token: string
    try {
      token = await mintAppToken(
        { clientId: creds.clientId!, clientSecret: creds.clientSecret!, scopes: config.auth.scopes },
        opts,
      )
    } catch (err: unknown) {
      // Preserve the classification the mint chose: a rejected credential stays a
      // config error (exit 1), an outage stays unexpected (exit 2). Both abort —
      // neither falls back to api_key.
      // Name the variables to check. A bare "HTTP 401" leaves an operator with
      // custom env names guessing which credential to rotate. Names only — never
      // the values.
      const message =
        `Linear client_credentials token mint failed — aborting rather than falling back ` +
        `to an API key (that would attribute agent writes to a human). ` +
        `Check ${config.auth.client_id_env} and ${config.auth.client_secret_env}. ` +
        `${err instanceof Error ? err.message : String(err)}`
      throw isLinearConfigError(err) ? new LinearConfigError(message) : new Error(message)
    }

    return {
      mode: 'client_credentials', token, bearer: true, actor, signature,
      createAsUser: actor, signatureTemplate: template, product,
    }
  }

  if (!creds.apiKey) {
    throw new LinearConfigError(
      `Linear is enabled but ${config.auth.api_key_env} is not set. ` +
      `Set it, or disable the linear block in your config.`,
    )
  }

  return {
    mode: 'api_key', token: creds.apiKey, bearer: false, actor, signature,
    signatureTemplate: template, product,
  }
}

// Derives a step-scoped identity: `crosscheck` → `crosscheck/review`.
//
// The epic calls for per-worker display names (its example is `symphony/worker-3`)
// so a fleet of agents does not collapse into one indistinguishable bot. crosscheck's
// natural axis is the workflow step that produced the write.
//
// T1 re-points createAsUser, which is what Linear actually renders. T0 has no
// createAsUser, so the suffix only reaches the signature line — still an improvement,
// since that is T0's whole attribution mechanism.
export function withWorker(auth: ResolvedLinearAuth, worker: string): ResolvedLinearAuth {
  const trimmed = worker.trim()
  if (!trimmed) return auth

  const actor = `${auth.actor}/${trimmed}`
  return {
    ...auth,
    actor,
    signature: renderSignature(auth.signatureTemplate, actor, auth.product),
    ...(auth.createAsUser !== undefined && { createAsUser: actor }),
  }
}
