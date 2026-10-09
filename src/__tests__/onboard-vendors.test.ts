import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import yaml from 'js-yaml'
import { applyOnboardConfig, enabledOnboardVendors, promptVendorMode, type OnboardDecisions } from '../commands/onboard.js'
import { promptSinglePicker } from '../lib/repo-picker.js'

vi.mock('../lib/repo-picker.js', async importOriginal => {
  const actual = await importOriginal<typeof import('../lib/repo-picker.js')>()
  return { ...actual, promptSinglePicker: vi.fn() }
})

const picker = vi.mocked(promptSinglePicker)
const vendors = ['claude', 'codex', 'opencode'] as const
const decisions: OnboardDecisions = {
  deployment: 'personal', login: 'alice', selectedRepos: ['alice/service'], selectedOrgs: [],
  vendorConfig: { mode: 'single-vendor', claudeEnabled: false, codexEnabled: false, opencodeEnabled: true },
  authorVendor: 'both', qualityTier: 'balanced', qualityMode: 'fixed', enabledSkills: [],
  pipelinePreset: 'review-only', conflictResolve: false, tunnelBackend: 'localhost.run', smeeChannel: '', cloneProtocol: 'ssh',
}
let directory: string
beforeEach(() => {
  vi.clearAllMocks()
  vi.spyOn(console, 'log').mockImplementation(() => {})
  directory = mkdtempSync(join(tmpdir(), 'onboard-vendors-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  rmSync(directory, { recursive: true, force: true })
})

function availability(mask: number): [boolean, boolean, boolean] {
  return [Boolean(mask & 1), Boolean(mask & 2), Boolean(mask & 4)]
}

describe('noninteractive selection enforces availability and opt-outs', () => {
  // Every availability/opt-in combination, in both modes: detects zero tools,
  // unavailable legacy defaults, explicitly disabled OpenCode, and stale configs.
  for (const mode of ['cross-vendor', 'single-vendor'] as const) {
    for (let availableMask = 0; availableMask < 8; availableMask++) {
      for (let enabledMask = 0; enabledMask < 8; enabledMask++) {
        it(`${mode}: available=${availableMask} enabled=${enabledMask}`, async () => {
          const selected = vendors.filter((_, index) => Boolean((availableMask & enabledMask) & (1 << index)))
          const result = promptVendorMode(...availability(availableMask), mode, ...availability(enabledMask), { yes: true }, true)
          if (selected.length === 0 || (mode === 'single-vendor' && selected.length !== 1)) {
            await expect(result).rejects.toThrow(/config was not written/i)
          } else {
            const config = await result
            expect(enabledOnboardVendors(config)).toEqual(selected)
            expect(config.mode).toBe(selected.length === 1 ? 'single-vendor' : mode)
          }
          expect(picker).not.toHaveBeenCalled()
        })
      }
    }
  }

  it('opts into a fresh OpenCode-only installation', async () => {
    const config = await promptVendorMode(false, false, true, undefined, true, true, false, { yes: true }, false)
    expect(enabledOnboardVendors(config)).toEqual(['opencode'])
    expect(config.mode).toBe('single-vendor')
  })

  it('keeps OpenCode opt-in for a fresh mixed installation', async () => {
    const config = await promptVendorMode(true, false, true, undefined, true, true, false, { yes: true }, false)
    expect(enabledOnboardVendors(config)).toEqual(['claude'])
    expect(config.mode).toBe('single-vendor')
  })
})

describe('interactive selection and persistence', () => {
  it.each([
    { available: [true, false, true] as const, labels: ['claude', 'opencode'] },
    { available: [false, true, true] as const, labels: ['codex', 'opencode'] },
    { available: [true, true, true] as const, labels: ['claude', 'codex', 'opencode'] },
  ])('offers only available tools with $labels', async ({ available, labels }) => {
    picker.mockResolvedValueOnce(1).mockResolvedValueOnce(labels.length - 1)
    const config = await promptVendorMode(available[0], available[1], available[2], 'single-vendor', false, false, true, {})
    expect(picker.mock.calls[1][0].map(item => item.label)).toEqual(labels)
    expect(picker.mock.calls[1][1]?.defaultIndex).toBe(labels.length - 1)
    expect(enabledOnboardVendors(config)).toEqual(['opencode'])
    expect(picker).toHaveBeenCalledTimes(2)
    const path = join(directory, 'config.yml')
    applyOnboardConfig(path, { ...decisions, vendorConfig: config }, join(directory, 'workflow'))
    const saved = yaml.load(readFileSync(path, 'utf8')) as { vendors: Record<string, { enabled: boolean }> }
    expect(vendors.filter(vendor => saved.vendors[vendor].enabled)).toEqual(['opencode'])
  })

  it('choosing Claude disables a previously enabled OpenCode in single mode', async () => {
    picker.mockResolvedValueOnce(1).mockResolvedValueOnce(0)
    const config = await promptVendorMode(true, false, true, 'single-vendor', false, false, true, {})
    expect(enabledOnboardVendors(config)).toEqual(['claude'])
    expect(picker).toHaveBeenCalledTimes(2)
  })

  it('keeps Claude + OpenCode enabled in cross-vendor mode', async () => {
    picker.mockResolvedValueOnce(0).mockResolvedValueOnce(1)
    const config = await promptVendorMode(true, false, true, undefined, true, true, false, {})
    expect(config.mode).toBe('cross-vendor')
    expect(enabledOnboardVendors(config)).toEqual(['claude', 'opencode'])
  })

  it('uses single-vendor mode when declining the only additional available tool', async () => {
    picker.mockResolvedValueOnce(0).mockResolvedValueOnce(0)
    const config = await promptVendorMode(false, true, true, undefined, true, true, false, {})
    expect(config.mode).toBe('single-vendor')
    expect(enabledOnboardVendors(config)).toEqual(['codex'])
  })

  it.each([1, 2, 4])('selects the sole available tool for mask %i', async mask => {
    const config = await promptVendorMode(...availability(mask), undefined, true, true, false, {})
    expect(enabledOnboardVendors(config)).toEqual(vendors.filter((_, index) => Boolean(mask & (1 << index))))
    expect(picker).not.toHaveBeenCalled()
  })

  it('rejects an invalid picker result', async () => {
    picker.mockResolvedValueOnce(1).mockResolvedValueOnce(2)
    await expect(promptVendorMode(true, false, true, undefined, true, true, false, {})).rejects.toThrow('Invalid reviewer selection')
  })

  it.each([
    { mode: 'single-vendor' as const, claudeEnabled: true, codexEnabled: false, opencodeEnabled: true },
    { mode: 'cross-vendor' as const, claudeEnabled: false, codexEnabled: false, opencodeEnabled: false },
  ])('rejects invalid config before touching any files: $mode', vendorConfig => {
    const path = join(directory, 'config.yml')
    const before = 'branding:\n  service_name: existing\n'
    writeFileSync(path, before)
    expect(() => applyOnboardConfig(path, { ...decisions, vendorConfig }, join(directory, 'workflow'))).toThrow(/config was not written/i)
    expect(readFileSync(path, 'utf8')).toBe(before)
    expect(existsSync(join(directory, 'workflow'))).toBe(false)
  })
})
