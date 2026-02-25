import type { ThinkingEvent } from '../schema.js'

export interface GraphBackend {
  ingest(events: ThinkingEvent[]): void
  query(prompt: string, filesHinted: string[]): ThinkingEvent[]
  serialize(): object
  deserialize(data: object): void
}
