import { ThinkingEventSchema, ToolCallSummarySchema } from './schema.js'

test('ThinkingEvent validates a complete event', () => {
  const event = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    session_id: 'sess_abc',
    timestamp: '2026-02-25T10:00:00.000Z',
    type: 'decision' as const,
    summary: 'Chose file-centric tree over flat list',
    raw_thinking: 'I could use a flat list but a tree is better because...',
    response_text: 'I will implement the file-centric tree backend first.',
    tool_calls: [{ tool_name: 'Write', input_summary: 'src/graph/file.ts', outcome: 'success' as const }],
    files_affected: ['src/graph/file.ts'],
    prompt_context: 'implement the graph backend'
  }
  expect(() => ThinkingEventSchema.parse(event)).not.toThrow()
})

test('ThinkingEvent rejects invalid type', () => {
  const event = { id: 'x', session_id: 'y', timestamp: 'z', type: 'bogus' }
  expect(() => ThinkingEventSchema.parse(event)).toThrow()
})
