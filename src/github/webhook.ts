import { createServer, type IncomingMessage, type ServerResponse } from 'http'
import type { Config } from '../config/schema.js'
import { verifyWebhookSignature } from './client.js'
import { parseAnnotation } from '../lib/annotation.js'

export interface PREvent {
  action: string
  number: number
  pull_request: {
    title: string
    body: string
    head: { ref: string; sha: string; repo: { full_name: string } | null }
    // `default_branch` lets the review strategy tell a hotfix aimed at the
    // trunk from one aimed at a release branch. Optional: it is absent from
    // hand-built events in tests and from some third-party redeliveries.
    base: { ref: string; repo: { full_name: string; default_branch?: string } }
    html_url: string
    user: { login: string }
    // Present on real webhook deliveries; used by the strategy's risk class.
    labels?: Array<{ name: string }>
  }
  repository: {
    name: string
    owner: { login: string }
    clone_url: string
  }
}

export interface IssueCommentEvent {
  action: string
  issue: {
    number: number
    title: string
    user: { login: string }
    pull_request?: Record<string, unknown>  // presence indicates this is a PR, not an issue
  }
  comment: {
    id: number
    body: string
    user: { login: string }
  }
  repository: {
    name: string
    owner: { login: string }
  }
}

export interface WebhookFileLogEntry {
  level: 'info' | 'warn' | 'error'
  event: string
  [key: string]: unknown
}

export function createWebhookServer(
  config: Config,
  webhookSecret: string,
  onPR: (event: PREvent) => void,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  onLog: (msg: string) => void,
  onFileLog?: (entry: WebhookFileLogEntry) => void,
  onComment?: (event: IssueCommentEvent) => void,
) {
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const { pathname } = new URL(req.url ?? '/', `http://localhost`)

    if (pathname !== config.server.webhook_path) {
      res.writeHead(404).end()
      return
    }

    if (req.method !== 'POST') {
      res.writeHead(405).end()
      return
    }

    const chunks: Buffer[] = []
    for await (const chunk of req) chunks.push(chunk as Buffer)
    const rawBody = Buffer.concat(chunks).toString('utf8')

    const signature = req.headers['x-hub-signature-256'] as string ?? ''
    if (!verifyWebhookSignature(rawBody, signature, webhookSecret)) {
      onLog('⚠  Rejected request with invalid webhook signature')
      onFileLog?.({ level: 'warn', event: 'webhook_sig_invalid', ip: req.socket.remoteAddress })
      res.writeHead(401).end()
      return
    }

    const event = req.headers['x-github-event'] as string

    if (event === 'issue_comment' && onComment) {
      let body: IssueCommentEvent
      try {
        body = JSON.parse(rawBody) as IssueCommentEvent
      } catch {
        onFileLog?.({ level: 'error', event: 'webhook_parse_error', ip: req.socket.remoteAddress })
        res.writeHead(400).end()
        return
      }
      // Only act on newly-created comments whose body contains a crosscheck review
      // annotation — the hidden <!-- crosscheck: ... type=review --> marker is the
      // intentional automation trigger that signals watch to advance the fix step.
      // Regular human feedback (plain comments without this marker) is always welcome
      // and never reaches this handler. The concern here is specifically annotation
      // injection: a non-token account posting the hidden marker to drive automated
      // fix work. That check happens in watch.ts against the authenticated user login.
      const annotation = body.action === 'created' && body.issue.pull_request
        ? parseAnnotation(body.comment.body)
        : null
      // PR state (open vs closed/merged) is not reliably present in the
      // issue_comment payload — check it authoritatively in the watch handler
      // after fetching the PR via the REST API.
      // Only fire for kickass one-step dispatches (trigger=kickass in the annotation).
      // Full-pipeline standalone runs also post type=review annotations but they
      // handle fix themselves; the bridge would duplicate that work.
      if (annotation?.type === 'review' && annotation.trigger === 'kickass') {
        res.writeHead(200).end('ok')
        setImmediate(() => onComment(body))
      } else {
        res.writeHead(200).end('ok')
      }
      return
    }

    if (event !== 'pull_request') {
      res.writeHead(200).end('ok')
      return
    }

    let body: PREvent
    try {
      body = JSON.parse(rawBody) as PREvent
    } catch {
      onFileLog?.({ level: 'error', event: 'webhook_parse_error', ip: req.socket.remoteAddress })
      res.writeHead(400).end()
      return
    }

    if (body.action === 'opened' || body.action === 'synchronize') {
      res.writeHead(200).end('ok')
      // async — don't block the webhook response
      setImmediate(() => onPR(body))
    } else {
      res.writeHead(200).end('ok')
    }
  })

  return server
}
