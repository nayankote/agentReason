import { buildClaudeMdSection, injectIntoClaudeMd } from './rebuilder.js'
import type { ThinkingEvent } from './schema.js'

const makeEvent = (id: string, summary: string, files: string[]): ThinkingEvent => ({
  id,
  session_id: 'sess_1',
  timestamp: '2026-02-25T10:00:00.000Z',
  type: 'decision',
  summary,
  raw_thinking: summary,
  response_text: '',
  tool_calls: [],
  files_affected: files,
  prompt_context: 'test'
})

test('buildClaudeMdSection groups events by file', () => {
  const events = [
    makeEvent('123e4567-e89b-12d3-a456-426614174001', 'chose tree structure', ['src/graph/file.ts']),
    makeEvent('123e4567-e89b-12d3-a456-426614174002', 'haiku vs heuristic tradeoff', ['src/summarizer.ts'])
  ]
  const section = buildClaudeMdSection(events)
  expect(section).toContain('src/graph/file.ts')
  expect(section).toContain('chose tree structure')
  expect(section).toContain('src/summarizer.ts')
  expect(section).toContain('haiku vs heuristic tradeoff')
})

test('buildClaudeMdSection starts with ## Agent Context', () => {
  const events = [makeEvent('123e4567-e89b-12d3-a456-426614174001', 'decision', ['src/foo.ts'])]
  const section = buildClaudeMdSection(events)
  expect(section.startsWith('## Agent Context')).toBe(true)
})

test('injectIntoClaudeMd replaces existing Agent Context section', () => {
  const existing = `# Project\n\nSome content.\n\n## Agent Context\n\nOld stuff.\n\n## Other Section\n\nOther.\n`
  const newSection = '## Agent Context\n\nNew stuff.\n'
  const result = injectIntoClaudeMd(existing, newSection)
  expect(result).toContain('New stuff.')
  expect(result).not.toContain('Old stuff.')
  expect(result).toContain('## Other Section')
})

test('injectIntoClaudeMd appends section if none exists', () => {
  const existing = '# Project\n\nSome content.\n'
  const newSection = '## Agent Context\n\nNew stuff.\n'
  const result = injectIntoClaudeMd(existing, newSection)
  expect(result).toContain('New stuff.')
  expect(result).toContain('# Project')
})

test('injectIntoClaudeMd preserves sections after Agent Context', () => {
  const existing = `# Project\n\n## Agent Context\n\nOld.\n\n## Usage\n\nUsage docs.\n`
  const result = injectIntoClaudeMd(existing, '## Agent Context\n\nNew.\n')
  expect(result).toContain('## Usage')
  expect(result).toContain('Usage docs.')
})
