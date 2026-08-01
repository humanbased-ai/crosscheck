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

export interface SignatureVars {
  actor: string
  product: string
  /** Reviewer model, e.g. `claude-opus-4.5`. Absent at auth-resolution time. */
  model?: string
  /** Reviewing vendor, e.g. `codex`. */
  reviewer?: string
  /** Pre-rendered markdown image, or '' when no icon is configured. */
  icon?: string
}

// Renders the signature template. Unknown placeholders are left alone; known ones
// with no value resolve to empty, and the leftover punctuation is tidied so a
// template like `🤖 {icon} {actor} · {product} · {model}` still reads correctly
// when icon and model are unset.
export function renderSignature(template: string, vars: SignatureVars): string {
  const values: Record<string, string> = {
    actor: vars.actor,
    product: vars.product,
    model: vars.model ?? '',
    reviewer: vars.reviewer ?? '',
    icon: vars.icon ?? '',
  }
  const substituted = template.replace(
    /\{(actor|product|model|reviewer|icon)\}/g,
    (_match, key: string) => values[key],
  )
  return tidySeparators(substituted)
}

// Collapses the gaps an empty placeholder leaves behind: doubled separators,
// and a separator stranded at either end.
function tidySeparators(text: string): string {
  return text
    .replace(/[ \t]+/g, ' ')
    // Deliberately excludes `-`: model names like claude-opus-4.5 must survive intact.
    .replace(/(·|—|\|)(\s*\1)+/g, '$1')
    .replace(/\s*(·|—|\|)\s*(?=(·|—|\|))/g, '')
    .replace(/^\s*(·|—|\||\s)+/, '')
    .replace(/(\s*(·|—|\|))+\s*$/, '')
    .trim()
}

/** Wraps a configured icon URL as inline markdown, or '' when unset. */
export function renderIcon(iconUrl: string): string {
  const trimmed = iconUrl.trim()
  return trimmed ? `![](${trimmed})` : ''
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
    // Network-level failure. The message comes from fetch and carries no credential.
    throw new Error(`Linear token mint failed: ${err instanceof Error ? err.message : String(err)}`)
  }

  const text = await response.text()
  if (!response.ok) {
    throw new Error(`Linear token mint rejected (HTTP ${response.status})`)
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
  const signature = renderSignature(template, { actor, product })

  if (config.auth.mode === 'client_credentials') {
    const missing: string[] = []
    if (!creds.clientId) missing.push(config.auth.client_id_env)
    if (!creds.clientSecret) missing.push(config.auth.client_secret_env)
    if (missing.length > 0) {
      // Abort rather than fall back — see the module header.
      throw new Error(
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
      throw new Error(
        `Linear client_credentials token mint failed — aborting rather than falling back ` +
        `to an API key (that would attribute agent writes to a human). ` +
        `${err instanceof Error ? err.message : String(err)}`,
      )
    }

    return {
      mode: 'client_credentials', token, bearer: true, actor, signature,
      createAsUser: actor, signatureTemplate: template, product,
    }
  }

  if (!creds.apiKey) {
    throw new Error(
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
    signature: renderSignature(auth.signatureTemplate, { actor, product: auth.product }),
    ...(auth.createAsUser !== undefined && { createAsUser: actor }),
  }
}
