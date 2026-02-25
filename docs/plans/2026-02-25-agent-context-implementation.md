# agent-context Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Build a Claude Code plugin that extracts thinking blocks and model outputs from JSONL transcripts, stores them in a pluggable context graph, and injects relevant reasoning history into future sessions via hooks.

**Architecture:** A three-layer pipeline — Extractor (JSONL → ThinkingEvent[]), Graph Store (pluggable file/session/decision backends in `.agent-context/`), and Retriever+Injector (Claude Code hooks wire retrieval into session start). The `Stop` hook extracts and stores after each session; the `UserPromptSubmit` hook injects a ≤2000-token context slice on first turn only.

**Tech Stack:** TypeScript (Node.js), `commander` for CLI, `@anthropic-ai/sdk` for Haiku summarization, `zod` for schema validation, `simple-git` for git commits.

---

## Task 1: Project scaffold + schema

**Files:**
- Create: `agent-context/package.json`
- Create: `agent-context/tsconfig.json`
- Create: `agent-context/src/schema.ts`
- Create: `agent-context/src/schema.test.ts`

**Step 1: Create project scaffold**

```bash
mkdir -p agent-context/src agent-context/hooks agent-context/tests
```

**Step 2: Write `package.json`**

```json
{
  "name": "agent-context",
  "version": "0.1.0",
  "type": "module",
  "bin": { "agent-context": "./dist/cli.js" },
  "scripts": {
    "build": "tsc",
    "test": "node --experimental-vm-modules node_modules/.bin/jest",
    "dev": "ts-node src/cli.ts"
  },
  "dependencies": {
    "@anthropic-ai/sdk": "^0.36.0",
    "commander": "^12.0.0",
    "simple-git": "^3.22.0",
    "uuid": "^9.0.0",
    "zod": "^3.22.0"
  },
  "devDependencies": {
    "@types/node": "^20.0.0",
    "@types/uuid": "^9.0.0",
    "jest": "^29.0.0",
    "ts-jest": "^29.0.0",
    "typescript": "^5.3.0"
  },
  "jest": {
    "preset": "ts-jest",
    "testEnvironment": "node",
    "extensionsToTreatAsEsm": [".ts"],
    "moduleNameMapper": { "^(\\.{1,2}/.*)\\.js$": "$1" }
  }
}
```

**Step 3: Write `tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "outDir": "./dist",
    "rootDir": "./src",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*", "hooks/**/*"]
}
```

**Step 4: Write failing test for schema**

```typescript
// agent-context/src/schema.test.ts
import { ThinkingEventSchema, ToolCallSummarySchema } from './schema.js'

test('ThinkingEvent validates a complete event', () => {
  const event = {
    id: '123e4567-e89b-12d3-a456-426614174000',
    session_id: 'sess_abc',
    timestamp: '2026-02-25T10:00:00.000Z',
    type: 'decision' as const,
    summary: 'Chose file-centric tree over flat list',
    raw_thinking: 'I could use a flat list but a tree is better because...',
    model_output: 'I will implement the file-centric tree backend first.',
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
```

**Step 5: Run test to verify it fails**

```bash
cd agent-context && npm install && npm test -- schema
```
Expected: FAIL with "Cannot find module './schema.js'"

**Step 6: Write `src/schema.ts`**

```typescript
import { z } from 'zod'

export const ToolCallSummarySchema = z.object({
  tool_name: z.string(),
  input_summary: z.string(),
  outcome: z.enum(['success', 'error', 'reverted'])
})

export const ThinkingEventSchema = z.object({
  id: z.string(),
  session_id: z.string(),
  timestamp: z.string(),
  type: z.enum(['decision', 'rejection', 'tradeoff', 'exploration', 'raw']),
  summary: z.string(),
  raw_thinking: z.string(),
  model_output: z.string(),
  tool_calls: z.array(ToolCallSummarySchema),
  files_affected: z.array(z.string()),
  prompt_context: z.string()
})

export const GraphConfigSchema = z.object({
  backend: z.enum(['file', 'session', 'decision']),
  last_extracted_session: z.string().optional()
})

export type ThinkingEvent = z.infer<typeof ThinkingEventSchema>
export type ToolCallSummary = z.infer<typeof ToolCallSummarySchema>
export type GraphConfig = z.infer<typeof GraphConfigSchema>
```

**Step 7: Run test to verify it passes**

```bash
npm test -- schema
```
Expected: PASS

**Step 8: Commit**

```bash
git add agent-context/
git commit -m "feat: scaffold agent-context project with zod schemas"
```

---

## Task 2: JSONL extractor

**Files:**
- Create: `agent-context/src/extractor.ts`
- Create: `agent-context/src/extractor.test.ts`

**Background:** Claude Code JSONL files are at `~/.claude/projects/<hash>/<session-id>.jsonl`. Each line is a JSON object. Relevant line types:
- `{ "type": "assistant", "message": { "content": [{ "type": "thinking", "thinking": "..." }, { "type": "text", "text": "..." }] } }` — thinking block + model output
- `{ "type": "tool_use", "name": "...", "input": {...} }` — tool call (inside assistant message content)
- `{ "type": "user", "message": { "content": [{ "type": "text", "text": "..." }] } }` — user prompt

**Step 1: Write failing tests**

```typescript
// agent-context/src/extractor.test.ts
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
        { type: 'thinking', thinking: 'I could use a flat list but a tree is better because it groups by file' },
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
  expect(events[0].model_output).toContain('file-centric tree')
  expect(events[0].prompt_context).toBe('implement the graph backend')
  expect(events[0].type).toBe('raw') // not summarized yet
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
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- extractor
```
Expected: FAIL with "Cannot find module './extractor.js'"

**Step 3: Write `src/extractor.ts`**

```typescript
import { randomUUID } from 'crypto'
import type { ThinkingEvent, ToolCallSummary } from './schema.js'

export function extractFromLines(lines: string[], sessionId: string): ThinkingEvent[] {
  const parsed = lines.flatMap(line => {
    try { return [JSON.parse(line)] } catch { return [] }
  })

  const events: ThinkingEvent[] = []
  let lastUserPrompt = ''

  for (const record of parsed) {
    if (record.type === 'user') {
      const content = record.message?.content ?? []
      const text = content.find((c: any) => c.type === 'text')?.text ?? ''
      if (text) lastUserPrompt = text
    }

    if (record.type === 'assistant') {
      const content: any[] = record.message?.content ?? []
      const thinkingBlock = content.find(c => c.type === 'thinking')
      if (!thinkingBlock) continue

      const textBlock = content.find(c => c.type === 'text')
      const toolCalls: ToolCallSummary[] = content
        .filter(c => c.type === 'tool_use')
        .map(c => ({
          tool_name: c.name ?? 'unknown',
          input_summary: JSON.stringify(c.input ?? {}).slice(0, 200),
          outcome: 'success' as const
        }))

      events.push({
        id: randomUUID(),
        session_id: sessionId,
        timestamp: record.timestamp ?? new Date().toISOString(),
        type: 'raw',
        summary: '',
        raw_thinking: thinkingBlock.thinking ?? '',
        model_output: textBlock?.text ?? '',
        tool_calls: toolCalls,
        files_affected: [],
        prompt_context: lastUserPrompt
      })
    }
  }

  return events
}

export function findProjectJSONL(projectHash: string): string {
  const home = process.env.HOME ?? ''
  return `${home}/.claude/projects/${projectHash}`
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- extractor
```
Expected: PASS

**Step 5: Commit**

```bash
git add agent-context/src/extractor.ts agent-context/src/extractor.test.ts
git commit -m "feat: add JSONL extractor for thinking blocks and model output"
```

---

## Task 3: Summarizer (heuristic + Haiku)

**Files:**
- Create: `agent-context/src/summarizer.ts`
- Create: `agent-context/src/summarizer.test.ts`

**Step 1: Write failing tests**

```typescript
// agent-context/src/summarizer.test.ts
import { classifyHeuristic, summarizeHeuristic } from './summarizer.js'

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

test('falls back to raw for unrecognized text', () => {
  expect(classifyHeuristic('Let me look at the existing code')).toBe('exploration')
  expect(classifyHeuristic('some random text')).toBe('raw')
})

test('summarizeHeuristic returns first sentence truncated to 120 chars', () => {
  const text = "I'll go with a tree because it groups naturally. This is the second sentence."
  expect(summarizeHeuristic(text)).toBe("I'll go with a tree because it groups naturally.")
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- summarizer
```
Expected: FAIL with "Cannot find module './summarizer.js'"

**Step 3: Write `src/summarizer.ts`**

```typescript
import Anthropic from '@anthropic-ai/sdk'
import type { ThinkingEvent } from './schema.js'

const DECISION_PATTERNS = [
  /i('ll| will) go with .+ because/i,
  /i could .+ but (instead|i'll)/i,
  /choosing .+ over/i,
  /decided to/i
]
const REJECTION_PATTERNS = [
  /that won't work/i,
  /actually,? that/i,
  /let me revert/i,
  /that approach has a problem/i,
  /this won't/i
]
const TRADEOFF_PATTERNS = [
  /the tradeoff (here )?is/i,
  /this is (slower|faster|simpler|more complex) but/i,
  /for now i('ll)?.+but ideally/i
]
const EXPLORATION_PATTERNS = [
  /let me (check|look|see|explore)/i,
  /i wonder if/i,
  /let me (think|consider)/i
]

export function classifyHeuristic(text: string): ThinkingEvent['type'] {
  if (DECISION_PATTERNS.some(p => p.test(text))) return 'decision'
  if (REJECTION_PATTERNS.some(p => p.test(text))) return 'rejection'
  if (TRADEOFF_PATTERNS.some(p => p.test(text))) return 'tradeoff'
  if (EXPLORATION_PATTERNS.some(p => p.test(text))) return 'exploration'
  return 'raw'
}

export function summarizeHeuristic(text: string): string {
  const firstSentence = text.split(/[.!?]/)[0]?.trim() ?? text.slice(0, 120)
  return firstSentence.length > 120 ? firstSentence.slice(0, 117) + '...' : firstSentence
}

export function applyHeuristics(events: ThinkingEvent[]): ThinkingEvent[] {
  return events.map(e => ({
    ...e,
    type: classifyHeuristic(e.raw_thinking),
    summary: summarizeHeuristic(e.raw_thinking)
  }))
}

export async function summarizeWithHaiku(events: ThinkingEvent[]): Promise<ThinkingEvent[]> {
  const client = new Anthropic()
  const prompt = `You are summarizing AI coding agent reasoning. For each thinking block below, produce:
1. type: one of decision|rejection|tradeoff|exploration|raw
2. summary: one sentence (max 120 chars) capturing the key point

Respond as a JSON array with objects: { "id": "<id>", "type": "<type>", "summary": "<summary>" }

Thinking blocks:
${events.map(e => `ID: ${e.id}\nTHINKING: ${e.raw_thinking.slice(0, 500)}`).join('\n\n')}`

  const response = await client.messages.create({
    model: 'claude-haiku-4-5-20251001',
    max_tokens: 1024,
    messages: [{ role: 'user', content: prompt }]
  })

  const text = response.content[0].type === 'text' ? response.content[0].text : ''
  const jsonMatch = text.match(/\[[\s\S]*\]/)
  if (!jsonMatch) return applyHeuristics(events)

  const results: { id: string; type: ThinkingEvent['type']; summary: string }[] = JSON.parse(jsonMatch[0])
  const byId = new Map(results.map(r => [r.id, r]))

  return events.map(e => {
    const result = byId.get(e.id)
    return result ? { ...e, type: result.type, summary: result.summary } : e
  })
}

export async function summarize(events: ThinkingEvent[]): Promise<ThinkingEvent[]> {
  if (!process.env.ANTHROPIC_API_KEY) return applyHeuristics(events)
  try {
    return await summarizeWithHaiku(events)
  } catch {
    return applyHeuristics(events)
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- summarizer
```
Expected: PASS

**Step 5: Commit**

```bash
git add agent-context/src/summarizer.ts agent-context/src/summarizer.test.ts
git commit -m "feat: add heuristic and Haiku summarizer for thinking events"
```

---

## Task 4: GraphBackend interface + file-centric tree backend

**Files:**
- Create: `agent-context/src/graph/interface.ts`
- Create: `agent-context/src/graph/file.ts`
- Create: `agent-context/src/graph/file.test.ts`

**Step 1: Write `src/graph/interface.ts`**

```typescript
import type { ThinkingEvent } from '../schema.js'

export interface GraphBackend {
  ingest(events: ThinkingEvent[]): void
  query(prompt: string, filesHinted: string[]): ThinkingEvent[]
  serialize(): object
  deserialize(data: object): void
}
```

**Step 2: Write failing test for file backend**

```typescript
// agent-context/src/graph/file.test.ts
import { FileGraphBackend } from './file.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, files: string[], summary: string): ThinkingEvent => ({
  id, session_id: 'sess_1', timestamp: '2026-02-25T10:00:00.000Z',
  type: 'decision', summary, raw_thinking: summary, model_output: '',
  tool_calls: [], files_affected: files, prompt_context: 'test prompt'
})

test('ingest stores events under their affected files', () => {
  const backend = new FileGraphBackend()
  backend.ingest([makeEvent('e1', ['src/graph/file.ts'], 'chose tree structure')])
  const results = backend.query('graph', ['src/graph/file.ts'])
  expect(results).toHaveLength(1)
  expect(results[0].id).toBe('e1')
})

test('query returns events for hinted files', () => {
  const backend = new FileGraphBackend()
  backend.ingest([
    makeEvent('e1', ['src/foo.ts'], 'foo decision'),
    makeEvent('e2', ['src/bar.ts'], 'bar decision')
  ])
  const results = backend.query('anything', ['src/foo.ts'])
  expect(results.map(e => e.id)).toContain('e1')
  expect(results.map(e => e.id)).not.toContain('e2')
})

test('serialize and deserialize round-trips correctly', () => {
  const backend = new FileGraphBackend()
  backend.ingest([makeEvent('e1', ['src/foo.ts'], 'foo decision')])
  const data = backend.serialize()
  const backend2 = new FileGraphBackend()
  backend2.deserialize(data)
  expect(backend2.query('anything', ['src/foo.ts'])).toHaveLength(1)
})
```

**Step 3: Run test to verify it fails**

```bash
npm test -- graph/file
```
Expected: FAIL with "Cannot find module './file.js'"

**Step 4: Write `src/graph/file.ts`**

```typescript
import type { GraphBackend } from './interface.js'
import type { ThinkingEvent } from '../schema.js'

type FileTree = {
  [filePath: string]: ThinkingEvent[]
}

export class FileGraphBackend implements GraphBackend {
  private tree: FileTree = {}

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      const files = event.files_affected.length > 0 ? event.files_affected : ['__unattributed__']
      for (const file of files) {
        if (!this.tree[file]) this.tree[file] = []
        // deduplicate by id
        if (!this.tree[file].find(e => e.id === event.id)) {
          this.tree[file].push(event)
        }
      }
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    const results: ThinkingEvent[] = []
    const seen = new Set<string>()

    // First: exact file matches
    for (const file of filesHinted) {
      for (const event of this.tree[file] ?? []) {
        if (!seen.has(event.id)) { results.push(event); seen.add(event.id) }
      }
    }

    // Second: keyword match on prompt against all files if results are sparse
    if (results.length < 3) {
      const keywords = prompt.toLowerCase().split(/\s+/)
      for (const [file, events] of Object.entries(this.tree)) {
        if (filesHinted.includes(file)) continue
        if (keywords.some(kw => file.toLowerCase().includes(kw))) {
          for (const event of events) {
            if (!seen.has(event.id)) { results.push(event); seen.add(event.id) }
          }
        }
      }
    }

    // Sort by recency
    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  serialize(): object {
    return { type: 'file', tree: this.tree }
  }

  deserialize(data: object): void {
    const d = data as { tree: FileTree }
    this.tree = d.tree ?? {}
  }
}
```

**Step 5: Run test to verify it passes**

```bash
npm test -- graph/file
```
Expected: PASS

**Step 6: Commit**

```bash
git add agent-context/src/graph/
git commit -m "feat: add GraphBackend interface and file-centric tree backend"
```

---

## Task 5: Session DAG backend

**Files:**
- Create: `agent-context/src/graph/session.ts`
- Create: `agent-context/src/graph/session.test.ts`

**Step 1: Write failing test**

```typescript
// agent-context/src/graph/session.test.ts
import { SessionGraphBackend } from './session.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, sessionId: string, ts: string): ThinkingEvent => ({
  id, session_id: sessionId, timestamp: ts, type: 'decision',
  summary: `decision in ${sessionId}`, raw_thinking: 'thinking...', model_output: '',
  tool_calls: [], files_affected: [], prompt_context: 'prompt'
})

test('ingest builds session nodes in temporal order', () => {
  const backend = new SessionGraphBackend()
  backend.ingest([
    makeEvent('e1', 'sess_1', '2026-02-25T10:00:00.000Z'),
    makeEvent('e2', 'sess_2', '2026-02-25T11:00:00.000Z')
  ])
  const results = backend.query('anything', [])
  expect(results[0].session_id).toBe('sess_2') // most recent first
})

test('serialize and deserialize round-trips', () => {
  const backend = new SessionGraphBackend()
  backend.ingest([makeEvent('e1', 'sess_1', '2026-02-25T10:00:00.000Z')])
  const backend2 = new SessionGraphBackend()
  backend2.deserialize(backend.serialize())
  expect(backend2.query('anything', [])).toHaveLength(1)
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- graph/session
```
Expected: FAIL

**Step 3: Write `src/graph/session.ts`**

```typescript
import type { GraphBackend } from './interface.js'
import type { ThinkingEvent } from '../schema.js'

type SessionNode = {
  session_id: string
  started_at: string
  events: ThinkingEvent[]
}

export class SessionGraphBackend implements GraphBackend {
  private sessions: Map<string, SessionNode> = new Map()

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      let node = this.sessions.get(event.session_id)
      if (!node) {
        node = { session_id: event.session_id, started_at: event.timestamp, events: [] }
        this.sessions.set(event.session_id, node)
      }
      if (!node.events.find(e => e.id === event.id)) node.events.push(event)
      // Keep started_at as earliest timestamp
      if (event.timestamp < node.started_at) node.started_at = event.timestamp
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    const sorted = [...this.sessions.values()]
      .sort((a, b) => b.started_at.localeCompare(a.started_at))

    const results: ThinkingEvent[] = []
    const seen = new Set<string>()

    for (const session of sorted) {
      for (const event of session.events) {
        if (seen.has(event.id)) continue
        // Include if files match or prompt keywords match
        const promptMatch = prompt.toLowerCase().split(/\s+/)
          .some(kw => event.summary.toLowerCase().includes(kw) || event.raw_thinking.toLowerCase().includes(kw))
        const fileMatch = filesHinted.some(f => event.files_affected.includes(f))
        if (promptMatch || fileMatch || results.length < 3) {
          results.push(event)
          seen.add(event.id)
        }
      }
    }

    return results
  }

  serialize(): object {
    return { type: 'session', sessions: Object.fromEntries(this.sessions) }
  }

  deserialize(data: object): void {
    const d = data as { sessions: Record<string, SessionNode> }
    this.sessions = new Map(Object.entries(d.sessions ?? {}))
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- graph/session
```
Expected: PASS

**Step 5: Commit**

```bash
git add agent-context/src/graph/session.ts agent-context/src/graph/session.test.ts
git commit -m "feat: add session DAG graph backend"
```

---

## Task 6: Decision graph backend

**Files:**
- Create: `agent-context/src/graph/decision.ts`
- Create: `agent-context/src/graph/decision.test.ts`

**Step 1: Write failing test**

```typescript
// agent-context/src/graph/decision.test.ts
import { DecisionGraphBackend } from './decision.js'
import type { ThinkingEvent } from '../schema.js'

const makeEvent = (id: string, type: ThinkingEvent['type'], summary: string, files: string[]): ThinkingEvent => ({
  id, session_id: 'sess_1', timestamp: '2026-02-25T10:00:00.000Z', type,
  summary, raw_thinking: summary, model_output: '',
  tool_calls: [], files_affected: files, prompt_context: 'test'
})

test('only ingests decision, rejection, tradeoff events (not raw/exploration)', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('e1', 'decision', 'chose tree', ['src/graph/file.ts']),
    makeEvent('e2', 'raw', 'some raw thinking', []),
    makeEvent('e3', 'tradeoff', 'speed vs accuracy', ['src/summarizer.ts'])
  ])
  const results = backend.query('graph', [])
  expect(results.map(e => e.id)).toContain('e1')
  expect(results.map(e => e.id)).not.toContain('e2')
})

test('query returns events matching prompt keywords', () => {
  const backend = new DecisionGraphBackend()
  backend.ingest([
    makeEvent('e1', 'decision', 'chose tree structure for graph', ['src/graph/file.ts']),
    makeEvent('e2', 'tradeoff', 'haiku latency vs quality', ['src/summarizer.ts'])
  ])
  const results = backend.query('haiku summarizer', [])
  expect(results.map(e => e.id)).toContain('e2')
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- graph/decision
```
Expected: FAIL

**Step 3: Write `src/graph/decision.ts`**

```typescript
import type { GraphBackend } from './interface.js'
import type { ThinkingEvent } from '../schema.js'

const DECISION_TYPES = new Set<ThinkingEvent['type']>(['decision', 'rejection', 'tradeoff'])

export class DecisionGraphBackend implements GraphBackend {
  private nodes: Map<string, ThinkingEvent> = new Map()

  ingest(events: ThinkingEvent[]): void {
    for (const event of events) {
      if (DECISION_TYPES.has(event.type) && !this.nodes.has(event.id)) {
        this.nodes.set(event.id, event)
      }
    }
  }

  query(prompt: string, filesHinted: string[]): ThinkingEvent[] {
    const keywords = prompt.toLowerCase().split(/\s+/).filter(k => k.length > 2)
    const results: ThinkingEvent[] = []

    for (const event of this.nodes.values()) {
      const text = (event.summary + ' ' + event.raw_thinking).toLowerCase()
      const fileMatch = filesHinted.some(f => event.files_affected.includes(f))
      const keywordMatch = keywords.some(kw => text.includes(kw))
      if (fileMatch || keywordMatch) results.push(event)
    }

    if (results.length === 0) {
      // Return all decisions sorted by recency as fallback
      return [...this.nodes.values()].sort((a, b) => b.timestamp.localeCompare(a.timestamp))
    }

    return results.sort((a, b) => b.timestamp.localeCompare(a.timestamp))
  }

  serialize(): object {
    return { type: 'decision', nodes: Object.fromEntries(this.nodes) }
  }

  deserialize(data: object): void {
    const d = data as { nodes: Record<string, ThinkingEvent> }
    this.nodes = new Map(Object.entries(d.nodes ?? {}))
  }
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- graph/decision
```
Expected: PASS

**Step 5: Commit**

```bash
git add agent-context/src/graph/decision.ts agent-context/src/graph/decision.test.ts
git commit -m "feat: add decision graph backend"
```

---

## Task 7: Retriever + injector

**Files:**
- Create: `agent-context/src/retriever.ts`
- Create: `agent-context/src/injector.ts`
- Create: `agent-context/src/retriever.test.ts`

**Step 1: Write failing test**

```typescript
// agent-context/src/retriever.test.ts
import { buildContextSlice } from './retriever.js'
import { formatContextSlice } from './injector.js'
import type { ThinkingEvent } from './schema.js'

const makeEvent = (id: string, summary: string, files: string[]): ThinkingEvent => ({
  id, session_id: 'sess_1', timestamp: '2026-02-25T10:00:00.000Z', type: 'decision',
  summary, raw_thinking: 'detailed thinking: ' + summary, model_output: 'output: ' + summary,
  tool_calls: [], files_affected: files, prompt_context: 'test'
})

test('buildContextSlice caps output at token budget', () => {
  const events = Array.from({ length: 20 }, (_, i) =>
    makeEvent(`e${i}`, `decision ${i} about something important`, [`src/file${i}.ts`])
  )
  const slice = buildContextSlice(events, 500)
  // rough token estimate: each event ~50 tokens, 500 budget → ~10 events max
  expect(slice.length).toBeLessThan(20)
})

test('formatContextSlice produces non-empty string', () => {
  const events = [makeEvent('e1', 'chose tree structure', ['src/graph/file.ts'])]
  const output = formatContextSlice(events)
  expect(output).toContain('chose tree structure')
  expect(output).toContain('src/graph/file.ts')
})
```

**Step 2: Run test to verify it fails**

```bash
npm test -- retriever
```
Expected: FAIL

**Step 3: Write `src/retriever.ts`**

```typescript
import type { ThinkingEvent } from './schema.js'

// Rough token estimate: 1 token ≈ 4 chars
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4)
}

export function buildContextSlice(events: ThinkingEvent[], tokenBudget = 2000): ThinkingEvent[] {
  const slice: ThinkingEvent[] = []
  let used = 0

  for (const event of events) {
    const cost = estimateTokens(event.summary + event.model_output + event.files_affected.join(','))
    if (used + cost > tokenBudget) break
    slice.push(event)
    used += cost
  }

  return slice
}
```

**Step 4: Write `src/injector.ts`**

```typescript
import type { ThinkingEvent } from './schema.js'

export function formatContextSlice(events: ThinkingEvent[]): string {
  if (events.length === 0) return ''

  const byFile = new Map<string, ThinkingEvent[]>()
  for (const event of events) {
    const files = event.files_affected.length > 0 ? event.files_affected : ['__general__']
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file)!.push(event)
    }
  }

  const lines = [
    '## Past Reasoning Context',
    '',
    'Relevant decisions and trade-offs from previous sessions on this codebase:',
    ''
  ]

  for (const [file, fileEvents] of byFile) {
    if (file !== '__general__') lines.push(`### ${file}`)
    for (const event of fileEvents) {
      lines.push(`- **[${event.type}]** ${event.summary}`)
      if (event.model_output) lines.push(`  > ${event.model_output.slice(0, 200)}`)
    }
    lines.push('')
  }

  return lines.join('\n')
}
```

**Step 5: Run test to verify it passes**

```bash
npm test -- retriever
```
Expected: PASS

**Step 6: Commit**

```bash
git add agent-context/src/retriever.ts agent-context/src/injector.ts agent-context/src/retriever.test.ts
git commit -m "feat: add retriever and injector for context slice formatting"
```

---

## Task 8: CLAUDE.md rebuilder

**Files:**
- Create: `agent-context/src/rebuilder.ts`
- Create: `agent-context/src/rebuilder.test.ts`

**Step 1: Write failing test**

```typescript
// agent-context/src/rebuilder.test.ts
import { buildClaudeMdSection, injectIntoClaudeMd } from './rebuilder.js'
import type { ThinkingEvent } from './schema.js'

const makeEvent = (id: string, summary: string, files: string[]): ThinkingEvent => ({
  id, session_id: 'sess_1', timestamp: '2026-02-25T10:00:00.000Z', type: 'decision',
  summary, raw_thinking: summary, model_output: '',
  tool_calls: [], files_affected: files, prompt_context: 'test'
})

test('buildClaudeMdSection groups events by file', () => {
  const events = [
    makeEvent('e1', 'chose tree structure', ['src/graph/file.ts']),
    makeEvent('e2', 'haiku vs heuristic tradeoff', ['src/summarizer.ts'])
  ]
  const section = buildClaudeMdSection(events)
  expect(section).toContain('src/graph/file.ts')
  expect(section).toContain('chose tree structure')
  expect(section).toContain('src/summarizer.ts')
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
```

**Step 2: Run test to verify it fails**

```bash
npm test -- rebuilder
```
Expected: FAIL

**Step 3: Write `src/rebuilder.ts`**

```typescript
import type { ThinkingEvent } from './schema.js'

export function buildClaudeMdSection(events: ThinkingEvent[]): string {
  const byFile = new Map<string, ThinkingEvent[]>()

  for (const event of events) {
    const files = event.files_affected.length > 0 ? event.files_affected : ['General']
    for (const file of files) {
      if (!byFile.has(file)) byFile.set(file, [])
      byFile.get(file)!.push(event)
    }
  }

  const lines = ['## Agent Context', '', '> Auto-generated by agent-context. Do not edit manually.', '']

  for (const [file, fileEvents] of byFile) {
    lines.push(`### ${file}`)
    for (const event of fileEvents) {
      lines.push(`- **[${event.type}]** ${event.summary} *(${event.timestamp.slice(0, 10)})*`)
    }
    lines.push('')
  }

  return lines.join('\n')
}

export function injectIntoClaudeMd(existing: string, newSection: string): string {
  const sectionRegex = /^## Agent Context\n[\s\S]*?(?=^## |\Z)/m

  if (sectionRegex.test(existing)) {
    return existing.replace(sectionRegex, newSection + '\n')
  }

  return existing.trimEnd() + '\n\n' + newSection
}
```

**Step 4: Run test to verify it passes**

```bash
npm test -- rebuilder
```
Expected: PASS

**Step 5: Commit**

```bash
git add agent-context/src/rebuilder.ts agent-context/src/rebuilder.test.ts
git commit -m "feat: add CLAUDE.md rebuilder for Agent Context section"
```

---

## Task 9: Stop hook + UserPromptSubmit hook

**Files:**
- Create: `agent-context/hooks/stop.ts`
- Create: `agent-context/hooks/user-prompt.ts`

**Background:** Claude Code hooks receive input via stdin as JSON. `Stop` hook input: `{ "session_id": "...", "transcript_path": "..." }`. `UserPromptSubmit` hook input: `{ "prompt": "...", "session_id": "..." }`. Stdout from hooks is injected as context. Exit code 0 = proceed. Exit code 2 = block with stdout as error message.

**Step 1: Write `hooks/stop.ts`**

```typescript
#!/usr/bin/env node
import { readFileSync, writeFileSync, appendFileSync, existsSync } from 'fs'
import { join } from 'path'
import { extractFromLines } from '../src/extractor.js'
import { summarize } from '../src/summarizer.js'
import { FileGraphBackend } from '../src/graph/file.js'
import { SessionGraphBackend } from '../src/graph/session.js'
import { DecisionGraphBackend } from '../src/graph/decision.js'
import { buildClaudeMdSection, injectIntoClaudeMd } from '../src/rebuilder.js'
import { GraphConfigSchema } from '../src/schema.js'
import simpleGit from 'simple-git'
import type { GraphBackend } from '../src/graph/interface.js'

async function main() {
  const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'))
  const { transcript_path, session_id } = input

  const contextDir = join(process.cwd(), '.agent-context')
  if (!existsSync(contextDir)) process.exit(0) // not initialized

  // Read config
  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )

  // Extract events from transcript
  const lines = readFileSync(transcript_path, 'utf-8').split('\n').filter(Boolean)
  const rawEvents = extractFromLines(lines, session_id)
  if (rawEvents.length === 0) process.exit(0)

  const events = await summarize(rawEvents)

  // Append to events.jsonl
  const eventsPath = join(contextDir, 'events.jsonl')
  for (const event of events) {
    appendFileSync(eventsPath, JSON.stringify(event) + '\n')
  }

  // Load + update graph
  const graphPath = join(contextDir, 'graph.json')
  const backend: GraphBackend = config.backend === 'session'
    ? new SessionGraphBackend()
    : config.backend === 'decision'
    ? new DecisionGraphBackend()
    : new FileGraphBackend()

  if (existsSync(graphPath)) {
    backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))
  }
  backend.ingest(events)
  writeFileSync(graphPath, JSON.stringify(backend.serialize(), null, 2))

  // Rebuild CLAUDE.md
  const allEvents = readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(Boolean).map(l => JSON.parse(l))
  const section = buildClaudeMdSection(allEvents)
  const claudeMdPath = join(process.cwd(), 'CLAUDE.md')
  const existing = existsSync(claudeMdPath) ? readFileSync(claudeMdPath, 'utf-8') : ''
  writeFileSync(claudeMdPath, injectIntoClaudeMd(existing, section))

  // Commit
  const git = simpleGit(process.cwd())
  await git.add(['.agent-context/', 'CLAUDE.md'])
  await git.commit(`chore: update agent context [session ${session_id.slice(0, 8)}]`)

  process.exit(0)
}

main().catch(() => process.exit(0)) // never block claude on hook failure
```

**Step 2: Write `hooks/user-prompt.ts`**

```typescript
#!/usr/bin/env node
import { readFileSync, existsSync } from 'fs'
import { join } from 'path'
import { FileGraphBackend } from '../src/graph/file.js'
import { SessionGraphBackend } from '../src/graph/session.js'
import { DecisionGraphBackend } from '../src/graph/decision.js'
import { buildContextSlice } from '../src/retriever.js'
import { formatContextSlice } from '../src/injector.js'
import { GraphConfigSchema } from '../src/schema.js'
import type { GraphBackend } from '../src/graph/interface.js'

function main() {
  // Only inject on first turn of session
  if (process.env.AGENT_CONTEXT_INJECTED) process.exit(0)

  const input = JSON.parse(readFileSync('/dev/stdin', 'utf-8'))
  const { prompt } = input

  const contextDir = join(process.cwd(), '.agent-context')
  const graphPath = join(contextDir, 'graph.json')
  if (!existsSync(graphPath)) process.exit(0)

  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )

  const backend: GraphBackend = config.backend === 'session'
    ? new SessionGraphBackend()
    : config.backend === 'decision'
    ? new DecisionGraphBackend()
    : new FileGraphBackend()

  backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))

  // Hint files from prompt (simple heuristic: look for path-like tokens)
  const filesHinted = prompt.match(/[\w/.-]+\.[a-z]{1,5}/g) ?? []
  const events = backend.query(prompt, filesHinted)
  const slice = buildContextSlice(events, 2000)
  const formatted = formatContextSlice(slice)

  if (formatted) {
    // Write AGENT_CONTEXT_INJECTED to env file to skip subsequent turns
    const envFile = process.env.CLAUDE_ENV_FILE
    if (envFile) {
      const { appendFileSync } = require('fs')
      appendFileSync(envFile, 'AGENT_CONTEXT_INJECTED=1\n')
    }
    process.stdout.write(formatted)
  }

  process.exit(0)
}

try { main() } catch { process.exit(0) }
```

**Step 3: Verify hooks compile**

```bash
npx tsc --noEmit
```
Expected: no errors

**Step 4: Commit**

```bash
git add agent-context/hooks/
git commit -m "feat: add Stop and UserPromptSubmit hooks"
```

---

## Task 10: CLI commands

**Files:**
- Create: `agent-context/src/cli.ts`

**Step 1: Write `src/cli.ts`**

```typescript
#!/usr/bin/env node
import { Command } from 'commander'
import { mkdirSync, writeFileSync, readFileSync, existsSync, appendFileSync } from 'fs'
import { join } from 'path'
import { extractFromLines } from './extractor.js'
import { summarize } from './summarizer.js'
import { buildContextSlice } from './retriever.js'
import { formatContextSlice } from './injector.js'
import { FileGraphBackend } from './graph/file.js'
import { SessionGraphBackend } from './graph/session.js'
import { DecisionGraphBackend } from './graph/decision.js'
import { GraphConfigSchema } from './schema.js'
import type { GraphBackend } from './graph/interface.js'

const program = new Command()

program.name('agent-context').description('Claude Code context graph plugin').version('0.1.0')

function loadBackend(contextDir: string): GraphBackend {
  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )
  const graphPath = join(contextDir, 'graph.json')
  const backend: GraphBackend = config.backend === 'session'
    ? new SessionGraphBackend()
    : config.backend === 'decision'
    ? new DecisionGraphBackend()
    : new FileGraphBackend()
  if (existsSync(graphPath)) backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))
  return backend
}

program.command('init').description('Initialize .agent-context/ in current project').action(() => {
  const contextDir = join(process.cwd(), '.agent-context')
  mkdirSync(contextDir, { recursive: true })
  writeFileSync(join(contextDir, 'config.json'), JSON.stringify({ backend: 'file' }, null, 2))
  writeFileSync(join(contextDir, 'events.jsonl'), '')
  console.log('Initialized .agent-context/')
})

program.command('install').description('Register hooks in .claude/settings.json').action(() => {
  const settingsPath = join(process.cwd(), '.claude', 'settings.json')
  mkdirSync(join(process.cwd(), '.claude'), { recursive: true })
  const existing = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf-8')) : {}
  existing.hooks = existing.hooks ?? {}
  existing.hooks.Stop = [{ matcher: '', hooks: [{ type: 'command', command: 'npx agent-context-stop' }] }]
  existing.hooks.UserPromptSubmit = [{ matcher: '', hooks: [{ type: 'command', command: 'npx agent-context-prompt' }] }]
  writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
  console.log('Hooks installed in .claude/settings.json')
})

program.command('query <prompt>').description('Test retrieval — print context slice').action(async (prompt) => {
  const contextDir = join(process.cwd(), '.agent-context')
  const backend = loadBackend(contextDir)
  const filesHinted = prompt.match(/[\w/.-]+\.[a-z]{1,5}/g) ?? []
  const events = backend.query(prompt, filesHinted)
  const slice = buildContextSlice(events, 2000)
  console.log(formatContextSlice(slice) || '(no context found)')
})

program.command('status').description('Show event count and active backend').action(() => {
  const contextDir = join(process.cwd(), '.agent-context')
  const eventsPath = join(contextDir, 'events.jsonl')
  const configPath = join(contextDir, 'config.json')
  const count = existsSync(eventsPath)
    ? readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).length : 0
  const config = existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  console.log(`Backend: ${config.backend}\nEvents: ${count}`)
})

program.command('switch <backend>').description('Switch graph backend (file|session|decision)').action((backend) => {
  const contextDir = join(process.cwd(), '.agent-context')
  const configPath = join(contextDir, 'config.json')
  writeFileSync(configPath, JSON.stringify({ backend }, null, 2))
  console.log(`Switched to ${backend} backend. Run 'agent-context rebuild' to rebuild graph.`)
})

program.command('rebuild').description('Rebuild graph.json from events.jsonl').action(() => {
  const contextDir = join(process.cwd(), '.agent-context')
  const eventsPath = join(contextDir, 'events.jsonl')
  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )
  const events = readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const backend: GraphBackend = config.backend === 'session'
    ? new SessionGraphBackend()
    : config.backend === 'decision'
    ? new DecisionGraphBackend()
    : new FileGraphBackend()
  backend.ingest(events)
  writeFileSync(join(contextDir, 'graph.json'), JSON.stringify(backend.serialize(), null, 2))
  console.log(`Rebuilt graph.json with ${events.length} events using ${config.backend} backend.`)
})

program.parseAsync()
```

**Step 2: Add bin entries to `package.json`**

Update the `bin` field:
```json
"bin": {
  "agent-context": "./dist/cli.js",
  "agent-context-stop": "./dist/hooks/stop.js",
  "agent-context-prompt": "./dist/hooks/user-prompt.js"
}
```

**Step 3: Build and smoke test**

```bash
npm run build && node dist/cli.js --help
```
Expected: prints help with all commands listed

**Step 4: Commit**

```bash
git add agent-context/src/cli.ts agent-context/package.json
git commit -m "feat: add CLI commands (init, install, query, status, switch, rebuild)"
```

---

## Task 11: End-to-end smoke test

**Goal:** Run the full pipeline against a real (or synthetic) JSONL transcript.

**Step 1: Create a synthetic JSONL test fixture**

```bash
mkdir -p agent-context/tests/fixtures
```

Write `agent-context/tests/fixtures/sample-session.jsonl`:
```jsonl
{"type":"user","message":{"content":[{"type":"text","text":"implement the graph backend"}]},"uuid":"turn-1","sessionId":"sess_smoke","timestamp":"2026-02-25T10:00:00.000Z"}
{"type":"assistant","message":{"content":[{"type":"thinking","thinking":"I could use a flat list but I'll go with a tree structure because it groups naturally by file path. The tradeoff is more complex query logic but much better retrieval precision."},{"type":"text","text":"I'll implement the file-centric tree backend using a nested map structure."}]},"uuid":"turn-2","sessionId":"sess_smoke","timestamp":"2026-02-25T10:00:05.000Z"}
```

**Step 2: Run init and manual extract**

```bash
cd /tmp/smoke-test && mkdir -p test-project && cd test-project
node /path/to/agent-context/dist/cli.js init
node /path/to/agent-context/dist/cli.js status
```
Expected: `Backend: file\nEvents: 0`

**Step 3: Run extract manually and verify events.jsonl**

```bash
node -e "
const { extractFromLines } = require('./dist/extractor.js')
const { readFileSync, appendFileSync } = require('fs')
const lines = readFileSync('./tests/fixtures/sample-session.jsonl', 'utf-8').split('\n').filter(Boolean)
const events = extractFromLines(lines, 'sess_smoke')
console.log(JSON.stringify(events, null, 2))
"
```
Expected: one event with `raw_thinking` containing "flat list" and `model_output` containing "file-centric tree"

**Step 4: Run query and verify output**

```bash
node dist/cli.js query "graph backend implementation"
```
Expected: formatted context slice with the decision about tree structure

**Step 5: Commit**

```bash
git add agent-context/tests/
git commit -m "test: add smoke test fixtures for end-to-end pipeline"
```
