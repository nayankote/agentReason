import type { ThinkingEvent } from '../schema.js'
import type { GraphBackend } from './interface.js'

const DECISION_TYPES: ReadonlySet<ThinkingEvent['type']> = new Set(['decision', 'rejection', 'tradeoff'])

export class DecisionGraphBackend implements GraphBackend {
  private nodes: Map<string, ThinkingEvent> = new Map()

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      if (DECISION_TYPES.has(event.type)) {
        this.nodes.set(event.id, event)
      }
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    const keywords = prompt
      .toLowerCase()
      .split(/\s+/)
      .filter(k => k.length > 2)

    const matched: ThinkingEvent[] = []

    for (const event of this.nodes.values()) {
      const fileMatch = filesHinted.some(f => event.files_affected.includes(f))
      const text = (event.summary + ' ' + event.raw_thinking).toLowerCase()
      const keywordMatch = keywords.some(k => text.includes(k))

      if (fileMatch || keywordMatch) {
        matched.push(event)
      }
    }

    if (matched.length === 0) {
      // fallback: return all nodes sorted by timestamp descending
      return Array.from(this.nodes.values()).sort(
        (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
      )
    }

    return matched.sort(
      (a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime()
    )
  }

  serialize(): object {
    return {
      type: 'decision',
      nodes: Object.fromEntries(this.nodes)
    }
  }

  deserialize(data: object): void {
    const d = data as { nodes?: Record<string, ThinkingEvent> }
    if (d.nodes) {
      this.nodes = new Map(Object.entries(d.nodes))
    }
  }
}
