import chalk from 'chalk'
import { getOrgMembership, getTokenScopes } from '../github/client.js'
import { log as fileLog } from './logger.js'

export type WebhookFailureReason =
  | 'creds'
  | 'scope'
  | 'not-org-member'
  | 'not-org-owner'
  | 'org-access-unverified'
  | `other:${string}`

// What a classic token needs before /user/memberships/orgs answers truthfully.
const ORG_READ_SCOPES = ['read:org', 'write:org', 'admin:org']

// GitHub answers 404 on an org's hooks for every kind of "you may not": a token
// without admin:org_hook, an account outside the org, and a member who is not an
// owner. Only the first is fixed by refreshing the token, so asking for that scope on
// every 404 sends someone who already has it in a circle.
async function diagnoseOrgWebhook404(org: string, token: string, msg: string): Promise<WebhookFailureReason> {
  try {
    const scopes = await getTokenScopes(token)
    if (scopes !== null && !scopes.includes('admin:org_hook')) return 'scope'
    // Fine-grained and App tokens report no classic scopes, and a token that cannot
    // read memberships gets a 404 for orgs it does belong to. Neither can tell a
    // non-member from a member, so neither may claim to.
    if (scopes === null || !scopes.some(scope => ORG_READ_SCOPES.includes(scope))) return 'org-access-unverified'
    const membership = await getOrgMembership(org, token)
    if (membership === 'none') return 'not-org-member'
    if (membership === 'member') return 'not-org-owner'
    return `other:${msg}`
  } catch (err) {
    // The original failure is still worth reporting without a diagnosis.
    fileLog({ level: 'warn', event: 'webhook_diagnosis_failed', scope: org, message: err instanceof Error ? err.message : String(err) })
    return `other:${msg}`
  }
}

/** Groups a webhook registration failure by what would fix it. `org` is null for a repo hook. */
export async function webhookFailureReason(msg: string, org: string | null, token: string): Promise<WebhookFailureReason> {
  if (/bad credentials|\[401\]/i.test(msg)) return 'creds'
  if (/admin:org|write:org|forbidden|\[403\]|must have admin|resource not accessible/i.test(msg)) return 'scope'
  if (org !== null && /\[404\]/.test(msg)) return diagnoseOrgWebhook404(org, token, msg)
  return `other:${msg}`
}

export function webhookFailureHint(reason: WebhookFailureReason, msg: string, login: string | null): string {
  const account = login ?? 'this account'
  switch (reason) {
    case 'creds':
      return `token invalid — run: ${chalk.cyan('gh auth refresh')}`
    case 'scope':
      return `missing scope — run: ${chalk.cyan('gh auth refresh -s admin:org_hook')}`
    case 'not-org-member':
      return `${account} is not a member of the org — ask an owner to install the webhook, or remove the org from ${chalk.cyan('orgs')} in your config`
    case 'not-org-owner':
      return `${account} is a member but not an owner of the org, and org webhooks need an owner — ask one to install it, or list your repos under ${chalk.cyan('repos')} in your config`
    case 'org-access-unverified':
      return `GitHub returned 404 and this token cannot show whether ${account} belongs to the org — org webhooks need an org owner, with the ${chalk.cyan('admin:org_hook')} scope or the organization webhooks permission`
    default:
      return msg
  }
}
