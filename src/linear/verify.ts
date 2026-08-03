// Answers the one question a deployment cutover needs answered (IN-2271):
// when this daemon writes to Linear, whose name is on it?
//
// The acceptance criterion for switching Humanbased's deployments to the HB Agent
// Gateway is "zero writes from symphony/crosscheck attribute to a human account".
// That is checkable ahead of time — resolve the identity, confirm the token is
// accepted, and report what the write would render as.
//
// Never throws. A verification that fails is a report with ok: false, because the
// caller is a status command that must still print the rest of its output.

import { resolveLinearAuth, type LinearAuthMode, type LinearCredentials, type ResolveOptions, type ResolvedLinearAuth } from './identity.js'
import { linearGraphQL, type LinearRequestOptions } from './client.js'
import type { LinearConfig } from '../config/schema.js'

export interface LinearIdentityReport {
  ok: boolean
  mode: LinearAuthMode
  /** Actor name writes will carry, including any per-step suffix the caller applies. */
  actor: string
  organization?: string
  /**
   * 'app'  — writes render as the OAuth application (botActor). The goal state.
   * 'user' — writes attribute to a human account. What IN-2271 is eliminating.
   */
  attribution: 'app' | 'user'
  /** In api_key mode, the human account writes currently attribute to. */
  attributesTo?: string
  /** Populated when ok is false. Never contains credential material. */
  error?: string
  /**
   * The identity this probe resolved, so callers can reuse it instead of minting
   * a second token. Absent when resolution failed.
   */
  auth?: ResolvedLinearAuth
}

const ORG_QUERY = `query { organization { name } }`
const VIEWER_QUERY = `query { viewer { name email } organization { name } }`

interface OrgResponse { organization: { name: string } | null }
interface ViewerResponse extends OrgResponse { viewer: { name: string | null; email: string | null } | null }

export async function verifyLinearIdentity(
  config: LinearConfig,
  creds: LinearCredentials,
  opts: ResolveOptions & LinearRequestOptions = {},
): Promise<LinearIdentityReport> {
  const mode = config.auth.mode
  const attribution = mode === 'client_credentials' ? 'app' : 'user'

  let auth
  try {
    auth = await resolveLinearAuth(config, creds, opts)
  } catch (err: unknown) {
    return {
      ok: false,
      mode,
      actor: config.identity.actor,
      attribution,
      error: err instanceof Error ? err.message : String(err),
    }
  }

  try {
    if (auth.mode === 'client_credentials') {
      // An app token has no viewer — it acts as itself. Reaching the org at all is
      // proof the minted token is accepted.
      const data = await linearGraphQL<OrgResponse>(auth, ORG_QUERY, {}, opts)
      return {
        ok: true,
        mode: auth.mode,
        actor: auth.actor,
        attribution: 'app',
        auth,
        ...(data.organization && { organization: data.organization.name }),
      }
    }

    const data = await linearGraphQL<ViewerResponse>(auth, VIEWER_QUERY, {}, opts)
    const who = data.viewer?.email ?? data.viewer?.name ?? undefined
    return {
      ok: true,
      mode: auth.mode,
      actor: auth.actor,
      attribution: 'user',
      auth,
      ...(data.organization && { organization: data.organization.name }),
      ...(who && { attributesTo: who }),
    }
  } catch (err: unknown) {
    return {
      ok: false,
      mode: auth.mode,
      actor: auth.actor,
      attribution,
      error: err instanceof Error ? err.message : String(err),
    }
  }
}
