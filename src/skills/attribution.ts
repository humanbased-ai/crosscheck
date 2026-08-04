import { formatSkillIdentity } from './catalog.js'
import type { SkillMetadata } from './broker.js'

export function formatSkillAttribution(skills: SkillMetadata[]): string {
  return skills.map(formatSkillIdentity).join(', ')
}

export function appendSkillAttribution(body: string, skills: SkillMetadata[], stepType: string): string {
  if (skills.length === 0) return body
  return `${body}\n\n---\n🧩 **Skills activated for ${stepType}:** ${formatSkillAttribution(skills)}`
}
