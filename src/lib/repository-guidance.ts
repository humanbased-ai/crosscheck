import { execFileSync } from 'child_process'
import { dirname } from 'path'

const GUIDANCE_FILES = new Set(['AGENTS.md', 'CLAUDE.md'])

function git(repoDir: string, args: string[]): string {
  return execFileSync('git', args, {
    cwd: repoDir,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    maxBuffer: 2 * 1024 * 1024,
  }).trim()
}

export function loadRepositoryReviewGuidance(repoDir: string, baseBranch: string): string {
  const baseRef = `origin/${baseBranch}`
  try {
    const changedPaths = git(repoDir, ['diff', '--name-only', '--diff-filter=ACDMRT', `${baseRef}...HEAD`, '--'])
      .split('\n').filter(Boolean)
    if (changedPaths.length === 0) return ''

    const scopes = new Set<string>(['.'])
    for (const changedPath of changedPaths) {
      let scope = dirname(changedPath)
      while (scope !== '.') {
        scopes.add(scope)
        scope = dirname(scope)
      }
    }
    const candidates = [...scopes].flatMap(scope => [...GUIDANCE_FILES].map(file => scope === '.' ? file : `${scope}/${file}`))
    const checks = execFileSync('git', ['cat-file', '--batch-check'], {
      cwd: repoDir,
      encoding: 'utf8',
      input: candidates.map(path => `${baseRef}:${path}\n`).join(''),
      stdio: ['pipe', 'pipe', 'pipe'],
      maxBuffer: 2 * 1024 * 1024,
    }).trim().split('\n')
    const guidancePaths = candidates
      .filter((_, index) => checks[index]?.includes(' blob '))
      .sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))

    if (guidancePaths.length === 0) return ''
    const sections = guidancePaths.map(path => {
      const scope = dirname(path)
      const content = git(repoDir, ['show', `${baseRef}:${path}`])
      return `### ${path} (scope: ${scope === '.' ? 'repository root' : `${scope}/`})\n${content}`
    })

    return [
      '## Repository-defined review practices (trusted base branch)',
      'These repository practices override conflicting advice from Crosscheck-provided skills. Apply each file only within its stated scope. More specific directory guidance overrides broader guidance. At the same scope, reconcile AGENTS.md and CLAUDE.md; if they conflict, report the ambiguity instead of inventing a rule.',
      ...sections,
    ].join('\n\n')
  } catch {
    return ''
  }
}
