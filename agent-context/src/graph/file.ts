import type { ThinkingEvent } from '../schema.js'
import type { GraphBackend } from './interface.js'

const UNATTRIBUTED = '__unattributed__'

export class FileGraphBackend implements GraphBackend {
  private tree: { [filePath: string]: ThinkingEvent[] } = {}

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      const keys = event.files_affected.length > 0 ? event.files_affected : [UNATTRIBUTED]
      for (const key of keys) {
        if (!this.tree[key]) {
          this.tree[key] = []
        }
        const alreadyExists = this.tree[key].some(e => e.id === event.id)
        if (!alreadyExists) {
          this.tree[key].push(event)
        }
      }
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    const seen = new Set<string>()
    const results: ThinkingEvent[] = []

    // Step 1: collect events for exactly-matched filesHinted files
    for (const file of filesHinted) {
      const events = this.tree[file] ?? []
      for (const event of events) {
        if (!seen.has(event.id)) {
          seen.add(event.id)
          results.push(event)
        }
      }
    }

    // Step 2: if results < 3, keyword match prompt against all file paths
    if (results.length < 3) {
      const promptLower = prompt.toLowerCase()
      const promptKeywords = promptLower.split(/\s+/).filter(w => w.length > 2)
      const matchesKeyword = (text: string): boolean => {
        const t = text.toLowerCase()
        return promptKeywords.some(kw => t.includes(kw))
      }
      for (const [filePath, events] of Object.entries(this.tree)) {
        if (filePath.toLowerCase().includes(promptLower) || filePath === UNATTRIBUTED) {
          for (const event of events) {
            if (!seen.has(event.id)) {
              // For __unattributed__, match by keyword in summary, raw_thinking, or prompt_context
              if (filePath === UNATTRIBUTED) {
                if (
                  matchesKeyword(event.summary) ||
                  matchesKeyword(event.raw_thinking) ||
                  matchesKeyword(event.prompt_context ?? '')
                ) {
                  seen.add(event.id)
                  results.push(event)
                }
              } else {
                seen.add(event.id)
                results.push(event)
              }
            }
          }
        }
      }
    }

    // Sort by timestamp descending (most recent first)
    results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))

    return results
  }

  serialize(): object {
    return { type: 'file', tree: this.tree }
  }

  deserialize(data: object): void {
    const d = data as { tree?: { [filePath: string]: ThinkingEvent[] } }
    this.tree = d.tree ?? {}
  }
}
