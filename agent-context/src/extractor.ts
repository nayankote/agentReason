import fs from 'fs'
import path from 'path'
import type { ThinkingEvent, ToolCallSummary } from './schema.js'

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  name?: string
  input?: Record<string, unknown>
}

interface JournalLine {
  type: string
  message?: {
    content?: ContentBlock[]
  }
  uuid?: string
  sessionId?: string
  timestamp?: string
  name?: string
  input?: Record<string, unknown>
}

/**
 * Parse each line of a JSONL transcript. For each assistant turn that contains
 * a thinking block, produce one ThinkingEvent. Malformed lines are silently
 * skipped. The last user prompt seen before an assistant turn becomes its
 * `prompt_context`.
 */
export function extractFromLines(lines: string[], sessionId: string): ThinkingEvent[] {
  const events: ThinkingEvent[] = []
  let lastUserPrompt = ''

  for (const line of lines) {
    if (!line.trim()) continue

    let record: JournalLine
    try {
      record = JSON.parse(line) as JournalLine
    } catch {
      // malformed JSON — skip gracefully
      continue
    }

    if (record.type === 'user') {
      // Capture the last user prompt text for prompt_context
      const content = record.message?.content ?? []
      const textBlock = content.find((b) => b.type === 'text')
      if (textBlock?.text) {
        lastUserPrompt = textBlock.text
      }
      continue
    }

    if (record.type === 'assistant') {
      const content = record.message?.content ?? []

      // Find thinking block
      const thinkingBlock = content.find((b) => b.type === 'thinking')
      if (!thinkingBlock) continue // no thinking — skip

      // Find text (response) block
      const textBlock = content.find((b) => b.type === 'text')

      // Collect any tool_use blocks as ToolCallSummary entries
      const toolCalls: ToolCallSummary[] = content
        .filter((b) => b.type === 'tool_use')
        .map((b) => ({
          tool_name: b.name ?? '',
          input_summary: b.input ? JSON.stringify(b.input).slice(0, 200) : '',
          outcome: 'success' as const
        }))

      // Validate / normalise timestamp
      let timestamp = record.timestamp ?? ''
      if (!timestamp || isNaN(Date.parse(timestamp))) {
        timestamp = new Date().toISOString()
      }

      const event: ThinkingEvent = {
        id: crypto.randomUUID(),
        session_id: sessionId,
        timestamp,
        type: 'raw',
        summary: '',
        raw_thinking: thinkingBlock.thinking ?? '',
        response_text: textBlock?.text ?? '',
        tool_calls: toolCalls,
        files_affected: [],
        prompt_context: lastUserPrompt
      }

      events.push(event)
      continue
    }
  }

  return events
}

/**
 * Return the path to the most recently modified .jsonl file inside
 * `projectDir`, or null if none exist.
 */
export function findLatestJSONL(projectDir: string): string | null {
  let entries: fs.Dirent[]
  try {
    entries = fs.readdirSync(projectDir, { withFileTypes: true })
  } catch {
    return null
  }

  const jsonlFiles = entries
    .filter((e) => e.isFile() && e.name.endsWith('.jsonl'))
    .map((e) => {
      const fullPath = path.join(projectDir, e.name)
      const stat = fs.statSync(fullPath)
      return { fullPath, mtime: stat.mtimeMs }
    })

  if (jsonlFiles.length === 0) return null

  jsonlFiles.sort((a, b) => b.mtime - a.mtime)
  return jsonlFiles[0].fullPath
}
