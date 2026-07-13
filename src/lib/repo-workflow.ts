import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { dirname, join } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { RepoWorkflowStepsSchema, type RepoWorkflowStep } from '../config/schema.js'
import type { WorkflowStep } from './workflow.js'

export interface RepoRef {
  owner: string
  name: string
}

const STEP_HINT = 'Expected steps: review, review,fix, or review,fix,recheck'

// Per-repo workflow overrides live in standalone files, keyed by repo, so one
// long-lived `watch` can narrow individual repos while the pipeline shape stays
// out of the infra config. Files are read per PR event (live reload — no restart).
export function defaultRepoWorkflowsDir(): string {
  return join(homedir(), '.crosscheck', 'workflows')
}

export function perRepoWorkflowPath(
  owner: string,
  name: string,
  workflowsDir: string = defaultRepoWorkflowsDir(),
): string {
  return join(workflowsDir, `${owner.toLowerCase()}__${name.toLowerCase()}.yml`)
}

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

function buildRepoWorkflowFile(owner: string, name: string, steps: RepoWorkflowStep[]): string {
  return [
    `# crosscheck per-repo workflow override — written by \`crosscheck alter\``,
    `# Narrows the global ~/.crosscheck/workflow.yml for ${owner}/${name} to these steps.`,
    `# Values: review | review,fix | review,fix,recheck. Delete this file (or run`,
    `# \`crosscheck alter ${owner}/${name} --reset\`) to restore the global default.`,
    yaml.dump({ steps }, { lineWidth: -1, noRefs: true }),
  ].join('\n')
}

// Reads the per-repo override file and returns its step-type list, or undefined
// when there is no override (file absent) or the file is unreadable/malformed —
// in which case the repo falls back to the global workflow.
export function readRepoWorkflowStepTypes(
  owner: string,
  name: string,
  workflowsDir: string = defaultRepoWorkflowsDir(),
): RepoWorkflowStep[] | undefined {
  const path = perRepoWorkflowPath(owner, name, workflowsDir)
  if (!existsSync(path)) return undefined
  try {
    const raw = yaml.load(readFileSync(path, 'utf8')) as { steps?: unknown }
    const parsed = RepoWorkflowStepsSchema.safeParse(raw?.steps)
    return parsed.success ? parsed.data : undefined
  } catch {
    return undefined
  }
}

export function writeRepoWorkflowStepTypes(
  owner: string,
  name: string,
  steps: RepoWorkflowStep[],
  workflowsDir: string = defaultRepoWorkflowsDir(),
): string {
  const path = perRepoWorkflowPath(owner, name, workflowsDir)
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, buildRepoWorkflowFile(owner, name, steps))
  return path
}

// Removes the per-repo override so the repo reverts to the global default.
// Returns true if a file was removed, false if there was nothing to remove.
export function removeRepoWorkflowOverride(
  owner: string,
  name: string,
  workflowsDir: string = defaultRepoWorkflowsDir(),
): boolean {
  const path = perRepoWorkflowPath(owner, name, workflowsDir)
  if (!existsSync(path)) return false
  rmSync(path)
  return true
}

export function getRepoWorkflowStepTypes(
  owner: string,
  name: string,
  workflowsDir: string = defaultRepoWorkflowsDir(),
): RepoWorkflowStep[] | undefined {
  return readRepoWorkflowStepTypes(owner, name, workflowsDir)
}

export function resolveRepoWorkflowSteps(
  owner: string,
  name: string,
  allSteps: WorkflowStep[],
  workflowsDir: string = defaultRepoWorkflowsDir(),
): WorkflowStep[] {
  const stepTypes = getRepoWorkflowStepTypes(owner, name, workflowsDir)
  if (!stepTypes) return allSteps
  // The override is a depth ladder over review → fix → recheck. `conflict-resolve`
  // is orthogonal to that ladder — it resolves merge conflicts rather than deepening
  // the review — so it is not one of the values a repo override can list. Keep it
  // whenever the override permits code modification (i.e. includes `fix`); a
  // review-only override drops it along with fix/recheck, preserving the
  // "never touch the code" guarantee and keeping isReviewOnlyWorkflow() true.
  const keepConflictResolve = stepTypes.includes('fix')
  return allSteps.filter(step =>
    (step.type === 'conflict-resolve' && keepConflictResolve)
    || stepTypes.includes(step.type as RepoWorkflowStep),
  )
}

export function isReviewOnlyWorkflow(steps: readonly WorkflowStep[]): boolean {
  return steps.length > 0 && steps.every(step => step.type === 'review')
}

export function workflowHasStep(steps: readonly WorkflowStep[], type: RepoWorkflowStep): boolean {
  return steps.some(step => step.type === type)
}
