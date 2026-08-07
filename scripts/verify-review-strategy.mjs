// Verifies src/config/review-strategy.json against reality:
//   1. internal consistency  — every routed model exists, no banned model is routed
//   2. freshness             — `updated` is within review_interval_days
//   3. source drift          — each source page still contains its `checks` strings
//
// Exit 1 on any failure. Run locally with `npm run verify:strategy`; the
// review-strategy workflow runs it weekly and opens an issue when it fails.
import { readFile } from 'node:fs/promises'

const strategyPath = new URL('../src/config/review-strategy.json', import.meta.url)
const s = JSON.parse(await readFile(strategyPath, 'utf8'))

const errors = []
const warnings = []

// ---- 1. internal consistency -------------------------------------------
const modelIds = new Set(Object.keys(s.models))
const banned = new Set((s.banned_models ?? []).map(b => b.model))

for (const [vendor, def] of Object.entries(s.vendors)) {
  for (const [tier, model] of Object.entries(def.tiers)) {
    if (!modelIds.has(model)) errors.push(`vendors.${vendor}.tiers.${tier} references unknown model "${model}"`)
    if (banned.has(model)) errors.push(`vendors.${vendor}.tiers.${tier} routes to BANNED model "${model}"`)
  }
}

for (const [domain, def] of Object.entries(s.domains)) {
  if (domain.startsWith('_')) continue
  for (const [tier, list] of Object.entries(def.preferred ?? {})) {
    for (const model of list) {
      if (!modelIds.has(model)) errors.push(`domains.${domain}.preferred.${tier} references unknown model "${model}"`)
      if (banned.has(model)) errors.push(`domains.${domain}.preferred.${tier} routes to BANNED model "${model}"`)
    }
  }
}

for (const cls of s.pr_classes) {
  if (!cls.reason) errors.push(`pr_classes.${cls.id} has no "reason" — every class must be citable in a review comment`)
  if (cls.tier && !['fast', 'balanced', 'thorough'].includes(cls.tier)) errors.push(`pr_classes.${cls.id} has invalid tier "${cls.tier}"`)
}

// A model with no effort levels cannot serve an effort-escalation step, so the
// ladder must declare a fallback. Guards the OpenCode case (see §6.4).
const noEffort = Object.entries(s.models).filter(([, m]) => (m.effort_levels ?? []).length === 0).map(([id]) => id)
if (noEffort.length > 0 && !s.ladder.effort_fallback) {
  errors.push(`models without effort levels (${noEffort.join(', ')}) require ladder.effort_fallback to be set`)
}

// ---- 2. freshness -------------------------------------------------------
const ageDays = Math.floor((Date.now() - Date.parse(s.updated)) / 86_400_000)
if (Number.isNaN(ageDays)) {
  errors.push(`"updated" is not a parsable date: ${s.updated}`)
} else if (ageDays > s.review_interval_days) {
  errors.push(`strategy is ${ageDays} days old, past its ${s.review_interval_days}-day review interval — re-verify prices and benchmarks`)
} else if (ageDays > s.review_interval_days * 0.75) {
  warnings.push(`strategy is ${ageDays} days old; review interval is ${s.review_interval_days} days`)
}

// ---- 3. source drift ----------------------------------------------------
const results = await Promise.all(s.sources.map(async source => {
  try {
    const res = await fetch(source.url, { headers: { 'user-agent': 'crosscheck-strategy-verifier' } })
    if (!res.ok) return [`${source.name}: ${source.url} returned HTTP ${res.status}`]
    const body = await res.text()
    return source.checks.filter(c => !body.includes(c)).map(c => `${source.name}: "${c}" no longer appears at ${source.url}`)
  } catch (err) {
    return [`${source.name}: fetch failed — ${err instanceof Error ? err.message : String(err)}`]
  }
}))
errors.push(...results.flat())

// ---- report -------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`)

if (errors.length > 0) {
  console.error(`\nreview-strategy v${s.version} verification FAILED:`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error(`\nUpdate src/config/review-strategy.json and docs/${s.report.split('/').pop()}, then bump "version" and "updated".`)
  process.exit(1)
}

console.log(
  `review-strategy v${s.version} OK — ${modelIds.size} models, ${s.pr_classes.length} PR classes, ` +
  `${s.sources.length} sources verified, ${ageDays}d old (interval ${s.review_interval_days}d).`,
)
