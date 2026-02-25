import Anthropic from '@anthropic-ai/sdk'
import type { ThinkingEvent } from './schema.js'

const DECISION_PATTERNS = [
  /i('ll| will) go with .+ because/i,
  /i could .+ but (instead|i'll)/i,
  /choosing .+ over/i,
  /decided to/i
]

const REJECTION_PATTERNS = [
  /that won't work/i,
  /actually,? that/i,
  /let me revert/i,
  /that approach has a problem/i,
  /this won't/i
]

const TRADEOFF_PATTERNS = [
  /the tradeoff (here )?is/i,
  /this is (slower|faster|simpler|more complex) but/i,
  /for now i('ll)?.+but ideally/i
]

const EXPLORATION_PATTERNS = [
  /let me (check|look|see|explore)/i,
  /i wonder if/i,
  /let me (think|consider)/i
]

export function classifyHeuristic(text: string): ThinkingEvent['type'] {
  for (const pattern of DECISION_PATTERNS) {
    if (pattern.test(text)) return 'decision'
  }
  for (const pattern of REJECTION_PATTERNS) {
    if (pattern.test(text)) return 'rejection'
  }
  for (const pattern of TRADEOFF_PATTERNS) {
    if (pattern.test(text)) return 'tradeoff'
  }
  for (const pattern of EXPLORATION_PATTERNS) {
    if (pattern.test(text)) return 'exploration'
  }
  return 'raw'
}

export function summarizeHeuristic(text: string): string {
  const parts = text.split(/[.!?]/)
  const firstSentence = parts[0].trim()
  return firstSentence.slice(0, 120)
}

export function applyHeuristics(events: ThinkingEvent[]): ThinkingEvent[] {
  return events.map(event => ({
    ...event,
    type: classifyHeuristic(event.raw_thinking),
    summary: summarizeHeuristic(event.raw_thinking)
  }))
}

export async function summarizeWithHaiku(events: ThinkingEvent[]): Promise<ThinkingEvent[]> {
  if (events.length === 0) return []

  const client = new Anthropic()

  const eventList = events
    .map(e => `ID: ${e.id}\nThinking: ${e.raw_thinking}`)
    .join('\n\n---\n\n')

  const prompt = `You are summarizing AI agent thinking blocks. For each thinking block below, classify it and write a one-sentence summary.

Return a JSON array with exactly one object per thinking block, in the same order, with this structure:
[{ "id": "<id>", "type": "<type>", "summary": "<summary>" }]

Valid types: decision, rejection, tradeoff, exploration, raw
- decision: choosing one approach over another with reasoning
- rejection: deciding against an approach
- tradeoff: weighing pros and cons
- exploration: investigating or examining something
- raw: anything else

Keep each summary under 120 characters. Return only valid JSON, no markdown fences.

Thinking blocks:
${eventList}`

  const message = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  })

  const responseText = message.content
    .filter(block => block.type === 'text')
    .map(block => (block as { type: 'text'; text: string }).text)
    .join('')

  let parsed: Array<{ id: string; type: string; summary: string }>
  try {
    parsed = JSON.parse(responseText)
    if (!Array.isArray(parsed)) return applyHeuristics(events)
  } catch {
    return applyHeuristics(events)
  }

  const byId = new Map(parsed.map(item => [item.id, item]))

  return events.map(event => {
    const result = byId.get(event.id)
    if (!result) return event

    const validTypes: ThinkingEvent['type'][] = ['decision', 'rejection', 'tradeoff', 'exploration', 'raw']
    const type = validTypes.includes(result.type as ThinkingEvent['type'])
      ? (result.type as ThinkingEvent['type'])
      : 'raw'

    return {
      ...event,
      type,
      summary: result.summary ?? event.summary
    }
  })
}

export async function summarize(events: ThinkingEvent[]): Promise<ThinkingEvent[]> {
  if (!process.env.ANTHROPIC_API_KEY) {
    return applyHeuristics(events)
  }
  try {
    return await summarizeWithHaiku(events)
  } catch {
    return applyHeuristics(events)
  }
}
