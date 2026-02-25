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
