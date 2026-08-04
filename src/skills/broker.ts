import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'fs'
import { join, resolve, sep } from 'path'
import { tmpdir } from 'os'
import { fileURLToPath } from 'url'
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

function readState(sessionPath: string): SkillSessionState {
  return JSON.parse(readFileSync(sessionPath, 'utf8')) as SkillSessionState
}

function writeState(sessionPath: string, state: SkillSessionState): void {
  writeFileSync(sessionPath, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 })
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
  const sessionDir = mkdtempSync(join(tmpdir(), 'crosscheck-skill-session-'))
  const path = join(sessionDir, 'session.json')
  writeState(path, { schemaVersion: 1, stepType, enabled, activated: [] })

  return {
    path,
    stepType,
    enabledSkills: enabled.map(metadata),
    activations: () => {
      const state = readState(path)
      const activated = new Set(state.activated)
      return state.enabled.filter(skill => activated.has(skill.name)).map(metadata)
    },
    close: () => rmSync(sessionDir, { recursive: true, force: true }),
  }
}

export function skillBrokerCommand(sessionPath: string): { command: string; args: string[] } {
  const serverArgs = existsSync(BROKER_SERVER_PATH)
    ? [BROKER_SERVER_PATH]
    : ['--import', 'tsx', BROKER_SERVER_TS_PATH]
  return { command: process.execPath, args: [...serverArgs, '--session', sessionPath] }
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
  const broker = skillBrokerCommand(session.path)
  return ['--mcp-config', JSON.stringify({
    mcpServers: { crosscheck: { command: broker.command, args: broker.args } },
  })]
}

export function codexSkillBrokerArgs(session?: SkillActivationSession): string[] {
  if (!session) return []
  const broker = skillBrokerCommand(session.path)
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
      writeState(sessionPath, state)
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

const TOOLS = [
  {
    name: 'list_enabled_skills',
    description: 'List Agent Skills enabled for the current Crosscheck operation. Metadata only; this does not activate a skill.',
    inputSchema: { type: 'object', properties: {}, additionalProperties: false },
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
