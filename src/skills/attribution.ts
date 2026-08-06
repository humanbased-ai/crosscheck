import { formatSkillIdentity } from './catalog.js'
import type { SkillMetadata } from './broker.js'

// Skills are separated by a middot and kept on one line: the receipt has to be
// present for licensing, but it is metadata about the run, not part of it.
export function formatSkillAttribution(skills: SkillMetadata[]): string {
  return skills.map(formatSkillIdentity).join(' · ')
}

// One italic line, same weight as the reviewer attribution it sits beneath.
// Empty string when nothing activated, so callers can concatenate blind.
export function renderSkillAttributionLine(skills: SkillMetadata[]): string {
  if (skills.length === 0) return ''
  return `_Skills: ${formatSkillAttribution(skills)}_`
}

export function appendSkillAttribution(body: string, skills: SkillMetadata[]): string {
  const line = renderSkillAttributionLine(skills)
  return line ? `${body}\n\n${line}` : body
}
