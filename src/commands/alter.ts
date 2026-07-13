import chalk from 'chalk'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { resolveConfigPath } from '../config/loader.js'
import { ConfigSchema, type RepoWorkflowStep } from '../config/schema.js'
import { formatRepoWorkflowSteps, parseRepoRef, parseRepoWorkflowSteps } from '../lib/repo-workflow.js'

export interface AlterOpts {
  config?: string
  steps?: string
  reviewOnly?: boolean
}

function resolveAlterConfigPath(explicitPath?: string): string {
  return resolveConfigPath(explicitPath) ?? join(homedir(), '.crosscheck', 'config.yml')
}

function readConfigObject(configPath: string): Record<string, unknown> {
  if (!existsSync(configPath)) return {}
  const parsed = yaml.load(readFileSync(configPath, 'utf8')) ?? {}
  if (typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`Invalid config at ${configPath}: expected a YAML object`)
  }
  return parsed as Record<string, unknown>
}

function resolveSteps(opts: AlterOpts): RepoWorkflowStep[] {
  if (opts.reviewOnly && opts.steps) {
    const explicit = parseRepoWorkflowSteps(opts.steps)
    if (explicit.length === 1 && explicit[0] === 'review') return explicit
    throw new Error('--review-only cannot be combined with --steps unless --steps is review')
  }
  if (opts.reviewOnly) return ['review']
  if (opts.steps) return parseRepoWorkflowSteps(opts.steps)
  throw new Error('Choose a workflow depth with --steps review,fix,recheck or --review-only')
}

export function applyRepoWorkflowOverride(
  raw: Record<string, unknown>,
  owner: string,
  name: string,
  steps: RepoWorkflowStep[],
): void {
  const repos = Array.isArray(raw.repos) ? raw.repos : []
  const nextRepos = repos.map(entry => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return entry
    const repo = entry as Record<string, unknown>
    if (
      typeof repo.owner === 'string'
      && typeof repo.name === 'string'
      && repo.owner.toLowerCase() === owner.toLowerCase()
      && repo.name.toLowerCase() === name.toLowerCase()
    ) {
      return { ...repo, steps }
    }
    return entry
  })

  const found = nextRepos.some(entry =>
    Boolean(entry)
    && typeof entry === 'object'
    && !Array.isArray(entry)
    && (entry as Record<string, unknown>).owner?.toString().toLowerCase() === owner.toLowerCase()
    && (entry as Record<string, unknown>).name?.toString().toLowerCase() === name.toLowerCase()
  )

  raw.repos = found ? nextRepos : [...nextRepos, { owner, name, steps }]
}

export function runAlter(repoInput: string, opts: AlterOpts = {}): void {
  try {
    const repo = parseRepoRef(repoInput)
    if (!repo) {
      throw new Error('Invalid repo. Use owner/repo, github.com/owner/repo, or https://github.com/owner/repo')
    }

    const steps = resolveSteps(opts)
    const configPath = resolveAlterConfigPath(opts.config)
    const raw = readConfigObject(configPath)
    applyRepoWorkflowOverride(raw, repo.owner, repo.name, steps)

    // Validate the full config after mutation so a typo never writes an invalid
    // repo override on top of an otherwise usable file.
    ConfigSchema.parse(raw)

    mkdirSync(dirname(configPath), { recursive: true })
    writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))

    console.log(chalk.green(`✓ ${repo.owner}/${repo.name} workflow set to ${formatRepoWorkflowSteps(steps)}`))
    console.log(chalk.dim(`  config: ${configPath}`))
    console.log(chalk.dim('  Restart crosscheck watch for a running watcher to pick up this change.'))
  } catch (err: unknown) {
    console.error(chalk.red(`✗ ${err instanceof Error ? err.message : String(err)}`))
    process.exit(1)
  }
}
