import type { ThinkingEvent } from './schema.js'

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function getEventStats(events: ThinkingEvent[]): { total: number; byType: Record<string, number> } {
  const byType: Record<string, number> = {}
  for (const event of events) {
    byType[event.type] = (byType[event.type] ?? 0) + 1
  }
  return { total: events.length, byType }
}

export function buildContextSlice(events: ThinkingEvent[], tokenBudget = 2000): ThinkingEvent[] {
  const slice: ThinkingEvent[] = []
  let used = 0

  for (const event of events) {
    const cost = estimateTokens(
      event.summary + event.response_text + event.files_affected.join(',')
    )
    if (used + cost > tokenBudget) break
    slice.push(event)
    used += cost
  }

  return slice
}
