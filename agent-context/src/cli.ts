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
import { buildClaudeMdSection, injectIntoClaudeMd } from './rebuilder.js'
import { GraphConfigSchema } from './schema.js'
import type { GraphBackend } from './graph/interface.js'

const program = new Command()

program
  .name('agent-context')
  .description('Claude Code context graph plugin')
  .version('0.1.0')

function loadBackend(contextDir: string): { backend: GraphBackend; config: ReturnType<typeof GraphConfigSchema.parse> } {
  const configPath = join(contextDir, 'config.json')
  const config = GraphConfigSchema.parse(
    existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
  )
  const graphPath = join(contextDir, 'graph.json')
  const backend: GraphBackend =
    config.backend === 'session' ? new SessionGraphBackend() :
    config.backend === 'decision' ? new DecisionGraphBackend() :
    new FileGraphBackend()
  if (existsSync(graphPath)) {
    backend.deserialize(JSON.parse(readFileSync(graphPath, 'utf-8')))
  }
  return { backend, config }
}

program
  .command('init')
  .description('Initialize .agent-context/ in current project')
  .action(() => {
    const contextDir = join(process.cwd(), '.agent-context')
    mkdirSync(contextDir, { recursive: true })
    writeFileSync(join(contextDir, 'config.json'), JSON.stringify({ backend: 'file' }, null, 2))
    writeFileSync(join(contextDir, 'events.jsonl'), '')
    console.log('Initialized .agent-context/')
  })

program
  .command('install')
  .description('Register hooks in .claude/settings.json')
  .action(() => {
    const claudeDir = join(process.cwd(), '.claude')
    const settingsPath = join(claudeDir, 'settings.json')
    mkdirSync(claudeDir, { recursive: true })
    const existing = existsSync(settingsPath)
      ? JSON.parse(readFileSync(settingsPath, 'utf-8'))
      : {}
    existing.hooks = existing.hooks ?? {}
    existing.hooks.Stop = [{
      matcher: '',
      hooks: [{ type: 'command', command: 'npx agent-context-stop' }]
    }]
    existing.hooks.UserPromptSubmit = [{
      matcher: '',
      hooks: [{ type: 'command', command: 'npx agent-context-prompt' }]
    }]
    writeFileSync(settingsPath, JSON.stringify(existing, null, 2))
    console.log('Hooks installed in .claude/settings.json')
  })

program
  .command('query <prompt>')
  .description('Test retrieval — print context slice to stdout')
  .action(async (prompt: string) => {
    const contextDir = join(process.cwd(), '.agent-context')
    if (!existsSync(contextDir)) {
      console.error('Not initialized. Run: agent-context init')
      process.exit(1)
    }
    const { backend } = loadBackend(contextDir)
    const filesHinted: string[] = prompt.match(/[\w/.-]+\.[a-z]{1,5}/g) ?? []
    const events = backend.query(prompt, filesHinted)
    const slice = buildContextSlice(events, 2000)
    const output = formatContextSlice(slice)
    console.log(output || '(no context found)')
  })

program
  .command('status')
  .description('Show event count, last extraction, active backend')
  .action(() => {
    const contextDir = join(process.cwd(), '.agent-context')
    if (!existsSync(contextDir)) {
      console.log('Not initialized.')
      return
    }
    const eventsPath = join(contextDir, 'events.jsonl')
    const configPath = join(contextDir, 'config.json')
    const count = existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).length
      : 0
    const config = existsSync(configPath)
      ? JSON.parse(readFileSync(configPath, 'utf-8'))
      : { backend: 'file' }
    console.log(`Backend:  ${config.backend}`)
    console.log(`Events:   ${count}`)
  })

program
  .command('switch <backend>')
  .description('Switch graph backend (file|session|decision)')
  .action((backend: string) => {
    const contextDir = join(process.cwd(), '.agent-context')
    if (!existsSync(contextDir)) {
      console.error('Not initialized. Run: agent-context init')
      process.exit(1)
    }
    const validBackends = ['file', 'session', 'decision']
    if (!validBackends.includes(backend)) {
      console.error(`Invalid backend: ${backend}. Choose from: ${validBackends.join(', ')}`)
      process.exit(1)
    }
    const configPath = join(contextDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ backend }, null, 2))
    console.log(`Switched to ${backend} backend. Run 'agent-context rebuild' to rebuild graph.`)
  })

program
  .command('rebuild')
  .description('Rebuild graph.json from events.jsonl')
  .action(() => {
    const contextDir = join(process.cwd(), '.agent-context')
    if (!existsSync(contextDir)) {
      console.error('Not initialized. Run: agent-context init')
      process.exit(1)
    }
    const configPath = join(contextDir, 'config.json')
    const config = GraphConfigSchema.parse(
      existsSync(configPath) ? JSON.parse(readFileSync(configPath, 'utf-8')) : { backend: 'file' }
    )
    const eventsPath = join(contextDir, 'events.jsonl')
    const events = existsSync(eventsPath)
      ? readFileSync(eventsPath, 'utf-8').split('\n').filter(Boolean).map((l: string) => JSON.parse(l))
      : []
    const backend: GraphBackend =
      config.backend === 'session' ? new SessionGraphBackend() :
      config.backend === 'decision' ? new DecisionGraphBackend() :
      new FileGraphBackend()
    backend.ingest(events)
    const graphPath = join(contextDir, 'graph.json')
    writeFileSync(graphPath, JSON.stringify(backend.serialize(), null, 2))
    console.log(`Rebuilt graph.json with ${events.length} events using ${config.backend} backend.`)
  })

program.parseAsync()
