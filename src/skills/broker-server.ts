import { createInterface } from 'readline'
import { handleSkillBrokerRequest, type McpRequest, type McpResponse } from './broker.js'

function parseSessionPath(argv: string[]): string {
  const index = argv.indexOf('--session')
  if (index === -1 || !argv[index + 1]) throw new Error('--session <path> is required')
  return argv[index + 1]
}

function protocolError(id: string | number | null, code: number, message: string): McpResponse {
  return { jsonrpc: '2.0', id, error: { code, message } }
}

export async function runSkillBrokerServer(sessionPath: string): Promise<void> {
  const lines = createInterface({ input: process.stdin, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let response: McpResponse | null
    try {
      const request = JSON.parse(line) as McpRequest
      response = handleSkillBrokerRequest(sessionPath, request)
    } catch (err: unknown) {
      response = protocolError(null, -32700, err instanceof Error ? err.message : String(err))
    }
    if (response) process.stdout.write(`${JSON.stringify(response)}\n`)
  }
}

await runSkillBrokerServer(parseSessionPath(process.argv.slice(2)))
