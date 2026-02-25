import { extractFromLines } from './extractor.js'

const SAMPLE_LINES = [
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'text', text: 'implement the graph backend' }] },
    uuid: 'turn-1',
    sessionId: 'sess_abc',
    timestamp: '2026-02-25T10:00:00.000Z'
  }),
  JSON.stringify({
    type: 'assistant',
    message: {
      content: [
        { type: 'thinking', thinking: 'I could use a flat list but a tree is better because it groups naturally by file' },
        { type: 'text', text: 'I will implement the file-centric tree backend first.' }
      ]
    },
    uuid: 'turn-2',
    sessionId: 'sess_abc',
    timestamp: '2026-02-25T10:00:05.000Z'
  })
]

test('extracts one ThinkingEvent per assistant turn with thinking', () => {
  const events = extractFromLines(SAMPLE_LINES, 'sess_abc')
  expect(events).toHaveLength(1)
  expect(events[0].raw_thinking).toContain('flat list')
  expect(events[0].response_text).toContain('file-centric tree')
  expect(events[0].prompt_context).toBe('implement the graph backend')
  expect(events[0].type).toBe('raw')
})

test('skips assistant turns with no thinking block', () => {
  const lines = [
    JSON.stringify({
      type: 'assistant',
      message: { content: [{ type: 'text', text: 'Done.' }] },
      uuid: 'turn-3',
      sessionId: 'sess_abc',
      timestamp: '2026-02-25T10:00:10.000Z'
    })
  ]
  const events = extractFromLines(lines, 'sess_abc')
  expect(events).toHaveLength(0)
})

test('handles malformed lines gracefully', () => {
  const lines = ['not json at all', ...SAMPLE_LINES]
  expect(() => extractFromLines(lines, 'sess_abc')).not.toThrow()
  const events = extractFromLines(lines, 'sess_abc')
  expect(events).toHaveLength(1) // malformed line skipped, valid lines still processed
})
