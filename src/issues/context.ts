// Pure formatting of a fetched tracker issue into the text block injected into
// the reviewer prompt. Kept side-effect-free so it is unit-testable without a
// network client.

export interface TrackerIssue {
  id: string
  title: string
  description: string | null
  labels: string[]
  estimate: number | null
  priorityLabel: string | null
  projectName: string | null
  url: string | null
}

function truncate(text: string, maxChars: number): string {
  if (maxChars <= 0 || text.length <= maxChars) return text
  return `${text.slice(0, maxChars).trimEnd()}\n…[truncated]`
}

// Renders the enrichment block. `maxDescriptionChars` bounds the (often large)
// issue body so the prompt stays within a predictable size; 0 disables the cap.
export function formatIssueContext(issue: TrackerIssue, maxDescriptionChars = 4000): string {
  const meta: string[] = []
  if (issue.projectName) meta.push(`project ${issue.projectName}`)
  if (issue.priorityLabel) meta.push(`priority ${issue.priorityLabel}`)
  if (issue.estimate !== null) meta.push(`estimate ${issue.estimate}`)
  if (issue.labels.length > 0) meta.push(`labels ${issue.labels.join(', ')}`)

  const lines = [
    `Linked issue ${issue.id}: ${issue.title}`,
    meta.length > 0 ? `(${meta.join('; ')})` : '',
    issue.url ? issue.url : '',
    issue.description && issue.description.trim()
      ? `\nGoal / acceptance from the tracker:\n${truncate(issue.description.trim(), maxDescriptionChars)}`
      : '',
    '\nReview the change against this stated goal — flag scope creep beyond it and behavior that contradicts it.',
  ]
  return lines.filter(Boolean).join('\n')
}
