import { classifyHeuristic, summarizeHeuristic, applyHeuristics } from './summarizer.js'
import type { ThinkingEvent } from './schema.js'

test('classifies decision thinking block', () => {
  const text = "I could use a flat list but I'll go with a tree because it groups naturally by file"
  expect(classifyHeuristic(text)).toBe('decision')
})

test('classifies rejection thinking block', () => {
  const text = "Actually that won't work because the JSONL format doesn't include file paths"
  expect(classifyHeuristic(text)).toBe('rejection')
})

test('classifies tradeoff thinking block', () => {
  const text = "The tradeoff here is that Haiku adds latency but produces much better summaries"
  expect(classifyHeuristic(text)).toBe('tradeoff')
})

test('classifies exploration thinking block', () => {
  expect(classifyHeuristic('Let me check the existing code structure')).toBe('exploration')
})

test('falls back to raw for unrecognized text', () => {
  expect(classifyHeuristic('some random unclassifiable text here')).toBe('raw')
})

test('summarizeHeuristic returns first sentence truncated to 120 chars', () => {
  const text = "I'll go with a tree because it groups naturally. This is the second sentence."
  expect(summarizeHeuristic(text)).toBe("I'll go with a tree because it groups naturally")
})

test('applyHeuristics fills type and summary on events', () => {
  const event: ThinkingEvent = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    session_id: 'sess_1',
    timestamp: '2026-02-25T10:00:00.000Z',
    type: 'raw',
    summary: '',
    raw_thinking: "I'll go with a tree because it groups naturally by file path",
    response_text: 'Implementing tree.',
    tool_calls: [],
    files_affected: [],
    prompt_context: 'test'
  }
  const [result] = applyHeuristics([event])
  expect(result.type).toBe('decision')
  expect(result.summary).toBeTruthy()
  expect(result.summary.length).toBeLessThanOrEqual(120)
})
