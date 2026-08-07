// Verifies src/config/review-strategy.json against reality:
//   1. internal consistency  — every routed model exists, no banned model is routed
//   2. freshness             — `updated` is within review_interval_days
//   3. source drift          — each source page still contains its `checks` strings
//
// Only a source page that FETCHED and lost a string is drift. An unreachable
// page is a network fact, not a policy fact, so it is a warning on pull_request
// and an error only on the weekly schedule, where a human reads the result.
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

// Order is the routing logic and resolveReviewStrategy falls back to the last
// entry, so the list must end with the empty-match fallthrough — otherwise an
// unmatched PR lands on whatever narrow rule happens to sit last.
if (s.pr_classes.length === 0) {
  errors.push('pr_classes is empty — there is no class left to route a PR to')
} else {
  const last = s.pr_classes[s.pr_classes.length - 1]
  if (Object.keys(last.match ?? {}).length > 0) {
    errors.push(`pr_classes must end with the empty-match fallthrough; last entry is "${last.id}", which has a non-empty match`)
  }
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
// A blocked proxy or a DNS blip must not fail an unrelated PR build.
const unreachableIsFatal = process.env.GITHUB_EVENT_NAME === 'schedule'

const results = await Promise.all(s.sources.map(async source => {
  try {
    const res = await fetch(source.url, { headers: { 'user-agent': 'crosscheck-strategy-verifier' } })
    if (!res.ok) return { drift: [], unreachable: [`${source.name}: ${source.url} returned HTTP ${res.status}`] }
    const body = await res.text()
    return {
      drift: source.checks.filter(c => !body.includes(c)).map(c => `${source.name}: "${c}" no longer appears at ${source.url}`),
      unreachable: [],
    }
  } catch (err) {
    return { drift: [], unreachable: [`${source.name}: fetch failed — ${err instanceof Error ? err.message : String(err)}`] }
  }
}))
for (const r of results) {
  errors.push(...r.drift)
  ;(unreachableIsFatal ? errors : warnings).push(...r.unreachable)
}

// ---- report -------------------------------------------------------------
for (const w of warnings) console.warn(`warning: ${w}`)

if (errors.length > 0) {
  console.error(`\nreview-strategy v${s.version} verification FAILED:`)
  for (const e of errors) console.error(`  - ${e}`)
  console.error(`\nUpdate src/config/review-strategy.json and docs/${s.report.split('/').pop()}, then bump "version" and "updated".`)
  process.exit(1)
}

const reached = results.filter(r => r.unreachable.length === 0).length
console.log(
  `review-strategy v${s.version} OK — ${modelIds.size} models, ${s.pr_classes.length} PR classes, ` +
  `${reached}/${s.sources.length} sources verified, ${ageDays}d old (interval ${s.review_interval_days}d).`,
)
