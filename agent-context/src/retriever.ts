import type { ThinkingEvent } from './schema.js'

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
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
