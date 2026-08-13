import { readdirSync, readFileSync, existsSync } from 'fs'
import { join } from 'path'
import chalk from 'chalk'
import { loadConfig } from '../config/loader.js'
import { getLogDir } from '../lib/logger.js'
import { buildAdoptionReport, type AdoptionLogLine, type AdoptionReport } from '../lib/adoption.js'

function readLogLines(sinceDate?: string): { files: string[]; lines: AdoptionLogLine[] } {
  const logDir = getLogDir()
  if (!existsSync(logDir)) return { files: [], lines: [] }
  const files = readdirSync(logDir)
    .filter(f => f.endsWith('.ndjson'))
    .sort()
    .filter(f => !sinceDate || f.replace('.ndjson', '') >= sinceDate)
    .map(f => join(logDir, f))
  const lines: AdoptionLogLine[] = []
  for (const file of files) {
    for (const line of readFileSync(file, 'utf8').split('\n')) {
      if (!line.trim()) continue
      try { lines.push(JSON.parse(line) as AdoptionLogLine) } catch { /* skip malformed */ }
    }
  }
  return { files, lines }
}

function humanDuration(ms: number): string {
  if (ms <= 0) return '—'
  const minutes = ms / 60_000
  if (minutes < 60) return `${Math.round(minutes)}m`
  const hours = minutes / 60
  if (hours < 48) return `${Math.round(hours * 10) / 10}h`
  return `${Math.round(hours / 24)}d`
}

function renderBar(value: number, max: number, width = 16): string {
  if (max === 0 || value === 0) return ''
  return '█'.repeat(Math.max(1, Math.round((value / max) * width)))
}

function formatReport(report: AdoptionReport, retentionDays: number): void {
  const sep = chalk.dim('─'.repeat(50))
  const periodLabel = report.period.from === 'N/A'
    ? 'no data'
    : `${report.period.from} → ${report.period.to}`
  console.log(chalk.bold('\ncrosscheck adoption') + chalk.dim(`  (${periodLabel})\n`))

  if (report.activity.reviews_completed === 0 && report.onboarding.started === 0) {
    console.log(chalk.yellow('  No activity in the retained log window.'))
    console.log(chalk.dim(`  Logging is ${retentionDays}d; run a review or check logs.enabled in config.\n`))
    return
  }

  console.log(chalk.dim('  Activation'))
  console.log(`  ${sep}`)
  console.log(`  ${'onboard started'.padEnd(26)} ${report.onboarding.started}`)
  console.log(`  ${'onboard completed'.padEnd(26)} ${chalk.green(String(report.onboarding.completed))}`)
  if (report.onboarding.abandoned > 0) {
    console.log(`  ${'abandoned'.padEnd(26)} ${chalk.yellow(String(report.onboarding.abandoned))}`)
  }
  console.log()

  const a = report.activity
  console.log(chalk.dim('  Usage'))
  console.log(`  ${sep}`)
  console.log(`  ${'reviews started'.padEnd(26)} ${a.reviews_started}`)
  console.log(`  ${'reviews completed'.padEnd(26)} ${a.reviews_completed}`)
  console.log(`  ${'rechecks completed'.padEnd(26)} ${a.rechecks_completed}`)
  console.log(`  ${'blocking findings posted'.padEnd(26)} ${chalk.yellow(String(a.blocking_findings_posted))}`)
  console.log(`  ${'fixes applied'.padEnd(26)} ${a.fixes_applied}`)
  console.log(`  ${'active repos'.padEnd(26)} ${a.active_repos}`)
  // A zero that means "this event did not exist when those reviews ran" reads
  // exactly like a zero that means "it never happened". Say which it is.
  if (a.reviews_completed > 0 && a.blocking_findings_posted === 0) {
    console.log(`  ${chalk.dim('ⓘ blocking-finding and latency events are recorded from this version on — reviews logged')}`)
    console.log(`  ${chalk.dim('  by an older version carry neither, and read as 0 here until new activity accumulates')}`)
  }
  console.log()

  const weeks = report.weekly.slice(-12)
  if (weeks.length >= 2) {
    console.log(chalk.dim('  Weekly active repos'))
    console.log(`  ${sep}`)
    const max = Math.max(...weeks.map(w => w.active_repos))
    for (const w of weeks) {
      const bar = renderBar(w.active_repos, max).padEnd(18)
      console.log(`  ${w.week}  ${chalk.cyan(bar)}  ${String(w.active_repos).padStart(3)} repos  ${chalk.dim(`${w.reviews} reviews`)}`)
    }
    console.log()
  }

  const l = report.open_to_verdict
  if (l.count > 0) {
    console.log(chalk.dim('  PR open → verdict'))
    console.log(`  ${sep}`)
    console.log(`  ${'median'.padEnd(26)} ${humanDuration(l.p50_ms)}`)
    console.log(`  ${'p90'.padEnd(26)} ${humanDuration(l.p90_ms)}`)
    console.log(`  ${'slowest'.padEnd(26)} ${humanDuration(l.max_ms)}`)
    console.log(`  ${chalk.dim(`measured on ${l.count} verdict${l.count === 1 ? '' : 's'}`)}`)
    if (l.unmeasured > 0) {
      console.log(`  ${chalk.dim(`ⓘ ${l.unmeasured} verdict${l.unmeasured === 1 ? '' : 's'} had no PR open time in the event — excluded`)}`)
    }
    console.log()
  }

  const failures = Object.entries(report.first_run_failures).sort(([, a2], [, b2]) => b2 - a2)
  if (failures.length > 0) {
    console.log(chalk.dim('  First-run failures') + chalk.dim('  (sessions that never reached a verdict)'))
    console.log(`  ${sep}`)
    for (const [category, count] of failures) {
      console.log(`  ${category.padEnd(26)} ${chalk.red(String(count))}`)
    }
    console.log()
  }

  console.log(`  ${chalk.dim(`ⓘ derived from local logs only (${retentionDays}d retention) — nothing is transmitted. See docs/metrics.md`)}`)
  console.log()
}

export async function runAdoption(opts: { json?: boolean; since?: string; config?: string }): Promise<void> {
  const config = loadConfig(opts.config)
  const { files, lines } = readLogLines(opts.since)
  const report = buildAdoptionReport(lines, {
    from: files[0]?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A',
    to: files.at(-1)?.split('/').at(-1)?.replace('.ndjson', '') ?? 'N/A',
    log_files: files.length,
  })

  if (opts.json) {
    console.log(JSON.stringify(report, null, 2))
    return
  }

  formatReport(report, config.logs.retention_days)
}
