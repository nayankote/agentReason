import type { ThinkingEvent } from './schema.js'

export function formatContextSlice(events: ThinkingEvent[]): string {
  if (events.length === 0) return ''

  const byFile = new Map<string, ThinkingEvent[]>()
  for (const event of events) {
    const files = event.files_affected.length > 0 ? event.files_affected : ['__general__']
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file)!.push(event)
    }
  }

  const lines = [
    '## Past Reasoning Context',
    '',
    'Relevant decisions and trade-offs from previous sessions on this codebase:',
    ''
  ]

  for (const [file, fileEvents] of byFile) {
    if (file !== '__general__') lines.push(`### ${file}`)
    for (const event of fileEvents) {
      lines.push(`- **[${event.type}]** ${event.summary}`)
      if (event.response_text) {
        lines.push(`  > ${event.response_text.slice(0, 200)}`)
      }
    }
    lines.push('')
  }

  return lines.join('\n')
}
