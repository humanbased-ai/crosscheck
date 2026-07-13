import { RepoWorkflowStepsSchema, type Config, type RepoWorkflowStep } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'

export interface RepoRef {
  owner: string
  name: string
}

const STEP_HINT = 'Expected steps: review, review,fix, or review,fix,recheck'

export function parseRepoRef(input: string): RepoRef | null {
  const trimmed = input.trim()
  if (!trimmed) return null

  const sshMatch = trimmed.match(/^git@github\.com:([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/)
  if (sshMatch) return { owner: sshMatch[1], name: sshMatch[2].replace(/\.git$/, '') }

  let path = trimmed
    .replace(/^https?:\/\//, '')
    .replace(/^www\./, '')
    .replace(/^github\.com\//, '')
    .replace(/\/$/, '')

  const queryIdx = path.search(/[?#]/)
  if (queryIdx >= 0) path = path.slice(0, queryIdx)

  const parts = path.split('/').filter(Boolean)
  if (parts.length !== 2) return null

  const [owner, rawName] = parts
  const name = rawName.replace(/\.git$/, '')
  if (!owner || !name) return null
  return { owner, name }
}

export function parseRepoWorkflowSteps(input: string): RepoWorkflowStep[] {
  const cleaned = input.trim().replace(/^\[/, '').replace(/\]$/, '')
  const raw = cleaned
    .split(',')
    .map(part => part.trim().replace(/^['"]|['"]$/g, '').toLowerCase())
    .filter(Boolean)

  const parsed = RepoWorkflowStepsSchema.safeParse(raw)
  if (!parsed.success) throw new Error(STEP_HINT)
  return parsed.data
}

export function formatRepoWorkflowSteps(steps: readonly RepoWorkflowStep[]): string {
  return steps.join(' → ')
}

export function findRepoConfig(config: Config, owner: string, name: string): Config['repos'][number] | null {
  const ownerKey = owner.toLowerCase()
  const nameKey = name.toLowerCase()
  return config.repos.find(repo =>
    repo.owner.toLowerCase() === ownerKey && repo.name.toLowerCase() === nameKey
  ) ?? null
}

export function getRepoWorkflowStepTypes(
  config: Config,
  owner: string,
  name: string,
): RepoWorkflowStep[] | undefined {
  return findRepoConfig(config, owner, name)?.steps
}

export function resolveRepoWorkflowSteps(
  config: Config,
  owner: string,
  name: string,
  allSteps: WorkflowStep[],
): WorkflowStep[] {
  const stepTypes = getRepoWorkflowStepTypes(config, owner, name)
  if (!stepTypes) return allSteps
  return allSteps.filter(step => stepTypes.includes(step.type as RepoWorkflowStep))
}

export function isReviewOnlyWorkflow(steps: readonly WorkflowStep[]): boolean {
  return steps.length > 0 && steps.every(step => step.type === 'review')
}

export function workflowHasStep(steps: readonly WorkflowStep[], type: RepoWorkflowStep): boolean {
  return steps.some(step => step.type === type)
}
