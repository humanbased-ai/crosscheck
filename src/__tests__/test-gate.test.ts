import { describe, expect, it } from 'vitest'
import { readdirSync, readFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const WORKFLOWS_DIR = join(fileURLToPath(import.meta.url), '..', '..', '..', '.github', 'workflows')

interface WorkflowStep {
  run?: string
}

interface WorkflowJob {
  name?: string
  strategy?: { matrix?: { node?: string[] } }
  steps?: WorkflowStep[]
}

interface Workflow {
  on: { pull_request?: { branches?: string[] } }
  jobs: Record<string, WorkflowJob>
}

function readWorkflow(file: string): Workflow {
  return yaml.load(readFileSync(join(WORKFLOWS_DIR, file), 'utf8')) as Workflow
}

function findPublishJobs(): Array<[string, WorkflowStep[]]> {
  return readdirSync(WORKFLOWS_DIR).flatMap(file =>
    Object.entries(readWorkflow(file).jobs)
      .filter(([, job]) => job.steps?.some(step => /\bnpm publish\b/.test(step.run ?? '')))
      .map(([jobId, job]): [string, WorkflowStep[]] => [`${file}:${jobId}`, job.steps ?? []])
  )
}

describe('publish jobs', () => {
  it('finds the @beta, @alpha and @latest jobs', () => {
    expect(findPublishJobs().map(([name]) => name)).toEqual(
      expect.arrayContaining(['publish.yml:staging', 'publish.yml:alpha', 'release.yml:publish'])
    )
  })

  it.each(findPublishJobs())('%s runs the tests before it pushes or publishes anything', (_name, steps) => {
    const testStep = steps.findIndex(step => step.run?.trim() === 'npm test')
    const firstOutwardStep = steps.findIndex(step => /\b(npm publish|git push)\b/.test(step.run ?? ''))

    expect(testStep).toBeGreaterThanOrEqual(0)
    expect(testStep).toBeLessThan(firstOutwardStep)
  })
})

describe('the CI check that merges require', () => {
  const ci = readWorkflow('ci.yml')

  it('runs on pull requests to staging, so fork PRs report it', () => {
    expect(ci.on.pull_request?.branches).toEqual(expect.arrayContaining(['main', 'staging']))
  })

  // The require-tests ruleset names these checks in repository settings. Changing
  // them here without changing the ruleset leaves every PR waiting for a check
  // that never reports.
  it('keeps the job name and Node versions the ruleset names', () => {
    expect(ci.jobs.check?.name).toBe('Lint, typecheck, build & test')
    expect(ci.jobs.check?.strategy?.matrix?.node).toEqual(['18', '20', '22'])
  })
})
