import { execa } from 'execa'
import { checkCodexAuth } from '../reviewers/codex.js'
import { checkOpenCodeAuth } from '../reviewers/opencode.js'
import { promptRepoPicker, promptSinglePicker, type PickerItem, type PickerOptions } from './repo-picker.js'
import type { Vendor } from './vendor.js'

export interface ReviewerReadiness {
  installed: boolean
  authenticated: boolean
  detail: string
}
export interface ReviewerSetupResult {
  selected: Vendor[]
  skipped: Vendor[]
}
export interface ReviewerSetupDependencies {
  probe: (vendor: Vendor) => Promise<ReviewerReadiness>
  select: (items: string[], options: PickerOptions) => Promise<string[]>
  choose: (items: PickerItem[], options: { title: string; defaultIndex?: number }) => Promise<number>
  run: (command: string, args: string[]) => Promise<void>
  report: (message: string) => void
}

const VENDORS: Vendor[] = ['claude', 'codex', 'opencode']
const PACKAGES: Record<Vendor, string> = {
  claude: '@anthropic-ai/claude-code', codex: '@openai/codex', opencode: '@opencode/cli',
}
const LOGIN_ARGS: Record<Vendor, string[]> = {
  claude: ['auth', 'login'], codex: ['login', '--device-auth'], opencode: ['auth', 'login'],
}
const AUTH_CHECKS = { codex: checkCodexAuth, opencode: checkOpenCodeAuth }

export async function probeReviewerReadiness(vendor: Vendor): Promise<ReviewerReadiness> {
  try {
    await execa(vendor, ['--version'], { timeout: 10_000 })
  } catch (err: unknown) {
    // Only ENOENT means missing. A broken install needs repair, not a false
    // authenticated signal or a login attempt against a nonexistent tool.
    const error = err as { code?: string }
    return { installed: error.code !== 'ENOENT', authenticated: false, detail: error.code === 'ENOENT' ? 'not installed' : 'CLI could not start; reinstall or repair it' }
  }
  try {
    if (vendor === 'claude') {
      const { stdout } = await execa('claude', ['auth', 'status', '--json'], { timeout: 10_000 })
      const auth: unknown = JSON.parse(stdout)
      const authenticated = typeof auth === 'object' && auth !== null && 'loggedIn' in auth && auth.loggedIn === true
      return { installed: true, authenticated, detail: authenticated ? 'logged in' : 'login needed' }
    }
    const auth = await AUTH_CHECKS[vendor]()
    return { installed: true, authenticated: auth.ok, detail: auth.detail }
  } catch {
    return { installed: true, authenticated: false, detail: 'authentication check failed; log in and retry' }
  }
}

const DEFAULT_DEPENDENCIES: ReviewerSetupDependencies = {
  probe: probeReviewerReadiness,
  select: promptRepoPicker,
  choose: promptSinglePicker,
  run: async (command, args) => {
    // Pickers resume the parent stream. Pause it so it cannot consume keys
    // intended for the login CLI sharing this terminal; the next picker resumes it.
    process.stdin.pause()
    await execa(command, args, { stdio: 'inherit' })
  },
  report: message => console.log(message),
}

/** Interactive only. Missing tools remain selectable; no config is written here. */
export async function setupReviewerTools(
  existingSelection?: Vendor[],
  dependencies: ReviewerSetupDependencies = DEFAULT_DEPENDENCIES,
): Promise<ReviewerSetupResult> {
  const statuses = await Promise.all(VENDORS.map(async vendor => ({ vendor, status: await dependencies.probe(vendor) })))
  const readiness = Object.fromEntries(statuses.map(({ vendor, status }) => [vendor, status])) as Record<Vendor, ReviewerReadiness>
  const initialSelected = existingSelection ?? VENDORS.filter(vendor => readiness[vendor].authenticated && vendor !== 'opencode')
  dependencies.report('Select the tools you want to use. Missing tools can be installed next; space toggles, enter continues.')
  const requested = await dependencies.select(VENDORS, {
    title: 'Which reviewer tools would you like to use?', initialSelected,
    getDescription: vendor => {
      const status = readiness[vendor as Vendor]
      return status.authenticated ? 'ready' : status.installed ? 'login or repair needed' : 'not installed — setup available'
    },
  })
  if (requested.length === 0) throw new Error('No reviewer tools selected; config was not written.')
  if (requested.some(vendor => !VENDORS.includes(vendor as Vendor))) throw new Error('Invalid reviewer tool selected; config was not written.')
  const selected: Vendor[] = []
  const skipped: Vendor[] = []

  async function prepare(vendor: Vendor, status: ReviewerReadiness): Promise<boolean> {
    if (status.installed && status.authenticated) return true
    const install = ['install', '--global', PACKAGES[vendor]]
    const login = LOGIN_ARGS[vendor]
    dependencies.report(`  ${vendor}: ${status.detail}`)
    dependencies.report(`  Install/update: npm ${install.join(' ')}`)
    dependencies.report(`  Log in: ${vendor} ${login.join(' ')}`)
    const actions = [
      ...(status.installed ? [{ action: 'login', label: 'Log in now', description: `Run ${vendor} ${login.join(' ')}` }] : []),
      { action: 'install', label: status.installed ? 'Reinstall/update' : 'Install now', description: `Run npm ${install.join(' ')}` },
      { action: 'retry', label: 'Check again', description: 'After installing or logging in in another terminal' },
      { action: 'skip', label: 'Skip this tool', description: 'Continue with the other selected tools' },
      { action: 'abort', label: 'Cancel setup', description: 'Leave existing configuration unchanged' },
    ]
    const index = await dependencies.choose(actions, { title: `Set up ${vendor}` })
    const action = actions[index]?.action
    if (action === 'skip') return false
    if (action === 'abort') throw new Error('Reviewer setup canceled; config was not written.')
    if (!action) throw new Error('Invalid setup action; config was not written.')
    if (action === 'install' || action === 'login') {
      try {
        await dependencies.run(action === 'install' ? 'npm' : vendor, action === 'install' ? install : login)
      } catch {
        dependencies.report(`  ${vendor}: command failed or was canceled. Fix it in another terminal, check again, or skip this tool.`)
      }
    }
    // A successful installer/login exit is not readiness evidence: re-probe.
    return prepare(vendor, await dependencies.probe(vendor))
  }

  async function prepareNext(index: number): Promise<void> {
    if (index >= requested.length) return
    const vendor = requested[index] as Vendor
    if (await prepare(vendor, readiness[vendor])) selected.push(vendor)
    else skipped.push(vendor)
    await prepareNext(index + 1)
  }
  await prepareNext(0)
  if (selected.length === 0) throw new Error('No selected reviewer is ready; config was not written. Rerun onboard after installing and logging in.')

  // Recheck all retained tools after setup, before allowing persistence. A tool
  // that lost auth while another was being installed must not be enabled.
  const verified = await Promise.all(selected.map(async vendor => ({ vendor, status: await dependencies.probe(vendor) })))
  if (verified.some(({ status }) => !status.installed || !status.authenticated)) {
    throw new Error('A selected reviewer is no longer ready; rerun onboard. Config was not written.')
  }
  dependencies.report(`  Ready: ${selected.join(', ')}`)
  if (skipped.length > 0) dependencies.report(`  Skipped (disabled): ${skipped.join(', ')}`)
  return { selected, skipped }
}
