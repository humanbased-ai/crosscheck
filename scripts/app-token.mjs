#!/usr/bin/env node
/**
 * Mint a GitHub App installation token and print it.
 *
 * Why this exists: `ck watch` posts review verdicts, and on `main` the hotfix
 * autopilot is in `autonomous` mode — so the account that posts decides whether
 * the verdict is trusted. Today that account is a person's; anything holding
 * that login can post an APPROVE (IN-7752 Revision 6.1). This mints a token for
 * the App instead, and `src/config/loader.ts` prefers it over the keyring.
 *
 * Usage (short run):
 *   CROSSCHECK_APP_TOKEN=$(node scripts/app-token.mjs) ck watch ...
 *
 * Usage (long run — the token expires in an hour, so re-mint into a file):
 *   node scripts/app-token.mjs --file ~/.config/hb/crosscheck-review.token \
 *        --refresh 2400 &
 *   CROSSCHECK_APP_TOKEN_FILE=~/.config/hb/crosscheck-review.token ck watch ...
 *
 * Credentials (no default: this repo is used by more than one deployment):
 *   CROSSCHECK_APP_ID             the App's numeric id
 *   CROSSCHECK_APP_KEY_PATH       path to the App's private key (.pem)
 *   CROSSCHECK_APP_INSTALLATION   optional; installation id, else discovered
 *                                 from --repo `<owner>/<name>`
 *
 * Signing uses `node:crypto` only — no new dependency for one RS256 JWT.
 */
import { createSign } from 'node:crypto'
import { readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const API = process.env.GITHUB_API_URL || 'https://api.github.com'
const USER_AGENT = 'crosscheck-app-token'

function fail(message) {
  console.error(`✗ ${message}`)
  process.exit(1)
}

function arg(name, fallback = undefined) {
  const i = process.argv.indexOf(`--${name}`)
  if (i === -1) return fallback
  const value = process.argv[i + 1]
  if (!value || value.startsWith('--')) fail(`--${name} needs a value`)
  return value
}

function base64url(input) {
  return Buffer.from(input).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')
}

function jwtFor(appId, privateKey) {
  const now = Math.floor(Date.now() / 1000)
  // 60s in the past absorbs clock skew; GitHub rejects anything over 10 minutes.
  const header = { alg: 'RS256', typ: 'JWT' }
  const payload = { iat: now - 60, exp: now + 540, iss: String(appId) }
  const body = `${base64url(JSON.stringify(header))}.${base64url(JSON.stringify(payload))}`
  const signer = createSign('RSA-SHA256')
  signer.update(body)
  signer.end()
  return `${body}.${signer.sign(privateKey).toString('base64').replace(/=/g, '').replace(/\+/g, '-').replace(/\//g, '_')}`
}

async function call(path, jwt, init = {}) {
  const res = await fetch(`${API}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${jwt}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': USER_AGENT,
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  if (!res.ok) fail(`${init.method || 'GET'} ${path} → HTTP ${res.status}: ${text.slice(0, 300)}`)
  return text ? JSON.parse(text) : {}
}

async function installationId(jwt, explicit, repo) {
  if (explicit) return explicit
  if (!repo || !repo.includes('/')) {
    fail('need --installation <id>, or --repo <owner>/<name> to discover it')
  }
  const installations = await call('/app/installations', jwt)
  const match = installations.find((i) => (i.account?.login || '').toLowerCase() === repo.split('/')[0].toLowerCase())
  if (!match) {
    fail(`this App is not installed on ${repo.split('/')[0]}; install it first (Settings → Applications → ${repo})`)
  }
  return match.id
}

async function main() {
  const appId = arg('app-id', process.env.CROSSCHECK_APP_ID)
  const keyPath = arg('key', process.env.CROSSCHECK_APP_KEY_PATH || join(homedir(), '.config', 'hb', 'crosscheck-review.pem'))
  const repo = arg('repo', process.env.CROSSCHECK_APP_REPO)
  const file = arg('file')
  const refreshSeconds = Number(arg('refresh', '0'))

  if (!appId) fail('set CROSSCHECK_APP_ID (the App id) or pass --app-id')
  let privateKey
  try {
    privateKey = readFileSync(keyPath, 'utf8')
  } catch (err) {
    fail(`cannot read the App private key at ${keyPath}: ${err.message}`)
  }

  const mint = async () => {
    const jwt = jwtFor(appId, privateKey)
    const id = await installationId(jwt, arg('installation', process.env.CROSSCHECK_APP_INSTALLATION), repo)
    const { token } = await call(`/app/installations/${id}/access_tokens`, jwt, { method: 'POST' })
    const identity = await call('/app', jwt)
    return { token, installation: id, app: identity.slug }
  }

  const write = async () => {
    const out = await mint()
    if (file) {
      writeFileSync(file, `${out.token}\n`, { mode: 0o600 })
      try { chmodSync(file, 0o600) } catch { /* windows */ }
      console.error(`✓ minted installation ${out.installation} for ${out.app} → ${file}`)
    }
    if (!file || process.argv.includes('--print')) {
      process.stdout.write(`${out.token}\n`)
    }
    return out
  }

  const first = await write()
  if (!refreshSeconds || refreshSeconds < 60) {
    if (file) console.error('  (no --refresh: the file is not updated again; tokens last ~1h)')
    return
  }

  // Installation tokens last an hour. Re-mint well before that, because a daemon
  // that discovers expiry by failing posts no verdict at all — which on `main`
  // reads as "review never happened", not as "auth expired".
  for (;;) {
    await new Promise((r) => setTimeout(r, refreshSeconds * 1000))
    try {
      await write()
    } catch (err) {
      console.error(`✗ refresh failed, keeping the previous token: ${err.message || err}`)
    }
  }
  void first
}

main().catch((err) => fail(err?.stack || String(err)))
