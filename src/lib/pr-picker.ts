import { promptRepoPicker } from './repo-picker.js'
import type { ScanPRStatus as PRStatus } from './pr-status.js'

export class UserInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'UserInputError'
  }
}

export async function pickPRs(prs: PRStatus[]): Promise<PRStatus[]> {
  if (prs.length === 0) return []

  const ordered = sortPRsForPicker(prs)
  const rows = ordered.map(formatPickerLabel)
  const selected = await promptRepoPicker(rows, {
    title: 'Select stale PRs to advance',
    selectAllLabel: 'all',
    getDescription: (row) => {
      const pr = ordered[rows.indexOf(row)]
      return pr ? pickerDescription(pr) : ''
    },
  })
  const byRow = new Map(rows.map((row, index) => [row, ordered[index]]))
  return selected.flatMap(row => {
    const pr = byRow.get(row)
    return pr ? [pr] : []
  })
}

export function sortPRsForPicker(prs: PRStatus[]): PRStatus[] {
  return [...prs].sort((a, b) => {
    const actionDelta = actionOrder(a) - actionOrder(b)
    if (actionDelta !== 0) return actionDelta
    return Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt)
  })
}

export function formatPickerLabel(pr: PRStatus): string {
  return `${actionGroupLabel(pr).padEnd(7)} ${formatPRSignature(pr)}  ${pr.title}  ${pr.reviewState}`
}

function formatPRSignature(pr: PRStatus): string {
  return `${pr.owner}/${pr.repo}/PR#${pr.number}`
}

export function actionGroupLabel(pr: PRStatus): 'CR' | 'resolve' | 'fix' | 'recheck' | 'merge' {
  if (pr.nextAction === 'resolve') return 'resolve'
  if (pr.nextAction === 'fix') return 'fix'
  if (pr.nextAction === 'recheck') return 'recheck'
  if (pr.nextAction === 'merge') return 'merge'
  return 'CR'
}

export function parseSelection(answer: string, prs: PRStatus[]): PRStatus[] {
  const trimmed = answer.trim().toLowerCase()
  if (!trimmed) return []
  if (trimmed === 'all' || trimmed === 'a') return prs

  const selectedIndexes = new Set<number>()
  for (const part of trimmed.split(',')) {
    const value = Number(part.trim())
    if (!Number.isInteger(value) || value < 1 || value > prs.length) {
      throw new UserInputError(`Invalid selection "${part.trim()}". Choose numbers from 1 to ${prs.length}, or "all".`)
    }
    selectedIndexes.add(value - 1)
  }

  return [...selectedIndexes].map(index => prs[index])
}

function actionOrder(pr: PRStatus): number {
  // resolve first: a conflicted PR blocks everything downstream of it.
  if (pr.nextAction === 'resolve') return 0
  if (pr.nextAction === 'review') return 1
  if (pr.nextAction === 'fix') return 2
  if (pr.nextAction === 'recheck') return 3
  if (pr.nextAction === 'merge') return 4
  return 5
}

function pickerDescription(pr: PRStatus): string {
  const ageMinutes = Math.floor(pr.ageMs / 60_000)
  const age = ageMinutes >= 60
    ? `${Math.floor(ageMinutes / 60)}h`
    : `${ageMinutes}m`
  return `${pr.reviewState}  last ${age}`
}
