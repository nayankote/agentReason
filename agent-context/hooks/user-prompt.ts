#!/usr/bin/env node
import { readFileSync, existsSync, appendFileSync } from 'fs'
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
  const { prompt } = input as { prompt: string }

  const contextDir = join(process.cwd(), '.agent-context')
  const graphPath = join(contextDir, 'graph.json')
  if (!existsSync(graphPath)) process.exit(0)

  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )

  const backend: GraphBackend =
    config.backend === 'session' ? new SessionGraphBackend() :
    config.backend === 'decision' ? new DecisionGraphBackend() :
    new FileGraphBackend()

  backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))

  // Hint files from prompt (look for path-like tokens)
  const filesHinted: string[] = prompt.match(/[\w/.-]+\.[a-z]{1,5}/g) ?? []
  const events = backend.query(prompt, filesHinted)
  const slice = buildContextSlice(events, 2000)
  const formatted = formatContextSlice(slice)

  if (formatted) {
    // Mark as injected for this session
    const envFile = process.env.CLAUDE_ENV_FILE
    if (envFile && existsSync(envFile)) {
      appendFileSync(envFile, 'AGENT_CONTEXT_INJECTED=1\n')
    }
    process.stdout.write(formatted)
  }

  process.exit(0)
}

try { main() } catch { process.exit(0) }
