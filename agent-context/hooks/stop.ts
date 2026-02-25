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
import { simpleGit } from 'simple-git'
import type { GraphBackend } from '../src/graph/interface.js'

async function main() {
  // Read stdin
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) chunks.push(chunk)
  const input = JSON.parse(Buffer.concat(chunks).toString('utf-8'))
  const { transcript_path, session_id } = input as { transcript_path: string; session_id: string }

  const contextDir = join(process.cwd(), '.agent-context')
  if (!existsSync(contextDir)) process.exit(0)

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
  const backend: GraphBackend =
    config.backend === 'session' ? new SessionGraphBackend() :
    config.backend === 'decision' ? new DecisionGraphBackend() :
    new FileGraphBackend()

  if (existsSync(graphPath)) {
    backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))
  }
  backend.ingest(events)
  writeFileSync(graphPath, JSON.stringify(backend.serialize(), null, 2))

  // Rebuild CLAUDE.md
  const allEvents = readFileSync(eventsPath, 'utf-8')
    .split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
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

main().catch(() => process.exit(0))
