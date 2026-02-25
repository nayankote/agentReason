import type { ThinkingEvent } from '../schema.js'
import type { GraphBackend } from './interface.js'

interface SessionNode {
  session_id: string
  started_at: string
  events: ThinkingEvent[]
}

export class SessionGraphBackend implements GraphBackend {
  private sessions: Map<string, SessionNode> = new Map()

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      const existing = this.sessions.get(event.session_id)
      if (existing) {
        // Deduplicate by id
        const alreadyHasId = existing.events.some(e => e.id === event.id)
        if (!alreadyHasId) {
          existing.events.push(event)
          // Update started_at if this event is earlier
          if (event.timestamp < existing.started_at) {
            existing.started_at = event.timestamp
          }
        }
      } else {
        this.sessions.set(event.session_id, {
          session_id: event.session_id,
          started_at: event.timestamp,
          events: [event]
        })
      }
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    // Sort sessions by started_at descending (most recent first)
    const sortedSessions = Array.from(this.sessions.values()).sort(
      (a, b) => b.started_at.localeCompare(a.started_at)
    )

    const promptKeywords = prompt.toLowerCase().split(/\s+/).filter(k => k.length > 0)

    const matchesEvent = (event: ThinkingEvent): boolean => {
      // Check file hint match
      if (filesHinted.length > 0) {
        const fileMatch = filesHinted.some(hint =>
          event.files_affected.includes(hint)
        )
        if (fileMatch) return true
      }

      // Check prompt keyword match against summary or raw_thinking
      if (promptKeywords.length > 0) {
        const summaryLower = event.summary.toLowerCase()
        const thinkingLower = event.raw_thinking.toLowerCase()
        const keywordMatch = promptKeywords.some(
          kw => summaryLower.includes(kw) || thinkingLower.includes(kw)
        )
        if (keywordMatch) return true
      }

      return false
    }

    const seen = new Set<string>()
    const filtered: ThinkingEvent[] = []

    for (const session of sortedSessions) {
      for (const event of session.events) {
        if (!seen.has(event.id) && matchesEvent(event)) {
          seen.add(event.id)
          filtered.push(event)
        }
      }
    }

    // If fewer than 3 results after filtered walk, include remaining events
    if (filtered.length < 3) {
      for (const session of sortedSessions) {
        for (const event of session.events) {
          if (!seen.has(event.id)) {
            seen.add(event.id)
            filtered.push(event)
          }
        }
      }
    }

    return filtered
  }

  serialize(): object {
    return {
      type: 'session',
      sessions: Object.fromEntries(this.sessions)
    }
  }

  deserialize(data: object): void {
    const d = data as { type?: string; sessions?: Record<string, SessionNode> }
    this.sessions = d.sessions ? new Map(Object.entries(d.sessions)) : new Map()
  }
}
