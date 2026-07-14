import { readFile } from 'node:fs/promises'

const configPath = new URL('../src/config/review-model-tiers.json', import.meta.url)
const config = JSON.parse(await readFile(configPath, 'utf8'))

const sourceResults = await Promise.all(config.sources.map(async source => {
  const response = await fetch(source.url)
  if (!response.ok) {
    return [`${source.name}: ${source.url} returned HTTP ${response.status}`]
  }

  const body = await response.text()
  return source.checks
    .filter(check => !body.includes(check))
    .map(check => `${source.name}: missing "${check}" in ${source.url}`)
}))

const missing = sourceResults.flat()
if (missing.length > 0) {
  console.error('Model tier source verification failed:')
  for (const line of missing) console.error(`- ${line}`)
  process.exit(1)
}

console.log(`Verified ${config.sources.length} model tier source documents.`)
