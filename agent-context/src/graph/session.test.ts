import { SessionGraphBackend } from './session.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, sessionId: string, ts: string): ThinkingEvent => ({
  id,
  session_id: sessionId,
  timestamp: ts,
  type: 'decision',
  summary: `decision in ${sessionId}`,
  raw_thinking: 'thinking...',
  response_text: '',
  tool_calls: [],
  files_affected: [],
  prompt_context: 'prompt'
})

test('ingest builds session nodes in temporal order', () => {
  const backend = new SessionGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'sess_1', '2026-02-25T10:00:00.000Z'),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'sess_2', '2026-02-25T11:00:00.000Z')
  ])
  const results = backend.query('anything', [])
  expect(results[0].session_id).toBe('sess_2') // most recent first
})

test('deduplicates events within a session', () => {
  const backend = new SessionGraphBackend()
  const event = makeEvent('123e4567-e89b-12d3-a456-426614174001', 'sess_1', '2026-02-25T10:00:00.000Z')
  backend.ingest([event])
  backend.ingest([event])
  expect(backend.query('anything', [])).toHaveLength(1)
})

test('query includes events matching file hint', () => {
  const backend = new SessionGraphBackend()
  const event: ThinkingEvent = {
    id: '123e4567-e89b-12d3-a456-426614174001',
    session_id: 'sess_1',
    timestamp: '2026-02-25T10:00:00.000Z',
    type: 'decision',
    summary: 'chose tree',
    raw_thinking: 'chose tree',
    response_text: '',
    tool_calls: [],
    files_affected: ['src/graph/file.ts'],
    prompt_context: 'test'
  }
  backend.ingest([event])
  const results = backend.query('unrelated prompt', ['src/graph/file.ts'])
  expect(results).toHaveLength(1)
})

test('serialize and deserialize round-trips', () => {
  const backend = new SessionGraphBackend()
  backend.ingest([makeEvent('123e4567-e89b-12d3-a456-426614174001', 'sess_1', '2026-02-25T10:00:00.000Z')])
  const backend2 = new SessionGraphBackend()
  backend2.deserialize(backend.serialize())
  expect(backend2.query('anything', [])).toHaveLength(1)
})
