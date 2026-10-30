import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { execFileSync, spawnSync } from 'child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { fileURLToPath } from 'url'
import yaml from 'js-yaml'

const WORKFLOW = join(fileURLToPath(import.meta.url), '..', '..', '..', '.github', 'workflows', 'promote-staging.yml')

interface WorkflowStep {
  name?: string
  run?: string
}

interface Workflow {
  jobs: { promote: { steps: WorkflowStep[] } }
}

function readStepScript(name: string): string {
  const workflow = yaml.load(readFileSync(WORKFLOW, 'utf8')) as Workflow
  const script = workflow.jobs.promote.steps.find(step => step.name === name)?.run
  if (!script) throw new Error(`promote-staging.yml has no "${name}" step with a run script`)
  return script.replace('${{ steps.check.outputs.ahead }}', '3')
}

// The step scripts run for real against a local origin: what matters is which
// commits git reports and which refs end up on the remote. Only `gh` is a stub,
// because no test may open a PR against the real repo.
const GH_STUB = `#!/bin/bash
case "$1 $2" in
  "pr list") ;;
  "pr create")
    if [ "$GH_STUB_CREATE" = "refused" ]; then
      echo "pull request create failed: GraphQL: GitHub Actions is not permitted to create or approve pull requests (createPullRequest)" >&2
      exit 1
    fi
    echo "https://github.com/humanbased-ai/crosscheck/pull/400"
    ;;
  *) echo "unexpected gh call: $*" >&2; exit 64 ;;
esac
`

describe('promote-staging.yml', () => {
  let rootDir: string
  let originDir: string
  let workDir: string
  let stubDir: string
  let outputFile: string

  const git = (dir: string, ...args: string[]): string =>
    execFileSync('git', args, { cwd: dir, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

  const commit = (message: string): void => {
    const file = `${message.replace(/\W+/g, '-')}.txt`
    writeFileSync(join(workDir, file), `${message}\n`)
    git(workDir, 'add', '-A')
    git(workDir, '-c', 'user.email=ci@example.com', '-c', 'user.name=ci', 'commit', '-m', message)
  }

  const landOnStaging = (number: number, branch: string, commitMessage: string): void => {
    git(workDir, 'checkout', '-b', branch, 'staging')
    commit(commitMessage)
    landBranchOnStaging(number, branch)
  }

  const landBranchOnStaging = (number: number, branch: string): void => {
    git(workDir, 'checkout', 'staging')
    git(
      workDir, '-c', 'user.email=ci@example.com', '-c', 'user.name=ci',
      'merge', '--no-ff', '-m', `Merge pull request #${number} from humanbased-ai/${branch}`, branch
    )
    git(workDir, 'push', 'origin', 'staging')
  }

  const runStep = (name: string, env: Record<string, string> = {}): { status: number | null; stdout: string } => {
    const { status, stdout } = spawnSync('bash', ['-e', '-c', readStepScript(name)], {
      cwd: workDir,
      encoding: 'utf8',
      env: { ...process.env, PATH: `${stubDir}:${process.env.PATH}`, GITHUB_OUTPUT: outputFile, ...env },
    })
    return { status, stdout }
  }

  const stepOutputs = (): string => (existsSync(outputFile) ? readFileSync(outputFile, 'utf8') : '')

  beforeEach(() => {
    rootDir = mkdtempSync(join(tmpdir(), 'crosscheck-promote-'))
    originDir = join(rootDir, 'origin.git')
    workDir = join(rootDir, 'work')
    stubDir = join(rootDir, 'bin')
    outputFile = join(rootDir, 'github-output')

    mkdirSync(stubDir)
    writeFileSync(join(stubDir, 'gh'), GH_STUB)
    chmodSync(join(stubDir, 'gh'), 0o755)

    git(rootDir, 'init', '--bare', '--initial-branch=main', originDir)
    git(rootDir, 'clone', originDir, workDir)
    commit('chore: seed the repository')
    git(workDir, 'push', 'origin', 'HEAD:main')
    git(workDir, 'checkout', '-b', 'staging')
    git(workDir, 'push', 'origin', 'staging')
  })

  afterEach(() => {
    rmSync(rootDir, { recursive: true, force: true })
  })

  describe('Check if staging is ahead of main', () => {
    const CHECK = 'Check if staging is ahead of main'

    it('skips the promotion when staging only carries a merged version-sync PR', () => {
      landOnStaging(380, 'ci/sync-v1.9.2-to-staging', 'chore: sync v1.9.2 version to staging')

      expect(runStep(CHECK).status).toBe(0)
      expect(stepOutputs()).toBe('ahead=0\n')
    })

    it('skips the promotion when staging only carries a merge of main back into staging', () => {
      git(workDir, 'checkout', '-b', 'ci/sync-main-to-staging-20260911', 'main')
      commit('fix: hotfix that landed on main first')
      git(workDir, 'push', 'origin', 'HEAD:main')
      landBranchOnStaging(323, 'ci/sync-main-to-staging-20260911')

      expect(runStep(CHECK).status).toBe(0)
      expect(stepOutputs()).toBe('ahead=0\n')
    })

    it('promotes when a real change landed alongside a version sync', () => {
      landOnStaging(380, 'ci/sync-v1.9.2-to-staging', 'chore: sync v1.9.2 version to staging')
      landOnStaging(381, 'fix/quota-failover', 'fix: fail over when a vendor runs out of quota')

      expect(runStep(CHECK).status).toBe(0)
      expect(stepOutputs()).toBe('ahead=4\n')
    })

    it('promotes a real commit that arrived on a branch named like a sync', () => {
      landOnStaging(382, 'ci/sync-v1.9.2-to-staging', 'fix: keep the staging version in step with the tag')

      expect(runStep(CHECK).status).toBe(0)
      expect(stepOutputs()).toBe('ahead=2\n')
    })
  })

  describe('Open promotion PR', () => {
    const OPEN = 'Open promotion PR'
    const promotionBranches = (): string => git(workDir, 'ls-remote', '--heads', 'origin', 'ci/promote-staging-*')

    beforeEach(() => {
      landOnStaging(381, 'fix/quota-failover', 'fix: fail over when a vendor runs out of quota')
    })

    it('records the PR and keeps its branch when the PR opens', () => {
      expect(runStep(OPEN).status).toBe(0)

      expect(stepOutputs()).toBe('url=https://github.com/humanbased-ai/crosscheck/pull/400\n')
      expect(promotionBranches()).toContain(git(workDir, 'rev-parse', 'origin/staging'))
    })

    it('fails, names the missing secret and leaves no branch behind when the PR is refused', () => {
      const { status, stdout } = runStep(OPEN, { GH_STUB_CREATE: 'refused' })

      expect(status).not.toBe(0)
      expect(stdout).toContain('::error::')
      expect(stdout).toContain('RELEASE_TOKEN')
      expect(stepOutputs()).toBe('')
      expect(promotionBranches()).toBe('')
    })
  })
})
