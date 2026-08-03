import { existsSync, mkdirSync, writeFileSync, readFileSync } from 'fs'
import { join, dirname } from 'path'
import { homedir } from 'os'
import chalk from 'chalk'
import { createInterface } from 'readline'
import yaml from 'js-yaml'
import {
  getGithubToken,
  loadConfig,
  resolveConfigPath,
  detectGitHubLogin,
} from '../config/loader.js'
import { listUserOrgs, listOrgRepos, fetchActiveRepos, type RepoActivity } from '../github/client.js'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkClaudeAuth } from '../reviewers/claude.js'
import { execSync } from 'child_process'
import { promptRepoPicker, promptSinglePicker, type PickerItem } from '../lib/repo-picker.js'
import { DEFAULT_REVIEW_INSTRUCTIONS, DEFAULT_FIX_INSTRUCTIONS, DEFAULT_RECHECK_INSTRUCTIONS, DEFAULT_CONFLICT_RESOLVE_INSTRUCTIONS } from '../lib/workflow.js'
import { formatRepoWorkflowSteps, readRepoWorkflowStepTypes } from '../lib/repo-workflow.js'

export interface OnboardOpts {
  config?: string
  yes?: boolean
  personal?: boolean
  team?: boolean
  reconfigure?: boolean
}

interface EnvCheckResult {
  ok: boolean
  claudeOk: boolean
  codexOk: boolean
}

type WorkflowPreset = 'review-only' | 'review-fix' | 'review-fix-recheck'

type VendorModeConfig = {
  mode: 'cross-vendor' | 'single-vendor'
  claudeEnabled: boolean
  codexEnabled: boolean
}

// Model and effort settings for each quality tier.
// These are written directly to vendors.claude / vendors.codex in the config.
const QUALITY_TIERS = {
  fast: {
    description: 'quick scan, top issues only  (~10s, lowest cost)',
    claude: { model: 'haiku', effort: 'low' as const },
    codex:  { model: 'gpt-5.6-luna', effort: 'low' as const },
  },
  balanced: {
    description: 'full review, all issues with explanations  (~30s)',
    claude: { model: 'sonnet', effort: 'medium' as const },
    codex:  { model: 'gpt-5.6-terra', effort: 'medium' as const },
  },
  thorough: {
    description: 'deep multi-pass, security + architecture  (~60s+, higher cost)',
    claude: { model: 'opus', effort: 'max' as const },
    codex:  { model: 'gpt-5.6-sol', effort: 'high' as const },
  },
} as const

type QualityTier = keyof typeof QUALITY_TIERS

function ask(question: string): Promise<string> {
  return new Promise(resolve => {
    const rl = createInterface({ input: process.stdin, output: process.stdout })
    rl.question(question, answer => { rl.close(); resolve(answer.trim()) })
  })
}

function formatAge(date: Date): string {
  const days = Math.floor((Date.now() - date.getTime()) / 86_400_000)
  if (days === 0) return 'today'
  if (days < 7) return `${days}d ago`
  if (days < 30) return `${Math.floor(days / 7)}w ago`
  if (days < 365) return `${Math.floor(days / 30)}mo ago`
  return `${Math.floor(days / 365)}y ago`
}

async function checkEnv(): Promise<EnvCheckResult> {
  let codexOk = false
  let claudeOk = false

  try {
    execSync('codex --version 2>&1', { encoding: 'utf8' })
    const auth = await checkCodexAuth()
    codexOk = auth.ok
    const icon = auth.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'codex CLI'.padEnd(20)} ${auth.detail}`)
    if (!auth.ok) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: codex login --device-auth')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'codex CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: npm install -g @openai/codex')}`)
  }

  try {
    const auth = await checkClaudeAuth()
    claudeOk = auth.ok
    const icon = auth.ok ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'claude CLI'.padEnd(20)} ${auth.detail}`)
    if (!auth.ok) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: claude auth login')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'claude CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: npm install -g @anthropic-ai/claude-code')}`)
  }

  const envToken = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN
  let ghAuthed = false
  try {
    execSync('gh --version 2>&1', { encoding: 'utf8' })
    let authOutput = ''
    try { authOutput = execSync('gh auth status 2>&1', { encoding: 'utf8' }) } catch { /* GITHUB_TOKEN in use */ }
    ghAuthed = authOutput.includes('Logged in') || !!envToken
    const icon = ghAuthed ? chalk.green('✓') : chalk.red('✗')
    console.log(`  ${icon} ${'gh CLI'.padEnd(20)} ${ghAuthed ? 'authenticated' : 'not authenticated'}`)
    if (!ghAuthed) console.log(`      ${chalk.dim('→')} ${chalk.yellow('Run: gh auth login')}`)
  } catch {
    console.log(`  ${chalk.red('✗')} ${'gh CLI'.padEnd(20)} not found`)
    console.log(`      ${chalk.dim('→')} ${chalk.yellow('Install: brew install gh && gh auth login')}`)
  }

  if (!claudeOk && !codexOk) {
    console.log(chalk.red('\nAt least one AI CLI (codex or claude) must be authenticated.\n'))
    return { ok: false, claudeOk, codexOk }
  }
  if (!ghAuthed) {
    console.log(chalk.red('\nGitHub auth is required to fetch repos and register webhooks.\n'))
    return { ok: false, claudeOk, codexOk }
  }
  return { ok: true, claudeOk, codexOk }
}

async function promptVendorMode(
  claudeOk: boolean,
  codexOk: boolean,
  existingMode: string | undefined,
  existingClaudeEnabled: boolean,
  existingCodexEnabled: boolean,
  opts: OnboardOpts,
): Promise<VendorModeConfig> {
  const bothAvailable = claudeOk && codexOk

  if (!bothAvailable) {
    const vendor = claudeOk ? 'claude' : 'codex'
    console.log(`  Mode: ${chalk.cyan('single-vendor')} (only ${chalk.bold(vendor)} is available)`)
    return { mode: 'single-vendor', claudeEnabled: claudeOk, codexEnabled: codexOk }
  }

  if (opts.yes) {
    const mode = (existingMode ?? 'cross-vendor') as 'cross-vendor' | 'single-vendor'
    console.log(`  Mode: ${chalk.cyan(mode)}`)
    return { mode, claudeEnabled: existingClaudeEnabled, codexEnabled: existingCodexEnabled }
  }

  const modeItems: PickerItem[] = [
    { label: 'cross-vendor', description: 'Claude reviews Codex PRs; Codex reviews Claude PRs' },
    { label: 'single-vendor', description: 'one AI reviews all PRs' },
  ]
  const defaultModeIdx = existingMode === 'single-vendor' ? 1 : 0
  const modeIdx = await promptSinglePicker(modeItems, {
    title: 'How should reviews be assigned?',
    defaultIndex: defaultModeIdx,
  })
  console.log()

  if (modeIdx === 0) {
    return { mode: 'cross-vendor', claudeEnabled: true, codexEnabled: true }
  }

  // Single-vendor: ask which one
  const defaultVendorIdx = (existingMode === 'single-vendor' && existingCodexEnabled && !existingClaudeEnabled) ? 1 : 0
  const vendorItems: PickerItem[] = [
    { label: 'claude', description: 'Claude Code reviews all PRs' },
    { label: 'codex', description: 'OpenAI Codex reviews all PRs' },
  ]
  const vendorIdx = await promptSinglePicker(vendorItems, {
    title: 'Which AI should review all PRs?',
    defaultIndex: defaultVendorIdx,
  })
  console.log()

  return {
    mode: 'single-vendor',
    claudeEnabled: vendorIdx === 0,
    codexEnabled: vendorIdx === 1,
  }
}

async function promptAuthorVendor(
  login: string,
  existingAuthorRoutes: Record<string, string> | null,
  opts: OnboardOpts,
): Promise<'claude' | 'codex' | 'both'> {
  const existing = existingAuthorRoutes?.[login]
  const current: 'claude' | 'codex' | 'both' =
    existing === 'codex' ? 'codex' : existing === 'claude' ? 'claude' : 'both'

  if (opts.yes) {
    console.log(`  Primary author: ${chalk.cyan(current)}`)
    return current
  }

  const items: PickerItem[] = [
    { label: 'claude', description: 'my PRs without explicit attribution → Codex reviews them' },
    { label: 'codex',  description: 'my PRs without explicit attribution → Claude reviews them' },
    { label: 'both',   description: 'my PRs without explicit attribution → use fallback_reviewer' },
  ]
  const defaultIdx = current === 'codex' ? 1 : current === 'claude' ? 0 : 2
  const idx = await promptSinglePicker(items, {
    title: 'Which AI do you primarily use to write code?',
    defaultIndex: defaultIdx,
  })
  console.log()

  return idx === 1 ? 'codex' : idx === 2 ? 'both' : 'claude'
}

async function promptQualityTier(
  claudeEnabled: boolean,
  codexEnabled: boolean,
  currentTier: string | undefined,
  opts: OnboardOpts,
): Promise<QualityTier> {
  if (opts.yes) {
    const tier = (currentTier ?? 'balanced') as QualityTier
    console.log(`  Quality: ${chalk.cyan(tier)}`)
    return tier
  }

  function modelHint(tier: QualityTier): string {
    const t = QUALITY_TIERS[tier]
    const parts: string[] = []
    if (claudeEnabled) parts.push(`claude: ${t.claude.model} · ${t.claude.effort} effort`)
    if (codexEnabled)  parts.push(`codex: ${t.codex.model} · ${t.codex.effort} effort`)
    return parts.join('  ·  ')
  }

  const tiers: QualityTier[] = ['fast', 'balanced', 'thorough']
  const items: PickerItem[] = tiers.map(tier => ({
    label: tier,
    description: QUALITY_TIERS[tier].description,
    hint: modelHint(tier),
  }))

  const defaultIdx = tiers.indexOf((currentTier ?? 'balanced') as QualityTier)
  const idx = await promptSinglePicker(items, {
    title: 'Review quality — how deep should the analysis go?',
    defaultIndex: defaultIdx >= 0 ? defaultIdx : 1,
  })
  console.log()

  return tiers[idx]
}

// Exported for tests; `workflowDir` defaults to the user's ~/.crosscheck for runtime callsites.
export function detectCurrentPreset(workflowDir: string = join(homedir(), '.crosscheck')): WorkflowPreset {
  const globalWorkflowPath = join(workflowDir, 'workflow.yml')
  if (existsSync(globalWorkflowPath)) {
    try {
      const raw = yaml.load(readFileSync(globalWorkflowPath, 'utf8')) as { steps?: Array<{ type?: string }> }
      // Normalize legacy 'address' → 'fix' to match the schema-level transform in workflow.ts.
      // Without this, a legacy workflow with `type: address` is misread as `review-only`,
      // which then causes applyOnboardConfig to silently drop the fix step on regenerate.
      const types = (raw?.steps ?? []).map(s => (s.type === 'address' ? 'fix' : s.type))
      if (types.includes('recheck')) return 'review-fix-recheck'
      if (types.includes('fix')) return 'review-fix'
      return 'review-only'
    } catch { /* malformed — fall through to the default below */ }
  }
  // No global workflow file yet (fresh install) — default to the full loop.
  return 'review-fix-recheck'
}

export function detectConflictResolveEnabled(workflowDir: string = join(homedir(), '.crosscheck')): boolean {
  const path = join(workflowDir, 'workflow.yml')
  if (!existsSync(path)) return false
  try {
    const raw = yaml.load(readFileSync(path, 'utf8')) as { steps?: Array<{ type?: string }> }
    return (raw?.steps ?? []).some(s => s.type === 'conflict-resolve')
  } catch { return false }
}

async function promptConflictResolve(
  currentEnabled: boolean,
  opts: OnboardOpts,
): Promise<boolean> {
  if (opts.yes) {
    console.log(`  Conflict-resolve: ${chalk.cyan(currentEnabled ? 'yes' : 'no')}`)
    return currentEnabled
  }

  const items: PickerItem[] = [
    { label: 'no', description: 'leave merge conflicts for the PR author to resolve manually' },
    { label: 'yes', description: 'auto-resolve merge conflicts before each review (requires Claude)' },
  ]
  const defaultIdx = currentEnabled ? 1 : 0
  const idx = await promptSinglePicker(items, {
    title: 'Auto-resolve merge conflicts?',
    defaultIndex: defaultIdx,
  })
  console.log()
  return idx === 1
}

async function promptMaxRounds(
  currentMaxRounds: number | undefined,
  opts: OnboardOpts,
): Promise<number> {
  if (opts.yes) {
    const rounds = currentMaxRounds ?? 1
    console.log(`  Max rounds: ${chalk.cyan(String(rounds))}`)
    return rounds
  }

  const items: PickerItem[] = [
    { label: '1 round', description: 'one fix pass, then re-check once' },
    { label: '2 rounds', description: 'up to two fix → re-check cycles' },
    { label: '3 rounds', description: 'up to three fix → re-check cycles (maximum)' },
  ]
  const defaultIdx = Math.max(0, Math.min(2, (currentMaxRounds ?? 1) - 1))
  const idx = await promptSinglePicker(items, {
    title: 'How many fix → re-check rounds?',
    defaultIndex: defaultIdx,
  })
  console.log()
  return idx + 1
}

async function promptWorkflowPipeline(opts: OnboardOpts): Promise<WorkflowPreset> {
  const currentPreset = detectCurrentPreset()

  if (opts.yes) {
    console.log(`  Pipeline: ${chalk.cyan(currentPreset)}`)
    return currentPreset
  }

  const presetOrder: WorkflowPreset[] = ['review-only', 'review-fix', 'review-fix-recheck']
  const defaultIdx = presetOrder.indexOf(currentPreset)

  const items: PickerItem[] = [
    { label: 'review only', description: 'AI posts a comment; you handle fixes' },
    { label: 'review → fix', description: 'AI reviews, then auto-applies fixes' },
    { label: 'review → fix → re-check', description: 'full loop: review, fix, then re-review to confirm' },
  ]

  const idx = await promptSinglePicker(items, {
    title: 'What should happen after a review?',
    defaultIndex: defaultIdx >= 0 ? defaultIdx : 2,
  })
  console.log()

  if (idx === 0) return 'review-only'
  if (idx === 2) return 'review-fix-recheck'
  return 'review-fix'
}

export interface LinearDecision {
  mode: 'off' | 'api_key' | 'client_credentials'
  teamKeys: string[]
}

// The attribution ladder, surfaced at onboarding rather than left in the docs.
// Each rung buys stronger attribution for more setup; rung 1 needs nothing but a
// key, so a user who just wants review outcomes in Linear never has to see an
// OAuth form. Defaults to off — writing into someone's tracker is opt-in.
export async function promptLinear(
  current: { enabled?: boolean; mode?: string; teamKeys?: string[] } | undefined,
  opts: OnboardOpts,
): Promise<LinearDecision> {
  const currentMode: LinearDecision['mode'] = !current?.enabled
    ? 'off'
    : current.mode === 'client_credentials' ? 'client_credentials' : 'api_key'

  if (opts.yes) return { mode: currentMode, teamKeys: current?.teamKeys ?? [] }

  const currentChoice = currentMode === 'client_credentials' ? '3' : currentMode === 'api_key' ? '2' : '1'

  console.log(chalk.dim('  Post the review verdict onto the Linear issue a PR belongs to.\n'))
  console.log('  [1] off           — leave Linear alone')
  console.log(`  [2] api key       — works immediately. Comments post under ${chalk.dim('your own Linear account')}`)
  console.log(`  [3] workspace app — comments post as ${chalk.cyan('crosscheck')} itself, with its own icon`)
  console.log(chalk.dim('                      one app per workspace, ~5 min, needs Linear settings access'))
  console.log(chalk.dim(`\n  Current: ${currentMode}`))
  console.log()

  // Enter keeps whatever is configured. Defaulting to `off` meant a re-run where
  // the user just pressed enter silently disabled a working integration.
  const answer = (await ask(`  Choice [${currentChoice}]: `)).trim()
  const mode: LinearDecision['mode'] =
    answer === '1' ? 'off'
      : answer === '2' ? 'api_key'
        : answer === '3' ? 'client_credentials'
          : currentMode

  if (mode === 'off') return { mode, teamKeys: [] }

  // Without team keys only full linear.app URLs resolve — worth asking, because a
  // user who skips it may see nothing happen and assume the feature is broken.
  console.log(chalk.dim('\n  Your Linear team key prefixes, so refs like ENG-42 in a branch name resolve.'))
  console.log(chalk.dim('  Comma-separated. Leave blank to only follow full linear.app links.'))
  // Blank keeps the current value on a first run (nothing to keep) and on a re-run
  // where the user just pressed enter. `-` is the explicit clear, because silently
  // treating blank as "clear" would wipe configured keys on every re-run.
  const hasCurrent = (current?.teamKeys?.length ?? 0) > 0
  const keysPrompt = hasCurrent
    ? `  team keys [${current!.teamKeys!.join(',')}] (- to clear): `
    : '  team keys: '
  const keysAnswer = (await ask(keysPrompt)).trim()
  const teamKeys = keysAnswer === '-'
    ? []
    : keysAnswer
      ? keysAnswer.split(',').map(k => k.trim().toUpperCase()).filter(Boolean)
      : (current?.teamKeys ?? [])

  if (mode === 'api_key') {
    console.log(chalk.dim('\n  Set LINEAR_API_KEY in your environment (Linear → Settings → API).'))
  } else {
    console.log(chalk.dim('\n  Create the app, then set LINEAR_CLIENT_ID and LINEAR_CLIENT_SECRET.'))
    console.log(chalk.dim('  Walkthrough: docs/linear-identity.md'))
  }
  return { mode, teamKeys }
}

async function promptConnectionType(
  currentTunnel: 'localhost.run' | 'smee' | undefined,
  opts: OnboardOpts,
): Promise<'localhost.run' | 'smee'> {
  if (opts.yes) {
    const backend = currentTunnel ?? 'localhost.run'
    console.log(`  Connection: ${chalk.cyan(backend)}`)
    return backend
  }

  const items: PickerItem[] = [
    {
      label: 'localhost.run',
      description: 'zero-config SSH tunnel — reconnects automatically, no install needed',
    },
    {
      label: 'smee.io',
      description: 'webhook relay — events queued while offline, stable channel URL',
      hint: 'Get a free channel URL at smee.io/new — you\'ll paste it in the next step',
    },
  ]
  const defaultIdx = currentTunnel === 'smee' ? 1 : 0

  const idx = await promptSinglePicker(items, {
    title: 'How will GitHub reach your crosscheck server?',
    defaultIndex: defaultIdx,
  })
  console.log()

  return idx === 1 ? 'smee' : 'localhost.run'
}

async function promptCloneProtocol(
  currentProtocol: 'ssh' | 'https' | undefined,
  opts: OnboardOpts,
): Promise<'ssh' | 'https'> {
  if (opts.yes) {
    const protocol = currentProtocol ?? 'ssh'
    console.log(`  Clone protocol: ${chalk.cyan(protocol)}`)
    return protocol
  }

  const items: PickerItem[] = [
    {
      label: 'ssh',
      description: 'git@github.com:owner/repo.git — uses your local SSH keys',
    },
    {
      label: 'https',
      description: 'https://github.com/owner/repo.git — uses GitHub token',
      hint: 'Pick https if SSH clone fails or you prefer token-based auth',
    },
  ]
  const defaultIdx = currentProtocol === 'https' ? 1 : 0

  const idx = await promptSinglePicker(items, {
    title: 'How should crosscheck clone PR repos for review?',
    defaultIndex: defaultIdx,
  })
  console.log()

  return idx === 1 ? 'https' : 'ssh'
}

export interface OnboardDecisions {
  deployment: 'personal' | 'team'
  login: string
  selectedRepos: string[]
  selectedOrgs: string[]
  vendorConfig: VendorModeConfig
  authorVendor: 'claude' | 'codex' | 'both'
  qualityTier: QualityTier
  pipelinePreset: WorkflowPreset
  maxRounds?: number  // only relevant for review-fix-recheck; defaults to 1
  conflictResolve: boolean  // opt-in; prepends a conflict-resolve step before review
  tunnelBackend: 'localhost.run' | 'smee'
  smeeChannel: string
  cloneProtocol: 'ssh' | 'https'
  linear?: LinearDecision
}

// Build the workflow YAML for the given preset, with inline per-step instructions.
// Written to ~/.crosscheck/workflow.yml on first onboard. On re-runs, regenerated
// only when the step-type sequence drifts from the selected preset.
function buildWorkflowYaml(preset: WorkflowPreset, maxRounds = 1, conflictResolve = false): string {
  const conflictResolveStep = {
    name: 'conflict-resolve',
    type: 'conflict-resolve',
    reviewer: 'origin',
    max_rounds: 3,
    instructions: DEFAULT_CONFLICT_RESOLVE_INSTRUCTIONS,
  }
  const reviewStep = {
    name: 'review',
    type: 'review',
    reviewer: 'auto',
    max_rounds: 1,
    instructions: DEFAULT_REVIEW_INSTRUCTIONS,
  }
  const fixStep = {
    name: 'fix',
    type: 'fix',
    reviewer: 'origin',
    when: "review.verdict != 'APPROVE'",
    max_rounds: maxRounds,
    instructions: DEFAULT_FIX_INSTRUCTIONS,
  }
  const recheckStep = {
    name: 'recheck',
    type: 'recheck',
    reviewer: 'auto',
    when: "fix.applied_count > 0",
    max_rounds: maxRounds,
    instructions: DEFAULT_RECHECK_INSTRUCTIONS,
  }

  let steps
  if (preset === 'review-only') steps = [reviewStep]
  else if (preset === 'review-fix') steps = [reviewStep, fixStep]
  else steps = [reviewStep, fixStep, recheckStep]

  if (conflictResolve) steps = [conflictResolveStep, ...steps]

  const header = [
    '# crosscheck workflow — generated by crosscheck onboard',
    '# Edit this file to customize your pipeline. Re-running onboard preserves this file.',
    '# Place a .crosscheck/workflow.yml in your project root to override this global file.',
    '',
  ].join('\n')

  return header + yaml.dump({ on: ['opened', 'synchronize'], steps }, { lineWidth: -1, noRefs: true })
}

// Writes all onboard decisions to configPath and manages the global workflow.yml.
// On re-runs, only the fields onboard owns are updated; everything else is preserved.
export function applyOnboardConfig(
  configPath: string,
  decisions: OnboardDecisions,
  workflowDir = join(homedir(), '.crosscheck'),
): void {
  const { deployment, login, selectedRepos, selectedOrgs, vendorConfig, qualityTier, pipelinePreset, maxRounds, conflictResolve, tunnelBackend, smeeChannel, cloneProtocol, linear } = decisions

  mkdirSync(dirname(configPath), { recursive: true })

  // Load existing config (preserves all custom fields) or start fresh
  const raw: Record<string, unknown> = existsSync(configPath)
    ? ((yaml.load(readFileSync(configPath, 'utf8')) ?? {}) as Record<string, unknown>)
    : {}

  // ── Fields onboard always owns ─────────────────────────────────────────────
  raw.deployment = deployment
  raw.orgs = selectedOrgs
  raw.mode = vendorConfig.mode
  raw.clone_protocol = cloneProtocol

  // Repos. Per-repo workflow depth is NOT stored here — it lives in standalone
  // files under ~/.crosscheck/workflows/ (written by `crosscheck alter`).
  raw.repos = selectedRepos.map(r => {
    const [owner, name] = r.split('/')
    return { owner, name }
  })

  // Users: personal mode captures the login; team mode never uses users
  if (deployment === 'personal' && login) {
    raw.users = [login]
  } else {
    delete raw.users  // team mode, or personal with no login
  }
  // Scope covered by repos/orgs — users entry not needed even in personal mode
  if (selectedRepos.length > 0 || selectedOrgs.length > 0) {
    delete raw.users
  }

  // ── Routing: initialise missing fields; never overwrite fields that are set ──
  // Guards on individual fields so a partial routing object (e.g. from an
  // unpatched example config) still gets the personal-mode defaults filled in.
  if (!raw.routing || typeof raw.routing !== 'object') raw.routing = {}
  const routing = raw.routing as Record<string, unknown>

  if (deployment === 'personal' && login) {
    const currentAuthors = Array.isArray(routing.allowed_authors) ? (routing.allowed_authors as string[]) : []
    if (currentAuthors.length === 0) routing.allowed_authors = [login]

    if (decisions.vendorConfig.mode === 'cross-vendor') {
      const currentRoutes = routing.author_routes != null && typeof routing.author_routes === 'object'
        ? { ...(routing.author_routes as Record<string, string>) }
        : {}
      if (decisions.authorVendor === 'both') {
        delete currentRoutes[login]
        if (Object.keys(currentRoutes).length > 0) {
          routing.author_routes = currentRoutes
        } else {
          delete routing.author_routes
        }
      } else {
        routing.author_routes = { ...currentRoutes, [login]: decisions.authorVendor }
      }
    }
  }
  if (routing.fallback_reviewer === undefined) routing.fallback_reviewer = 'auto'

  // ── Vendors ─────────────────────────────────────────────────────────────────
  if (!raw.vendors || typeof raw.vendors !== 'object') raw.vendors = {}
  const vendors = raw.vendors as Record<string, Record<string, unknown>>
  if (!vendors.claude) vendors.claude = {}
  if (!vendors.codex) vendors.codex = {}
  vendors.claude.enabled = vendorConfig.claudeEnabled
  vendors.codex.enabled = vendorConfig.codexEnabled

  // ── Tunnel ──────────────────────────────────────────────────────────────────
  if (!raw.tunnel || typeof raw.tunnel !== 'object') raw.tunnel = {}
  const tunnelObj = raw.tunnel as Record<string, unknown>
  tunnelObj.backend = tunnelBackend
  if (tunnelBackend === 'smee' && smeeChannel) tunnelObj.smee_channel = smeeChannel

  // ── Linear write-back ───────────────────────────────────────────────────────
  // Only touched when onboard actually asked. Auth env-var names and the signature
  // template are left alone so hand-edits survive a re-run.
  if (linear) {
    if (!raw.linear || typeof raw.linear !== 'object') raw.linear = {}
    const linearObj = raw.linear as Record<string, unknown>
    linearObj.enabled = linear.mode !== 'off'
    if (linear.mode !== 'off') {
      if (!linearObj.auth || typeof linearObj.auth !== 'object') linearObj.auth = {}
      ;(linearObj.auth as Record<string, unknown>).mode = linear.mode
      // Write the selection even when empty — otherwise the `-` clear silently
      // leaves the previous keys in the file and nothing appears to happen.
      linearObj.team_keys = linear.teamKeys
    }
  }

  // ── Quality tier + per-vendor effort ────────────────────────────────────────
  // claude.ts derives the model from quality.tier at runtime (vendor.model is ignored).
  // vendor.model is written for codex only — it pins the review model under both
  // auth modes (subscription passes it to the CLI via -c model=).
  if (!raw.quality || typeof raw.quality !== 'object') raw.quality = {}
  ;(raw.quality as Record<string, unknown>).tier = qualityTier
  const tierCfg = QUALITY_TIERS[qualityTier]
  vendors.claude.effort = tierCfg.claude.effort
  vendors.codex.model = tierCfg.codex.model
  vendors.codex.effort = tierCfg.codex.effort

  // ── Fix delivery mechanism (operational config, not pipeline logic) ──────────
  // Pipeline steps and trigger conditions live in workflow.yml.
  // config.yml only retains how fixes land on the PR (commit / pull_request / comment).
  if (!raw.post_review || typeof raw.post_review !== 'object') raw.post_review = {}
  const postReview = raw.post_review as Record<string, unknown>
  if (!postReview.auto_fix || typeof postReview.auto_fix !== 'object') postReview.auto_fix = {}
  const autoFix = postReview.auto_fix as Record<string, unknown>
  // Remove stale fields written by pre-refactor onboard runs
  delete autoFix.enabled
  delete autoFix.trigger
  delete autoFix.min_severity
  delete autoFix.fixer
  if (!autoFix.delivery || typeof autoFix.delivery !== 'object') autoFix.delivery = {}
  const delivery = autoFix.delivery as Record<string, unknown>
  if (!delivery.mode) delivery.mode = 'commit'

  writeFileSync(configPath, yaml.dump(raw, { lineWidth: -1, noRefs: true }))

  // ── Global workflow.yml ──────────────────────────────────────────────────────
  // Written on first onboard. On re-runs, regenerated when the existing step
  // sequence does not match the selected preset — covers both upgrades (missing
  // types) and downgrades (extra types). When the sequence matches exactly, the
  // file is preserved so user edits to instructions survive.
  const globalWorkflowPath = join(workflowDir, 'workflow.yml')
  mkdirSync(workflowDir, { recursive: true })

  const presetStepTypes: Record<WorkflowPreset, string[]> = {
    'review-only': ['review'],
    'review-fix': ['review', 'fix'],
    'review-fix-recheck': ['review', 'fix', 'recheck'],
  }
  const requiredSet = new Set(presetStepTypes[pipelinePreset])
  if (conflictResolve) requiredSet.add('conflict-resolve')

  const effectiveMaxRounds = maxRounds ?? 1

  if (!existsSync(globalWorkflowPath)) {
    writeFileSync(globalWorkflowPath, buildWorkflowYaml(pipelinePreset, effectiveMaxRounds, conflictResolve))
  } else {
    try {
      const existingRaw = yaml.load(readFileSync(globalWorkflowPath, 'utf8')) as { steps?: Array<{ type?: string; max_rounds?: number }> }
      // Normalize legacy 'address' → 'fix' so workflow.yml files written by older
      // crosscheck versions are not regenerated solely on the renamed step type
      // (matches the schema-level transform in workflow.ts). Steps without a
      // type field are filtered out. Set comparison (not sequence) so user-added
      // duplicate steps or reordered steps are treated as equivalent and preserved.
      const existingSteps = existingRaw?.steps ?? []
      const existingSet = new Set(
        existingSteps
          .map(s => (s.type === 'address' ? 'fix' : s.type))
          .filter((t): t is string => Boolean(t)),
      )
      const setsMatch =
        requiredSet.size === existingSet.size && [...requiredSet].every(t => existingSet.has(t))

      // Also regenerate when max_rounds has changed on any fix or recheck step
      const existingMaxRounds = existingSteps
        .filter(s => s.type === 'fix' || s.type === 'recheck')
        .map(s => s.max_rounds ?? 1)
      const maxRoundsDrifted = existingMaxRounds.length > 0
        && existingMaxRounds.some(r => r !== effectiveMaxRounds)

      if (!setsMatch) {
        // Preset changed — regenerate from template (step types differ)
        writeFileSync(globalWorkflowPath, buildWorkflowYaml(pipelinePreset, effectiveMaxRounds, conflictResolve))
      } else if (maxRoundsDrifted) {
        // Preset unchanged, only max_rounds changed — patch in-place to preserve
        // any custom instructions or structural edits the user may have made.
        const patchedSteps = existingSteps.map(s => {
          if (s.type === 'fix' || s.type === 'recheck') {
            return { ...s, max_rounds: effectiveMaxRounds }
          }
          return s
        })
        const patchedRaw = { ...(existingRaw as object), steps: patchedSteps }
        writeFileSync(globalWorkflowPath, yaml.dump(patchedRaw, { lineWidth: -1, noRefs: true }))
      }
      // No drift — preserve existing file (may have user-edited instructions or structural customizations)
    } catch {
      // Malformed workflow file — regenerate
      writeFileSync(globalWorkflowPath, buildWorkflowYaml(pipelinePreset, effectiveMaxRounds, conflictResolve))
    }
  }
}

export async function runOnboard(opts: OnboardOpts = {}) {
  if (!process.stdin.isTTY) {
    console.error(chalk.red('onboard requires an interactive terminal.'))
    console.error(chalk.dim('Run crosscheck init and edit crosscheck.config.yml manually.'))
    process.exit(1)
  }

  console.log(chalk.bold('\ncrosscheck onboard\n'))

  // ── Step 1: Auth check ─────────────────────────────────────────────────────
  console.log(chalk.bold('Step 1 — environment check'))
  const env = await checkEnv()
  if (!env.ok) process.exit(1)
  console.log()

  // ── Step 2: Deployment mode ────────────────────────────────────────────────
  console.log(chalk.bold('Step 2 — deployment mode'))
  const configPath = opts.config ?? resolveConfigPath() ?? join(homedir(), '.crosscheck', 'config.yml')
  const existingConfig = existsSync(configPath) ? loadConfig(configPath) : null
  const currentDeployment = existingConfig?.deployment

  let deployment: 'personal' | 'team'
  if (opts.personal) {
    deployment = 'personal'
    console.log(`  Mode: ${chalk.cyan('personal')} (--personal flag)`)
  } else if (opts.team) {
    deployment = 'team'
    console.log(`  Mode: ${chalk.cyan('team')} (--team flag)`)
  } else if (opts.yes && currentDeployment) {
    deployment = currentDeployment
    console.log(`  Mode: ${chalk.cyan(deployment)}`)
  } else {
    const deployItems: PickerItem[] = [
      { label: 'personal', description: 'monitor your own repos; review only your PRs' },
      { label: 'team', description: 'monitor org repos; review all PRs from any author' },
    ]
    const defaultDeployIdx = currentDeployment === 'team' ? 1 : 0
    const deployIdx = await promptSinglePicker(deployItems, {
      title: 'How are you using crosscheck?',
      defaultIndex: defaultDeployIdx,
    })
    deployment = deployIdx === 1 ? 'team' : 'personal'
  }
  console.log()

  // ── Step 3: Repo selection (hierarchical: namespace → repos) ───────────────
  console.log(chalk.bold('Step 3 — select repos to monitor'))

  let token: string
  try {
    token = getGithubToken()
  } catch (err: unknown) {
    console.error(chalk.red(err instanceof Error ? err.message : String(err)))
    process.exit(1)
  }

  const login = detectGitHubLogin() ?? ''
  console.log(chalk.dim(`  Fetching repos for ${login || 'your account'}...`))

  const [personalActivityRepos, orgs] = await Promise.all([
    login ? fetchActiveRepos(login, token).catch((): RepoActivity[] => []) : Promise.resolve<RepoActivity[]>([]),
    listUserOrgs(token).catch((): string[] => []),
  ])

  type OrgRepo = Awaited<ReturnType<typeof listOrgRepos>>[number]
  const orgRepoLists = await Promise.all(
    orgs.map(org => listOrgRepos(org, token).catch((): OrgRepo[] => []))
  )

  const currentRepoKeys = new Set(
    (existingConfig?.repos ?? []).map(r => `${r.owner}/${r.name}`)
  )
  const currentOrgs = new Set(existingConfig?.orgs ?? [])

  let selectedRepos: string[]
  let selectedOrgs: string[]

  if (opts.yes && existingConfig) {
    selectedRepos = [...currentRepoKeys]
    selectedOrgs = [...currentOrgs]
    console.log(`  Using existing repo selection (${selectedRepos.length} repos, ${selectedOrgs.length} orgs)`)
  } else {
    const totalRepos = personalActivityRepos.length + orgRepoLists.reduce((sum, l) => sum + l.length, 0)

    if (totalRepos === 0) {
      console.log(chalk.yellow('  No repos found. You can add repos manually in your config file.'))
      selectedRepos = []
      selectedOrgs = []
    } else {
      console.log()
      selectedRepos = []
      selectedOrgs = [...currentOrgs]

      // Build namespace list: personal account + each org
      const namespaces: string[] = []
      if (login && personalActivityRepos.length > 0) namespaces.push(login)
      for (const org of orgs) namespaces.push(org)

      let namespacesToBrowse: string[]

      if (namespaces.length <= 1) {
        // Only one namespace — skip group picker
        namespacesToBrowse = namespaces
      } else {
        // Step 3a: pick which namespaces to browse
        const nsDescriptions = new Map<string, string>()
        if (login) {
          const c = personalActivityRepos.length
          nsDescriptions.set(login, `personal · ${c} repo${c === 1 ? '' : 's'}`)
        }
        for (let i = 0; i < orgs.length; i++) {
          const c = orgRepoLists[i].length
          nsDescriptions.set(orgs[i], `org · ${c} repo${c === 1 ? '' : 's'}`)
        }

        // Pre-select namespaces that already have configured repos/orgs; default all on first run
        const currentNamespaces = new Set<string>()
        for (const key of currentRepoKeys) currentNamespaces.add(key.split('/')[0])
        for (const org of currentOrgs) currentNamespaces.add(org)
        const initialNs = currentNamespaces.size === 0
          ? namespaces
          : namespaces.filter(ns => currentNamespaces.has(ns))

        namespacesToBrowse = await promptRepoPicker(namespaces, {
          title: 'Which accounts do you want to browse?',
          initialSelected: initialNs,
          getDescription: (ns) => nsDescriptions.get(ns) ?? '',
          pageSize: Math.min(namespaces.length, 6),
        })
        console.log()
      }

      // Step 3b: for each selected namespace, show a focused repo picker
      for (const ns of namespacesToBrowse) {
        let repoKeys: string[]
        const descMap = new Map<string, string>()

        if (ns === login) {
          // Personal repos — already sorted by activity (tier 1 → tier 3, then pushedAt desc)
          repoKeys = personalActivityRepos.map(r => r.fullName)
          for (const r of personalActivityRepos) {
            descMap.set(r.fullName, formatAge(r.pushedAt))
          }
        } else {
          // Org repos — already sorted by pushedAt desc (sort=pushed in API call)
          const orgIdx = orgs.indexOf(ns)
          const orgRepos = orgIdx >= 0 ? orgRepoLists[orgIdx] : []
          repoKeys = orgRepos.map(r => `${r.owner}/${r.name}`)
          for (const r of orgRepos) {
            if (r.pushedAt) descMap.set(`${r.owner}/${r.name}`, formatAge(r.pushedAt))
          }
        }

        if (repoKeys.length === 0) continue

        const initialSel = repoKeys.filter(k => currentRepoKeys.has(k))

        const picked = await promptRepoPicker(repoKeys, {
          title: `Select repos from ${ns}:`,
          initialSelected: initialSel,
          getDescription: (key) => descMap.get(key) ?? '',
          pageSize: 5,
        })
        console.log()
        selectedRepos.push(...picked)
      }

      // Offer org-level monitoring when 3+ repos from the same org are selected
      const orgSet = new Set(orgs)
      const orgCounts: Record<string, number> = {}
      for (const r of selectedRepos) {
        const owner = r.split('/')[0]
        if (orgSet.has(owner)) orgCounts[owner] = (orgCounts[owner] ?? 0) + 1
      }
      const orgOffers = Object.entries(orgCounts)
        .filter(([, count]) => count >= 3)
        .map(([org]) => org)

      for (const org of orgOffers) {
        if (currentOrgs.has(org)) continue
        const answer = opts.yes ? 'n' : await ask(`  Monitor all of ${chalk.cyan(org)} instead of individual repos? [y/N]: `)
        if (answer.toLowerCase() === 'y') {
          selectedOrgs.push(org)
          selectedRepos = selectedRepos.filter(r => !r.startsWith(`${org}/`))
        }
      }
    }
  }
  console.log()

  // ── Step 4: Review mode (cross-vendor vs single-vendor) ───────────────────
  console.log(chalk.bold('Step 4 — review mode'))
  const vendorConfig = await promptVendorMode(
    env.claudeOk,
    env.codexOk,
    existingConfig?.mode,
    existingConfig?.vendors?.claude?.enabled ?? true,
    existingConfig?.vendors?.codex?.enabled ?? true,
    opts,
  )
  console.log()

  // ── Step 5: Primary author (cross-vendor + personal only) ───────────────────
  console.log(chalk.bold('Step 5 — primary author'))
  let authorVendor: 'claude' | 'codex' | 'both' = 'both'
  if (vendorConfig.mode === 'cross-vendor' && deployment === 'personal') {
    const existingRoutes = (existingConfig?.routing?.author_routes as Record<string, string> | undefined) ?? null
    authorVendor = await promptAuthorVendor(login, existingRoutes, opts)
  } else {
    const reason = vendorConfig.mode === 'single-vendor' ? 'single-vendor mode' : 'team mode'
    console.log(chalk.dim(`  Skipped — not applicable in ${reason}.`))
    console.log()
  }

  // ── Step 6: Review quality ────────────────────────────────────────────────
  console.log(chalk.bold('Step 6 — review quality'))
  const qualityTier = await promptQualityTier(
    vendorConfig.claudeEnabled,
    vendorConfig.codexEnabled,
    existingConfig?.quality?.tier,
    opts,
  )
  console.log()

  // ── Step 7: Workflow pipeline ──────────────────────────────────────────────
  console.log(chalk.bold('Step 7 — workflow pipeline'))
  const pipelinePreset = await promptWorkflowPipeline(opts)
  console.log()

  // ── Step 7.5: Max rounds (review-fix-recheck only) ────────────────────────
  let maxRounds: number | undefined
  if (pipelinePreset === 'review-fix-recheck') {
    console.log(chalk.bold('Step 7.5 — fix → re-check rounds'))
    const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
    let currentMaxRounds: number | undefined
    if (existsSync(globalWorkflowPath)) {
      try {
        const raw = yaml.load(readFileSync(globalWorkflowPath, 'utf8')) as { steps?: Array<{ type?: string; max_rounds?: number }> }
        const fixOrRecheckStep = (raw?.steps ?? []).find(s => s.type === 'fix' || s.type === 'recheck')
        currentMaxRounds = fixOrRecheckStep?.max_rounds
      } catch { /* malformed — use default */ }
    }
    maxRounds = await promptMaxRounds(currentMaxRounds, opts)
    console.log()
  }

  // ── Step 7.7: Auto-conflict-resolve (opt-in) ──────────────────────────────
  console.log(chalk.bold('Step 7.7 — auto conflict-resolve'))
  const currentConflictResolve = detectConflictResolveEnabled()
  const conflictResolve = await promptConflictResolve(currentConflictResolve, opts)
  console.log()

  // ── Step 8: Connection type ────────────────────────────────────────────────
  console.log(chalk.bold('Step 8 — connection type'))
  const currentTunnel = existingConfig?.tunnel?.backend
  let tunnelBackend = await promptConnectionType(currentTunnel, opts)

  let smeeChannel = existingConfig?.tunnel?.smee_channel ?? ''
  if (tunnelBackend === 'smee') {
    if (smeeChannel) {
      console.log(`  smee channel ${chalk.cyan(smeeChannel)}`)
    } else if (!opts.yes) {
      console.log(chalk.dim('  Paste your smee.io channel URL below (leave blank to use localhost.run instead).\n'))
      const channel = await ask('  smee channel URL: ')
      if (channel) {
        smeeChannel = channel
      } else {
        tunnelBackend = 'localhost.run'
        console.log(chalk.yellow('  No channel provided — falling back to localhost.run.'))
      }
    } else {
      tunnelBackend = 'localhost.run'
      console.log(chalk.yellow('  smee selected but no channel configured — falling back to localhost.run.'))
      console.log(chalk.dim('  Set tunnel.smee_channel in config.yml and re-run onboard to use smee.io.'))
    }
  }
  console.log()

  // ── Step 9: Clone protocol ─────────────────────────────────────────────────
  console.log(chalk.bold('Step 9 — clone protocol'))
  const cloneProtocol = await promptCloneProtocol(existingConfig?.clone_protocol, opts)
  console.log()

  // ── Step 9.5: Linear write-back ────────────────────────────────────────────
  console.log(chalk.bold('Step 9.5 — Linear write-back (optional)'))
  const linear = await promptLinear(
    {
      enabled: existingConfig?.linear?.enabled,
      mode: existingConfig?.linear?.auth?.mode,
      teamKeys: existingConfig?.linear?.team_keys,
    },
    opts,
  )

  // ── Step 10: Confirm and write ─────────────────────────────────────────────
  const selectedRepoWorkflowOverrides = selectedRepos.flatMap(repoKey => {
    const [owner, name] = repoKey.split('/')
    const steps = readRepoWorkflowStepTypes(owner, name)
    return steps ? [`${repoKey}: ${formatRepoWorkflowSteps(steps)}`] : []
  })

  console.log(chalk.bold('Step 10 — review and write config'))
  console.log()
  console.log(`  deployment   ${chalk.cyan(deployment)}`)
  console.log(`  connection   ${chalk.cyan(tunnelBackend)}${tunnelBackend === 'smee' && smeeChannel ? chalk.dim(` (${smeeChannel})`) : ''}`)
  console.log(`  clone        ${chalk.cyan(cloneProtocol)}`)
  console.log(`  linear       ${chalk.cyan(linear.mode === 'off' ? 'off' : linear.mode)}${linear.mode !== 'off' && linear.teamKeys.length > 0 ? chalk.dim(` (${linear.teamKeys.join(', ')})`) : ''}`)
  console.log(`  mode         ${chalk.cyan(vendorConfig.mode)}`)
  if (vendorConfig.mode === 'single-vendor') {
    const activeVendor = vendorConfig.claudeEnabled ? 'claude' : 'codex'
    console.log(`  vendor       ${chalk.cyan(activeVendor)}`)
  }
  if (vendorConfig.mode === 'cross-vendor' && deployment === 'personal') {
    const routingLabel = authorVendor === 'both'
      ? 'both (attribution detection only)'
      : `${authorVendor} → reviewed by ${authorVendor === 'claude' ? 'codex' : 'claude'}`
    console.log(`  routing      ${chalk.cyan(routingLabel)}`)
  }
  console.log(`  quality      ${chalk.cyan(qualityTier)}${chalk.dim(`  — ${QUALITY_TIERS[qualityTier].description.split('  ')[0]}`)}`)
  console.log(`  pipeline     ${chalk.cyan(pipelinePreset)}`)
  if (pipelinePreset === 'review-fix-recheck') {
    console.log(`  max rounds   ${chalk.cyan(String(maxRounds ?? 1))}`)
  }
  console.log(`  conflict-resolve  ${chalk.cyan(conflictResolve ? 'yes' : 'no')}`)
  if (selectedOrgs.length > 0) {
    console.log(`  orgs         ${selectedOrgs.map(o => chalk.cyan(o)).join(', ')}`)
  }
  if (selectedRepos.length > 0) {
    console.log(`  repos        ${selectedRepos.slice(0, 5).map(r => chalk.cyan(r)).join(', ')}${selectedRepos.length > 5 ? chalk.dim(` +${selectedRepos.length - 5} more`) : ''}`)
  }
  if (selectedRepoWorkflowOverrides.length > 0) {
    console.log(`  repo rules   ${selectedRepoWorkflowOverrides.slice(0, 3).map(r => chalk.cyan(r)).join(', ')}${selectedRepoWorkflowOverrides.length > 3 ? chalk.dim(` +${selectedRepoWorkflowOverrides.length - 3} more`) : ''}`)
  }
  if (selectedOrgs.length === 0 && selectedRepos.length === 0) {
    console.log(`  ${chalk.yellow('No repos or orgs selected. Config will have empty scope.')}`)
  }
  console.log(`  config       ${chalk.dim(configPath)}`)
  console.log(`  workflow     ${chalk.dim(join(homedir(), '.crosscheck', 'workflow.yml'))}`)
  console.log()

  if (!opts.yes) {
    const confirm = await ask(`  Write to config? [Y/n]: `)
    if (confirm.toLowerCase() === 'n') {
      console.log(chalk.dim('  Aborted — no changes written.'))
      return
    }
  }

  const globalWorkflowPath = join(homedir(), '.crosscheck', 'workflow.yml')
  const hadWorkflow = existsSync(globalWorkflowPath)

  applyOnboardConfig(configPath, {
    deployment,
    login,
    selectedRepos,
    selectedOrgs,
    vendorConfig,
    authorVendor,
    qualityTier,
    pipelinePreset,
    maxRounds,
    conflictResolve,
    tunnelBackend,
    smeeChannel,
    cloneProtocol,
    linear,
  })

  console.log(chalk.green(`  ✓ config written to ${configPath}`))
  if (!hadWorkflow) {
    console.log(chalk.green(`  ✓ workflow written to ${globalWorkflowPath}`))
  } else {
    console.log(chalk.dim(`  keeping existing workflow at ${globalWorkflowPath}`))
  }

  console.log()

  // ── Next step hint ─────────────────────────────────────────────────────────
  console.log(chalk.dim('  Run crosscheck watch to start monitoring.'))
  const alterExample = selectedRepos[0] ?? 'owner/repo'
  console.log(chalk.dim(`  Tune one repo later: crosscheck alter ${alterExample} --review-only\n`))
}
