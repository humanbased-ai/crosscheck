import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from 'fs'
import { join, resolve, sep } from 'path'
import { fileURLToPath } from 'url'
import { randomUUID } from 'crypto'
import { createServer, type Server, type Socket } from 'net'
import { createInterface } from 'readline'
import { tmpdir } from 'os'
import { findCompetingSkill, type SkillIdentity } from './catalog.js'

export type SkillMetadata = Omit<SkillIdentity, 'path'>

interface SkillSessionState {
  schemaVersion: 1
  stepType: string
  enabled: SkillIdentity[]
  activated: string[]
}

export interface BrokerToolResult {
  content: Array<{ type: 'text'; text: string }>
  isError?: boolean
}

export interface McpRequest {
  jsonrpc: '2.0'
  id?: string | number | null
  method: string
  params?: unknown
}

export interface McpResponse {
  jsonrpc: '2.0'
  id: string | number | null
  result?: unknown
  error?: { code: number; message: string }
}

export interface SkillActivationSession {
  path: string
  stepType: string
  enabledSkills: SkillMetadata[]
  activations(): SkillMetadata[]
  close(): void
}

const BROKER_SERVER_PATH = fileURLToPath(new URL('./broker-server.js', import.meta.url))
const BROKER_SERVER_TS_PATH = fileURLToPath(new URL('./broker-server.ts', import.meta.url))
const MAX_SKILL_FILE_BYTES = 512_000
const sessionStates = new Map<string, SkillSessionState>()
const brokerCommands = new WeakMap<SkillActivationSession, () => { command: string; args: string[] }>()

function readState(sessionPath: string): SkillSessionState {
  const state = sessionStates.get(sessionPath)
  if (!state) throw new Error('Skill session not found')
  return state
}

async function serveBrokerConnection(socket: Socket, sessionPath: string): Promise<void> {
  const lines = createInterface({ input: socket, crlfDelay: Infinity })
  for await (const line of lines) {
    if (!line.trim()) continue
    let response: McpResponse | null
    try {
      response = handleSkillBrokerRequest(sessionPath, JSON.parse(line) as McpRequest)
    } catch (err: unknown) {
      response = {
        jsonrpc: '2.0',
        id: null,
        error: { code: -32700, message: err instanceof Error ? err.message : String(err) },
      }
    }
    if (response) socket.write(`${JSON.stringify(response)}\n`)
  }
}

function createBrokerServer(
  socketPath: string,
  sessionPath: string,
  sockets: Set<Socket>,
  onError: (err: Error) => void,
  onConnection: () => void,
): Server {
  const server = createServer(socket => {
    onConnection()
    // The agent starts MCP before repository code; make its argv-visible endpoint single-use.
    server.close()
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    void serveBrokerConnection(socket, sessionPath).catch(() => socket.destroy())
  })
  server.on('error', onError)
  server.listen(socketPath)
  return server
}

function metadata(skill: SkillIdentity): SkillMetadata {
  const { path: _path, ...identity } = skill
  return identity
}

function error(message: string): BrokerToolResult {
  return { content: [{ type: 'text', text: message }], isError: true }
}

function stringArg(args: Record<string, unknown>, key: string): string | null {
  return typeof args[key] === 'string' && args[key].trim() ? args[key].trim() : null
}

export function createSkillActivationSession(
  stepType: string,
  enabledNames: string[],
  catalog: SkillIdentity[],
): SkillActivationSession {
  const enabledSet = new Set(enabledNames)
  const enabled = catalog.filter(skill => enabledSet.has(skill.name))
  const sessionDir = process.platform === 'win32' ? undefined : mkdtempSync(join(tmpdir(), 'crosscheck-skill-'))
  const path = process.platform === 'win32'
    ? `\\\\.\\pipe\\crosscheck-skill-${randomUUID()}`
    : sessionDir!
  sessionStates.set(path, { schemaVersion: 1, stepType, enabled, activated: [] })
  let listenError: Error | undefined
  const sockets = new Set<Socket>()
  const servers = new Set<Server>()
  let pendingServer: Server | undefined

  const session: SkillActivationSession = {
    path,
    stepType,
    enabledSkills: enabled.map(metadata),
    activations: () => {
      if (listenError) throw new Error(`Skill broker failed to listen: ${listenError.message}`)
      const state = readState(path)
      const activated = new Set(state.activated)
      return state.enabled.filter(skill => activated.has(skill.name)).map(metadata)
    },
    close: () => {
      sessionStates.delete(path)
      for (const socket of sockets) socket.destroy()
      for (const server of servers) server.close()
      if (sessionDir) rmSync(sessionDir, { recursive: true, force: true })
    },
  }

  brokerCommands.set(session, () => {
    if (pendingServer) {
      const staleServer = pendingServer
      if (staleServer.listening) staleServer.close()
      else staleServer.once('listening', () => staleServer.close())
    }
    const socketPath = process.platform === 'win32'
      ? `\\\\.\\pipe\\crosscheck-skill-${randomUUID()}`
      : join(sessionDir!, `${randomUUID().slice(0, 8)}.sock`)
    const server: Server = createBrokerServer(
      socketPath,
      path,
      sockets,
      err => { if (pendingServer === server) listenError = err },
      () => { if (pendingServer === server) pendingServer = undefined },
    )
    pendingServer = server
    servers.add(server)
    server.once('close', () => servers.delete(server))
    return { command: process.execPath, args: [
      ...(existsSync(BROKER_SERVER_PATH) ? [BROKER_SERVER_PATH] : ['--import', 'tsx', BROKER_SERVER_TS_PATH]),
      '--socket', socketPath,
    ] }
  })

  return session
}

export function skillBrokerCommand(session: SkillActivationSession): { command: string; args: string[] } {
  const command = brokerCommands.get(session)
  if (!command) throw new Error('Skill session not found')
  return command()
}

export function renderSkillBrokerInstructions(session: SkillActivationSession): string {
  if (session.enabledSkills.length === 0) return ''
  const skills = session.enabledSkills
    .map(skill => `- ${skill.name}: ${skill.description} (by @${skill.author}, ${skill.license})`)
    .join('\n')
  return [
    'Crosscheck Agent Skills are available through the crosscheck MCP server.',
    'Decide from each description whether a skill applies to this operation. Activate only applicable skills before following their instructions.',
    skills,
  ].join('\n')
}

export function claudeSkillBrokerArgs(session?: SkillActivationSession): string[] {
  if (!session) return []
  const broker = skillBrokerCommand(session)
  return ['--mcp-config', JSON.stringify({
    mcpServers: { crosscheck: { command: broker.command, args: broker.args } },
  })]
}

export function codexSkillBrokerArgs(session?: SkillActivationSession): string[] {
  if (!session) return []
  const broker = skillBrokerCommand(session)
  return [
    '-c', `mcp_servers.crosscheck.command=${JSON.stringify(broker.command)}`,
    '-c', `mcp_servers.crosscheck.args=${JSON.stringify(broker.args)}`,
  ]
}

export function callSkillBrokerTool(
  sessionPath: string,
  toolName: string,
  rawArgs: unknown,
): BrokerToolResult {
  const state = readState(sessionPath)
  const args = rawArgs && typeof rawArgs === 'object' ? rawArgs as Record<string, unknown> : {}

  if (toolName === 'list_enabled_skills') {
    return { content: [{ type: 'text', text: JSON.stringify(state.enabled.map(metadata), null, 2) }] }
  }

  const name = stringArg(args, 'name')
  if (!name) return error('name is required')
  const skill = state.enabled.find(candidate => candidate.name === name)
  if (!skill) return error(`Skill ${name} is not enabled for this operation`)

  if (toolName === 'activate_skill') {
    const competitor = findCompetingSkill(name, state.activated)
    if (competitor) return error(`Skill ${name} competes with activated ${competitor}; activate only one review baseline`)
    const instructions = readFileSync(join(skill.path, 'SKILL.md'), 'utf8')
    if (!state.activated.includes(name)) {
      state.activated.push(name)
    }
    return {
      content: [{
        type: 'text',
        text: `Activated ${name} (by @${skill.author}, ${skill.license}).\nSkill root: ${skill.path}\n\n${instructions}`,
      }],
    }
  }

  if (toolName === 'read_skill_file') {
    if (!state.activated.includes(name)) return error(`Activate ${name} before reading its files`)
    const requestedPath = stringArg(args, 'path')
    if (!requestedPath) return error('path is required')
    const root = resolve(skill.path)
    const path = resolve(root, requestedPath)
    if (path !== root && !path.startsWith(`${root}${sep}`)) return error('Skill file path must stay inside the skill package')
    if (!existsSync(path) || !statSync(path).isFile()) return error(`Skill file not found: ${requestedPath}`)
    if (statSync(path).size > MAX_SKILL_FILE_BYTES) return error(`Skill file exceeds ${MAX_SKILL_FILE_BYTES} bytes`)
    return { content: [{ type: 'text', text: readFileSync(path, 'utf8') }] }
  }

  return error(`Unknown skill broker tool: ${toolName}`)
}

// Broker tools never mutate the repository or external systems; activation only
// records an idempotent receipt in the current step's temporary session.
const READ_ONLY_TOOL_ANNOTATIONS = {
  readOnlyHint: true,
  destructiveHint: false,
  idempotentHint: true,
  openWorldHint: false,
} as const

const TOOLS = [
  {
    name: 'list_enabled_skills',
    description: 'List Agent Skills enabled for the current Crosscheck operation. Metadata only; this does not activate a skill.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: 'activate_skill',
    description: 'Activate an enabled skill when its description applies, record attribution, and load its SKILL.md instructions.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' } },
      required: ['name'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
  {
    name: 'read_skill_file',
    description: 'Read a referenced file from a skill after activating it.',
    inputSchema: {
      type: 'object',
      properties: { name: { type: 'string' }, path: { type: 'string' } },
      required: ['name', 'path'],
      additionalProperties: false,
    },
    annotations: READ_ONLY_TOOL_ANNOTATIONS,
  },
]

export function handleSkillBrokerRequest(sessionPath: string, request: McpRequest): McpResponse | null {
  if (request.method.startsWith('notifications/')) return null
  const id = request.id ?? null
  if (request.method === 'initialize') {
    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {}
    return {
      jsonrpc: '2.0', id,
      result: {
        protocolVersion: typeof params.protocolVersion === 'string' ? params.protocolVersion : '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'crosscheck-skill-broker', version: '1.0.0' },
      },
    }
  }
  if (request.method === 'ping') return { jsonrpc: '2.0', id, result: {} }
  if (request.method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: TOOLS } }
  if (request.method === 'tools/call') {
    const params = request.params && typeof request.params === 'object' ? request.params as Record<string, unknown> : {}
    const name = typeof params.name === 'string' ? params.name : ''
    return { jsonrpc: '2.0', id, result: callSkillBrokerTool(sessionPath, name, params.arguments) }
  }
  return { jsonrpc: '2.0', id, error: { code: -32601, message: `Method not found: ${request.method}` } }
}
