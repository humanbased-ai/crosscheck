import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { homedir } from 'os'
import yaml from 'js-yaml'
import { z } from 'zod'

export const WorkflowStepSchema = z.object({
  name: z.string(),
  // 'address' is the legacy name — normalized to 'fix' at parse time for backward compat
  type: z.enum(['review', 'fix', 'recheck', 'address', 'conflict-resolve']).transform(t => t === 'address' ? 'fix' : t) as z.ZodType<'review' | 'fix' | 'recheck' | 'conflict-resolve'>,
  reviewer: z.enum(['auto', 'claude', 'codex', 'origin']).default('auto'),
  when: z.string().optional(),
  max_rounds: z.number().int().positive().default(1),
  instructions: z.string().optional(),
  harness: z.string().optional(),
})

export const WorkflowSchema = z.object({
  on: z.array(z.string()).default(['opened', 'synchronize']),
  steps: z.array(WorkflowStepSchema),
})

export type WorkflowStep = z.infer<typeof WorkflowStepSchema>

export const DEFAULT_REVIEW_INSTRUCTIONS = [
  '## Constraints',
  '- Do not run tsc, ts-node, or build commands — inspect source files directly with git diff/log.',
  '- Do not install packages or modify lock files.',
  '## Output format',
  'Structure your output as: ## Summary, ## Critical Issues, ## Warnings, ## Suggestions.',
  'Be concise. Skip praise.',
  '## Verdict (required — machine-parsed)',
  'The very last line of your response MUST be exactly one of these three lines.',
  'Do not add bold, italics, punctuation, headers, or any other text after it:',
  'VERDICT: APPROVE',
  'VERDICT: NEEDS WORK',
  'VERDICT: BLOCK',
  '',
  'Use APPROVE for no issues or trivial nits only.',
  'Use NEEDS WORK for addressable issues that are not blocking.',
  'Use BLOCK for security risks, data loss, broken API contracts, or correctness bugs.',
].join('\n')

export const DEFAULT_FIX_INSTRUCTIONS = [
  'Only fix issues explicitly called out in the review.',
  'Do not refactor unrelated code, rename variables, or add tests unless specifically requested.',
  'If a comment requires deeper understanding of business logic, skip it.',
].join('\n')

export const DEFAULT_RECHECK_INSTRUCTIONS = [
  'Check that every issue flagged in the original review has been addressed.',
  'If all issues are resolved, output VERDICT: APPROVE.',
  'If issues remain, repeat the original verdict (NEEDS WORK or BLOCK) and list what is still outstanding.',
  'Do not flag new issues — focus only on resolution of the originals.',
].join('\n')

export const DEFAULT_CONFLICT_RESOLVE_INSTRUCTIONS = [
  'Resolve all merge conflict markers (<<<<<<< HEAD, =======, >>>>>>> branch).',
  'Keep meaningful changes from both sides when they do not contradict.',
  'When both sides modify the same line, prefer the incoming branch changes unless they break existing logic.',
  'Do not change any code outside of conflict regions.',
].join('\n')

// Default pipeline: review → fix (skipped when APPROVE) → recheck (skipped when
// no fix landed). This is the full loop every monitored repo gets out of the box;
// `crosscheck alter <repo>` narrows it per repo. Execution always goes through this
// constant — there is no legacy direct-call path.
export const DEFAULT_WORKFLOW: WorkflowStep[] = [
  {
    name: 'review',
    type: 'review',
    reviewer: 'auto',
    max_rounds: 1,
    instructions: DEFAULT_REVIEW_INSTRUCTIONS,
  },
  {
    name: 'fix',
    type: 'fix',
    reviewer: 'origin',
    when: "review.verdict != 'APPROVE'",
    max_rounds: 1,
    instructions: DEFAULT_FIX_INSTRUCTIONS,
  },
  {
    name: 'recheck',
    type: 'recheck',
    reviewer: 'auto',
    when: "fix.applied_count > 0",
    max_rounds: 1,
    instructions: DEFAULT_RECHECK_INSTRUCTIONS,
  },
]

/**
 * Loads a named section from a harness markdown file.
 * Sections are delimited by `## <name>` headings (level 2).
 * Returns the section body (trimmed), or null if the file/section is not found.
 * Throws if the file exists but cannot be read.
 */
export function loadHarnessSection(ref: string, baseDir?: string): string | null {
  const [filePart, section] = ref.split('#')
  if (!filePart || !section) return null
  const searchDirs = [
    ...(baseDir ? [join(baseDir, '.crosscheck', 'harness'), join(baseDir, 'harness')] : []),
    join(homedir(), '.crosscheck', 'harness'),
    // Built-in bundled harness shipped alongside the package (dist/harness when built, src/harness in dev)
    decodeURIComponent(new URL('../harness', import.meta.url).pathname),
  ]
  for (const dir of searchDirs) {
    const harnesPath = join(dir, filePart)
    if (!existsSync(harnesPath)) continue
    const raw = readFileSync(harnesPath, 'utf8')
    const sectionRegex = new RegExp(`^## ${section}\s*$`, 'm')
    const nextSectionRegex = /^## /m
    const start = raw.search(sectionRegex)
    if (start === -1) return null
    const afterHeading = raw.slice(start).indexOf('\n') + start + 1
    const rest = raw.slice(afterHeading)
    const nextMatch = rest.search(nextSectionRegex)
    return (nextMatch === -1 ? rest : rest.slice(0, nextMatch)).trim()
  }
  return null
}

export function loadWorkflow(operatorDir?: string): WorkflowStep[] {
  // Only look in operator-controlled directories — never inside the PR checkout.
  // Loading workflow config from untrusted PR code would let a PR hijack the runner.
  // Priority: project-local → global user config → DEFAULT_WORKFLOW.
  const candidates = [
    ...(operatorDir ? [join(operatorDir, '.crosscheck', 'workflow.yml')] : []),
    join(homedir(), '.crosscheck', 'workflow.yml'),
  ]
  for (const path of candidates) {
    if (!existsSync(path)) continue
    try {
      const raw = yaml.load(readFileSync(path, 'utf8'))
      const steps = WorkflowSchema.parse(raw).steps
      // Resolve any `harness: file.md#section` ref into the step's instructions.
      return steps.map(step => {
        if (!step.harness) return step
        const resolved = loadHarnessSection(step.harness, operatorDir)
        return resolved ? { ...step, instructions: resolved } : step
      })
    } catch {
      // Malformed workflow file — fall through to default
    }
  }
  return DEFAULT_WORKFLOW
}

export interface StepResult {
  verdict?: string | null
  commentBody?: string
  commentUrl?: string
  commentId?: number
  applied_count?: number
  skipped?: boolean
  tokens_used?: number
  input_tokens?: number
  output_tokens?: number
  vendor?: string
  model?: string
}

// Evaluates simple "stepName.field op 'value'" expressions.
// Unparseable expressions default to true (run the step).
export function evaluateWhen(expr: string, results: Record<string, StepResult>): boolean {
  const m = expr.trim().match(/^(\w+)\.(\w+)\s*(==|!=|>=|<=|>|<)\s*(?:'([^']*)'|(null|-?\d+(?:\.\d+)?))$/)
  if (!m) return true

  const [, stepName, field, op, strVal, rawVal] = m
  const result = results[stepName]
  if (!result) return true

  const actual = result[field as keyof StepResult]
  const expected = strVal !== undefined ? strVal : rawVal === 'null' ? null : Number(rawVal)

  switch (op) {
    case '==': return actual === expected
    case '!=': return actual !== expected
    case '>':  return Number(actual) > Number(expected)
    case '<':  return Number(actual) < Number(expected)
    case '>=': return Number(actual) >= Number(expected)
    case '<=': return Number(actual) <= Number(expected)
    default:   return true
  }
}


// Only review and recheck steps post a verdict, and only a verdict reaches Linear.
// `crosscheck fix` and `crosscheck resolve` run workflows that can never write, so
// they must not be aborted by a missing credential or a Linear outage.
export function canWriteVerdict(steps: ReadonlyArray<{ type: string }> | undefined): boolean {
  if (!steps) return true
  return steps.some(s => s.type === 'review' || s.type === 'recheck')
}


// The single question every Linear auth gate should ask. Three separate checks
// drifted apart across run/watch/review/runner: enablement, whether the selected
// workflow can produce a verdict, and whether any verdict is even configured to
// post. `comment_on: []` is valid and means nothing ever posts, so a run with it
// must not mint a token or abort on a missing credential.
export function linearWritePossible(
  linear: { enabled: boolean; comment_on: readonly string[] },
  steps: ReadonlyArray<{ type: string }> | undefined,
): boolean {
  if (!linear.enabled) return false
  if (linear.comment_on.length === 0) return false
  return canWriteVerdict(steps)
}
