import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'http'
import { createWebhookServer, type IssueCommentEvent, type PREvent } from '../github/webhook.js'

// Minimal config stub
const config = { server: { webhook_path: '/webhook', port: 0 } } as Parameters<typeof createWebhookServer>[0]
const secret = 'test-secret'

async function postWebhook(
  server: ReturnType<typeof createServer>,
  eventHeader: string,
  body: unknown,
  signature = 'sha256=ignored',
): Promise<number> {
  const port = (server.address() as { port: number }).port
  const raw = JSON.stringify(body)
  const res = await fetch(`http://localhost:${port}/webhook`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-github-event': eventHeader,
      'x-hub-signature-256': signature,
    },
    body: raw,
  })
  return res.status
}

function startServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.listen(0, resolve))
}

function stopServer(server: ReturnType<typeof createServer>): Promise<void> {
  return new Promise(resolve => server.close(() => resolve()))
}

// Bypass signature verification for unit tests
vi.mock('../github/client.js', () => ({
  verifyWebhookSignature: () => true,
}))

const reviewComment = (prNumber: number, sha: string): IssueCommentEvent => ({
  action: 'created',
  issue: {
    number: prNumber,
    title: 'Some PR',
    user: { login: 'alice' },
    pull_request: { merged_at: null },
  },
  comment: {
    id: 1,
    body: `<!-- crosscheck: origin=claude reviewer=codex model=o4-mini type=review round=1 verdict=NEEDS_WORK service=crosscheck sha=${sha} trigger=kickass -->`,
    user: { login: 'crosscheck[bot]' },
  },
  repository: { name: 'repo', owner: { login: 'acme' } },
})

describe('createWebhookServer — issue_comment handling', () => {
  it('calls onComment for a created review annotation on an open PR', async () => {
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const status = await postWebhook(server, 'issue_comment', reviewComment(7, 'abc1234'))
      // Give setImmediate a tick to fire
      await new Promise(r => setImmediate(r))
      expect(status).toBe(200)
      expect(received).toHaveLength(1)
      expect(received[0].issue.number).toBe(7)
    } finally {
      await stopServer(server)
    }
  })

  it('calls onComment for review annotations from non-bot users (PAT installs)', async () => {
    // crosscheck posts comments as whatever GitHub user owns the token — not always [bot]
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const nonBot = { ...reviewComment(7, 'abc1234') }
      nonBot.comment = { ...nonBot.comment, user: { login: 'myorg-bot-user' } }  // no [bot] suffix
      await postWebhook(server, 'issue_comment', nonBot)
      await new Promise(r => setImmediate(r))
      expect(received).toHaveLength(1)
    } finally {
      await stopServer(server)
    }
  })

  it('ignores issue_comment events with action other than created', async () => {
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const edited = { ...reviewComment(7, 'abc1234'), action: 'edited' }
      await postWebhook(server, 'issue_comment', edited)
      await new Promise(r => setImmediate(r))
      expect(received).toHaveLength(0)
    } finally {
      await stopServer(server)
    }
  })

  it('ignores issue_comment events that are not on a PR', async () => {
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const issueComment = { ...reviewComment(7, 'abc1234') }
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      ;(issueComment.issue as any).pull_request = undefined
      await postWebhook(server, 'issue_comment', issueComment)
      await new Promise(r => setImmediate(r))
      expect(received).toHaveLength(0)
    } finally {
      await stopServer(server)
    }
  })

  it('forwards issue_comment events on merged PRs to onComment — state checked by watch handler', async () => {
    // merged_at is absent from real issue_comment payloads; webhook.ts no longer
    // attempts to check it. The watch handler verifies PR state via the REST API.
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      await postWebhook(server, 'issue_comment', reviewComment(7, 'abc1234'))
      await new Promise(r => setImmediate(r))
      // webhook.ts passes it through; watch.ts skips after fetching PR state
      expect(received).toHaveLength(1)
    } finally {
      await stopServer(server)
    }
  })

  it('ignores issue_comment events without a crosscheck review annotation', async () => {
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const plain = { ...reviewComment(7, 'abc1234') }
      plain.comment = { ...plain.comment, body: 'LGTM!' }
      await postWebhook(server, 'issue_comment', plain)
      await new Promise(r => setImmediate(r))
      expect(received).toHaveLength(0)
    } finally {
      await stopServer(server)
    }
  })

  it('ignores crosscheck annotations that are not type=review', async () => {
    const received: IssueCommentEvent[] = []
    const server = createWebhookServer(config, secret, () => {}, () => {}, undefined, e => received.push(e))
    await startServer(server)
    try {
      const recheck = { ...reviewComment(7, 'abc1234') }
      recheck.comment = {
        ...recheck.comment,
        body: '<!-- crosscheck: origin=claude reviewer=codex model=o4-mini type=recheck round=2 verdict=APPROVE service=crosscheck sha=abc1234 -->',
      }
      await postWebhook(server, 'issue_comment', recheck)
      await new Promise(r => setImmediate(r))
      expect(received).toHaveLength(0)
    } finally {
      await stopServer(server)
    }
  })

  it('does not call onComment when no onComment handler is provided', async () => {
    const prReceived: PREvent[] = []
    const server = createWebhookServer(config, secret, e => prReceived.push(e), () => {})
    await startServer(server)
    try {
      const status = await postWebhook(server, 'issue_comment', reviewComment(7, 'abc1234'))
      await new Promise(r => setImmediate(r))
      expect(status).toBe(200)
      expect(prReceived).toHaveLength(0)
    } finally {
      await stopServer(server)
    }
  })

  it('still routes pull_request events normally alongside issue_comment handling', async () => {
    const prReceived: PREvent[] = []
    const commentReceived: IssueCommentEvent[] = []
    const server = createWebhookServer(
      config, secret,
      e => prReceived.push(e), () => {}, undefined,
      e => commentReceived.push(e),
    )
    await startServer(server)
    try {
      const prEvent: PREvent = {
        action: 'synchronize', number: 3,
        pull_request: {
          title: 'fix', body: '', html_url: 'https://github.com/acme/repo/pull/3',
          head: { ref: 'fix', sha: 'def456', repo: { full_name: 'acme/repo' } },
          base: { ref: 'main', repo: { full_name: 'acme/repo' } },
          user: { login: 'bob' },
        },
        repository: { name: 'repo', owner: { login: 'acme' }, clone_url: '' },
      }
      await postWebhook(server, 'pull_request', prEvent)
      await postWebhook(server, 'issue_comment', reviewComment(7, 'abc1234'))
      await new Promise(r => setImmediate(r))
      expect(prReceived).toHaveLength(1)
      expect(commentReceived).toHaveLength(1)
    } finally {
      await stopServer(server)
    }
  })
})
