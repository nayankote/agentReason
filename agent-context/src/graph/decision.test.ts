import { DecisionGraphBackend } from './decision.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, type: ThinkingEvent['type'], summary: string, files: string[]): ThinkingEvent => ({
  id,
  session_id: 'sess_1',
  timestamp: '2026-02-25T10:00:00.000Z',
  type,
  summary,
  raw_thinking: summary,
  response_text: '',
  tool_calls: [],
  files_affected: files,
  prompt_context: 'test'
})

test('only ingests decision, rejection, tradeoff events (not raw or exploration)', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', 'chose tree', ['src/graph/file.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'raw', 'some raw thinking', []),
    makeEvent('123e4567-e89b-12d3-a456-426614174003', 'tradeoff', 'speed vs accuracy', ['src/summarizer.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174004', 'exploration', 'let me check', [])
  ])
  const results = backend.query('graph', [])
  expect(results.map(e => e.id)).toContain('123e4567-e89b-12d3-a456-426614174001')
  expect(results.map(e => e.id)).not.toContain('123e4567-e89b-12d3-a456-426614174002')
  expect(results.map(e => e.id)).not.toContain('123e4567-e89b-12d3-a456-426614174004')
})

test('query returns events matching prompt keywords', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', 'chose tree structure for graph', ['src/graph/file.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'tradeoff', 'haiku latency vs quality', ['src/summarizer.ts'])
  ])
  const results = backend.query('haiku summarizer', [])
  expect(results.map(e => e.id)).toContain('123e4567-e89b-12d3-a456-426614174002')
})

test('query returns events matching file hint', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', 'chose tree structure', ['src/graph/file.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'tradeoff', 'completely different topic', ['src/summarizer.ts'])
  ])
  const results = backend.query('unrelated', ['src/graph/file.ts'])
  expect(results.map(e => e.id)).toContain('123e4567-e89b-12d3-a456-426614174001')
})

test('falls back to all decisions sorted by recency when no matches', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', 'chose tree', ['src/graph/file.ts'])
  ])
  const results = backend.query('completely unrelated prompt xyz', [])
  expect(results).toHaveLength(1) // fallback returns everything
})

test('serialize and deserialize round-trips', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', 'chose tree', ['src/foo.ts'])])
  const backend2 = new DecisionGraphBackend()
  backend2.deserialize(backend.serialize())
  expect(backend2.query('anything', ['src/foo.ts'])).toHaveLength(1)
})
