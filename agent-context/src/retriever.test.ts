import { buildContextSlice } from './retriever.js'
import { formatContextSlice } from './injector.js'
import type { ThinkingEvent } from './schema.js'

const makeEvent = (id: string, summary: string, files: string[]): ThinkingEvent => ({
  id,
  session_id: 'sess_1',
  timestamp: '2026-02-25T10:00:00.000Z',
  type: 'decision',
  summary,
  raw_thinking: 'detailed thinking: ' + summary,
  response_text: 'output: ' + summary,
  tool_calls: [],
  files_affected: files,
  prompt_context: 'test'
})

test('buildContextSlice caps output at token budget', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    makeEvent(`123e4567-e89b-12d3-a456-4266141740${String(i).padStart(2,'0')}`, `decision ${i} about something important`, [`src/file${i}.ts`])
  )
  const slice = buildContextSlice(events, 100)
  expect(slice.length).toBeGreaterThan(0)
  expect(slice.length).toBeLessThan(20)
})

test('buildContextSlice returns all events if under budget', () => {
  const events = [makeEvent('123e4567-e89b-12d3-a456-426614174000', 'tiny decision', ['src/foo.ts'])]
  const slice = buildContextSlice(events, 2000)
  expect(slice).toHaveLength(1)
})

test('formatContextSlice produces non-empty string with summary and file', () => {
  const events = [makeEvent('123e4567-e89b-12d3-a456-426614174000', 'chose tree structure', ['src/graph/file.ts'])]
  const output = formatContextSlice(events)
  expect(output).toContain('chose tree structure')
  expect(output).toContain('src/graph/file.ts')
})

test('formatContextSlice groups events by file', () => {
  const events = [
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'graph decision', ['src/graph/file.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'summarizer tradeoff', ['src/summarizer.ts'])
  ]
  const output = formatContextSlice(events)
  // Both files should appear as headers
  expect(output).toContain('src/graph/file.ts')
  expect(output).toContain('src/summarizer.ts')
})

test('formatContextSlice returns empty string for empty events', () => {
  expect(formatContextSlice([])).toBe('')
})
