import { FileGraphBackend } from './file.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, files: string[], summary: string): ThinkingEvent => ({
  id,
  session_id: 'sess_1',
  timestamp: '2026-02-25T10:00:00.000Z',
  type: 'decision',
  summary,
  raw_thinking: summary,
  response_text: '',
  tool_calls: [],
  files_affected: files,
  prompt_context: 'test prompt'
})

test('ingest stores events under their affected files', () => {
  const backend = new FileGraphBackend()
  backend.ingest([makeEvent('123e4567-e89b-12d3-a456-426614174000', ['src/graph/file.ts'], 'chose tree structure')])
  const results = backend.query('graph', ['src/graph/file.ts'])
  expect(results).toHaveLength(1)
  expect(results[0].id).toBe('123e4567-e89b-12d3-a456-426614174000')
})

test('query returns events for hinted files', () => {
  const backend = new FileGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', ['src/foo.ts'], 'foo decision'),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', ['src/bar.ts'], 'bar decision')
  ])
  const results = backend.query('anything', ['src/foo.ts'])
  expect(results.map(e => e.id)).toContain('123e4567-e89b-12d3-a456-426614174001')
  expect(results.map(e => e.id)).not.toContain('123e4567-e89b-12d3-a456-426614174002')
})

test('deduplicates events on repeated ingest', () => {
  const backend = new FileGraphBackend()
  const event = makeEvent('123e4567-e89b-12d3-a456-426614174000', ['src/foo.ts'], 'foo decision')
  backend.ingest([event])
  backend.ingest([event])
  const results = backend.query('anything', ['src/foo.ts'])
  expect(results).toHaveLength(1)
})

test('serialize and deserialize round-trips correctly', () => {
  const backend = new FileGraphBackend()
  backend.ingest([makeEvent('123e4567-e89b-12d3-a456-426614174000', ['src/foo.ts'], 'foo decision')])
  const data = backend.serialize()
  const backend2 = new FileGraphBackend()
  backend2.deserialize(data)
  expect(backend2.query('anything', ['src/foo.ts'])).toHaveLength(1)
})

test('events with no files_affected go under __unattributed__', () => {
  const backend = new FileGraphBackend()
  const event = makeEvent('123e4567-e89b-12d3-a456-426614174000', [], 'unattributed decision')
  backend.ingest([event])
  // Should still be findable by keyword
  const results = backend.query('unattributed', [])
  expect(results).toHaveLength(1)
})
