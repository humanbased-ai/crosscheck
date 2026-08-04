import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'fs'
import {
  callSkillBrokerTool,
  claudeSkillBrokerArgs,
  codexSkillBrokerArgs,
  createSkillActivationSession,
  handleSkillBrokerRequest,
  skillBrokerCommand,
  type SkillActivationSession,
} from '../skills/broker.js'
import { loadBundledSkills } from '../skills/catalog.js'
import { execa } from 'execa'

let session: SkillActivationSession | undefined

afterEach(() => {
  session?.close()
  session = undefined
})

describe('skill activation broker', () => {
  it('exposes enabled metadata without loading skill instructions', () => {
    session = createSkillActivationSession('fix', ['code-review-skill'], loadBundledSkills())

    expect(session.enabledSkills).toEqual([
      expect.objectContaining({
        name: 'code-review-skill',
        author: 'awesome-skills',
        license: 'MIT',
      }),
    ])
    expect(session.enabledSkills[0]).not.toHaveProperty('path')
    expect(session.activations()).toEqual([])
  })

  it('loads and records a skill only when the agent activates it', () => {
    session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())

    const result = callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })

    expect(result.isError).toBeUndefined()
    expect(result.content[0].text).toContain('# Code Review Skill')
    expect(session.activations()).toEqual([
      expect.objectContaining({ name: 'code-review-skill', author: 'awesome-skills', license: 'MIT' }),
    ])
  })

  it('keeps activation idempotent and rejects disabled skills', () => {
    session = createSkillActivationSession('recheck', ['code-review-skill'], loadBundledSkills())
    callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })
    callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })

    expect(session.activations()).toHaveLength(1)
    expect(callSkillBrokerTool(session.path, 'activate_skill', { name: 'missing' }).isError).toBe(true)
  })

  it('allows activated references but blocks path traversal', () => {
    session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())
    callSkillBrokerTool(session.path, 'activate_skill', { name: 'code-review-skill' })

    const reference = callSkillBrokerTool(session.path, 'read_skill_file', {
      name: 'code-review-skill',
      path: 'reference/typescript.md',
    })
    expect(reference.content[0].text).toContain('TypeScript')
    expect(callSkillBrokerTool(session.path, 'read_skill_file', {
      name: 'code-review-skill',
      path: '../LICENSE',
    }).isError).toBe(true)
  })

  it('speaks the MCP initialize and tools/list protocol', () => {
    session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())

    expect(handleSkillBrokerRequest(session.path, {
      jsonrpc: '2.0', id: 1, method: 'initialize', params: {},
    })).toMatchObject({ jsonrpc: '2.0', id: 1, result: { capabilities: { tools: {} } } })
    expect(handleSkillBrokerRequest(session.path, {
      jsonrpc: '2.0', id: 2, method: 'tools/list', params: {},
    })).toMatchObject({ jsonrpc: '2.0', id: 2, result: { tools: expect.any(Array) } })
  })

  it('serves newline-delimited MCP over stdio', async () => {
    session = createSkillActivationSession('review', ['code-review-skill'], loadBundledSkills())
    const broker = skillBrokerCommand(session.path)
    const requests = [
      { jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2024-11-05' } },
      { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} },
    ].map(request => JSON.stringify(request)).join('\n') + '\n'

    const { stdout } = await execa(broker.command, broker.args, { input: requests })
    const responses = stdout.split('\n').map(line => JSON.parse(line) as Record<string, unknown>)

    expect(responses).toHaveLength(2)
    expect(responses[1]).toMatchObject({ id: 2, result: { tools: expect.any(Array) } })
  })

  it('builds session-scoped Claude and Codex MCP arguments', () => {
    session = createSkillActivationSession('fix', ['code-review-skill'], loadBundledSkills())

    expect(claudeSkillBrokerArgs(session)).toEqual([
      '--mcp-config', expect.stringContaining('crosscheck'),
    ])
    expect(codexSkillBrokerArgs(session)).toEqual([
      '-c', expect.stringContaining('mcp_servers.crosscheck.command='),
      '-c', expect.stringContaining('mcp_servers.crosscheck.args='),
    ])
  })

  it('removes the session directory on close', () => {
    session = createSkillActivationSession('review', [], loadBundledSkills())
    const path = session.path
    session.close()
    session = undefined

    expect(existsSync(path)).toBe(false)
  })
})
