# agent-context Design Document

**Date:** 2026-02-25
**Status:** Approved

## Overview

`agent-context` is a Claude Code plugin that extracts thinking blocks, tool call sequences, and model outputs from Claude Code JSONL transcripts after each session, stores them in a structured context graph committed to the project repo, retrieves relevant past reasoning on demand, and injects it into new sessions via Claude Code hooks.

**Core hypothesis:** Feeding structured reasoning history (the "why") back into a coding agent improves performance on long multi-turn tasks with multiple rewrites — validated against a multi-pass SWE-bench setup.

## Problem

AI coding agents leave a code artifact trail (the "what") but no reasoning trail (the "why"). When an agent or human revisits a project, they have no record of:
- Alternatives considered and rejected
- Trade-offs made between approaches
- Constraints that shaped a design decision
- The chain of reasoning across multiple rewrites of the same functionality

Claude Code stores full session transcripts in JSONL files (at `~/.claude/projects/<hash>/`) including thinking blocks, tool calls, and model outputs — but nothing reads these back in to future sessions.

## Solution

A three-layer pipeline:

1. **Extractor** — reads JSONL transcripts after each session, produces normalized `ThinkingEvent` records
2. **Graph Store** — pluggable backend (file-centric tree, session DAG, or decision graph) stored as `.agent-context/` in the project repo and committed to git
3. **Retriever** — given a user prompt, traverses the graph and returns a ranked context slice using Haiku (heuristic keyword fallback when no API key)
4. **Injector** — Claude Code hooks wire everything together: `Stop` hook extracts and stores, `UserPromptSubmit` hook retrieves and injects

## Non-goals (v1)

- No UI or dashboard
- No cross-repo context sharing
- No real-time streaming interception (no proxy server)
- Not a general memory system — scoped to coding decisions only

## Success Criteria

- SWE-bench score improvement vs baseline (no injection) and vs flat `CLAUDE.md` append
- Context injection adds <2s latency per session start
- `.agent-context/` stays human-readable and git-diffable
- Works without an API key via heuristic fallback

---

## Architecture

### System Layers

```
┌─────────────────────────────────────────────────────────────┐
│  Claude Code Session                                         │
│                                                              │
│  UserPromptSubmit hook ──► Retriever ──► inject context     │
│                                  │                           │
│                                  ▼                           │
│                          Graph Store                         │
│                          .agent-context/                     │
│                                  ▲                           │
│  Stop hook ──────────► Extractor ┘                          │
│                                                              │
│  Stop hook ──────────► CLAUDE.md rebuilder                  │
└─────────────────────────────────────────────────────────────┘
```

### Data Flow

**End of session (Stop hook):**
1. Locate latest JSONL transcript for this project
2. Extractor parses new turns since last extraction → produces `ThinkingEvent[]`
3. Summarizer calls Haiku if `ANTHROPIC_API_KEY` present, otherwise heuristic pattern match
4. Append to `.agent-context/events.jsonl` (lossless, append-only)
5. Active graph backend ingests events → rewrites `.agent-context/graph.json`
6. CLAUDE.md rebuilder rewrites `## Agent Context` section grouped by file/component
7. `git add .agent-context/ CLAUDE.md && git commit -m "chore: update agent context"`

**Start of session (UserPromptSubmit hook, first turn only):**
1. Read user prompt from hook input
2. Retriever queries graph backend — Haiku traversal if API key present, heuristic keyword match as fallback
3. Returns ranked context slice capped at ~2000 tokens
4. Hook stdout → injected as additional context into Claude's turn
5. Set `AGENT_CONTEXT_INJECTED=1` via `CLAUDE_ENV_FILE` to skip subsequent turns

---

## Data Model

### ThinkingEvent

The core normalized record extracted from a JSONL transcript turn.

```typescript
type ThinkingEvent = {
  id: string                    // uuid
  session_id: string            // from JSONL metadata
  timestamp: string             // ISO datetime
  type: 'decision' | 'rejection' | 'tradeoff' | 'exploration' | 'raw'
  summary: string               // Haiku-generated or heuristic one-liner
  raw_thinking: string          // verbatim thinking block text
  model_output: string          // verbatim assistant text response for this turn
  tool_calls: ToolCallSummary[] // tools used in surrounding turns
  files_affected: string[]      // files touched in this session
  prompt_context: string        // user prompt that triggered this turn
}

type ToolCallSummary = {
  tool_name: string
  input_summary: string         // first 200 chars of input
  outcome: 'success' | 'error' | 'reverted'
}
```

### Storage Layout (in project repo)

```
.agent-context/
├── events.jsonl    # Lossless append-only log of all ThinkingEvents (source of truth)
├── graph.json      # Active graph backend state (rebuilt from events.jsonl on backend switch)
└── config.json     # { "backend": "file" | "session" | "decision" }
```

`events.jsonl` is always preserved independently. Switching graph backends rebuilds `graph.json` from scratch without data loss.

---

## Graph Backends

All three backends implement the same interface:

```typescript
interface GraphBackend {
  ingest(events: ThinkingEvent[]): void
  query(prompt: string, filesHinted: string[]): ThinkingEvent[]
  serialize(): object
  deserialize(data: object): void
}
```

The active backend is selected via `config.json` or `AGENT_CONTEXT_GRAPH=file|session|decision`.

### Backend: `file` (file-centric tree)

Structure: `root → files/components → sessions → decisions`

Best for: "Why is this file structured this way?"

Traversal: given a prompt + hinted files, walk down the tree for matching files, collect decision nodes, rank by recency and type.

### Backend: `session` (session DAG)

Structure: sessions as nodes, directed edges represent temporal "built on top of" order. Each session node contains its `ThinkingEvent[]`.

Best for: "What was the chain of reasoning that led to the current state?"

Traversal: topological walk from most recent session backward, filter events by relevance to prompt.

### Backend: `decision` (decision graph)

Structure: decisions as nodes, edges represent dependency or conflict relationships between decisions. Files and sessions are metadata on nodes.

Best for: "What constraints apply to this component?"

Traversal: expand from seed decisions matching prompt, follow dependency edges up to depth 2.

### Experimental variable

The graph backend is the primary experimental variable for SWE-bench evaluation. All three are run against the same eval setup to measure:
- SWE-bench pass rate (primary metric)
- Context relevance (manual spot-check)
- Token cost per session start
- Context rot rate (fraction of injected context that's stale/irrelevant)

---

## Summarizer

Two modes, selected at runtime:

**Haiku mode** (when `ANTHROPIC_API_KEY` present):
- One API call per session (not per turn) — summarize the batch of extracted events
- Prompt instructs Haiku to classify each thinking block by type and produce a one-line summary
- ~$0.001–0.005 per session at typical session lengths

**Heuristic mode** (fallback):
- Pattern matching on thinking block text (reuses patterns from `agent-reason` design)
- `decision`: "I'll go with X because...", "I could ... but instead..."
- `rejection`: "That won't work", "Let me revert", "That approach has a problem"
- `tradeoff`: "The tradeoff here is", "This is slower but", "For now I'll... but ideally..."
- `exploration`: "Let me check", "I wonder if", "Let me look at"
- Unmatched → `raw`
- Summary = first sentence of matched excerpt (truncated to 120 chars)

---

## Components & Directory Structure

```
agent-context/
├── src/
│   ├── cli.ts              # Entry point, commander setup
│   ├── extractor.ts        # JSONL parser → ThinkingEvent[]
│   ├── summarizer.ts       # Haiku summarization + heuristic fallback
│   ├── graph/
│   │   ├── interface.ts    # GraphBackend interface + shared types
│   │   ├── file.ts         # File-centric tree backend
│   │   ├── session.ts      # Session DAG backend
│   │   └── decision.ts     # Decision graph backend
│   ├── retriever.ts        # Prompt → ranked context slice (≤2000 tokens)
│   ├── injector.ts         # Formats context slice for hook stdout
│   ├── rebuilder.ts        # Rewrites CLAUDE.md ## Agent Context section
│   └── schema.ts           # Zod schemas for all types
├── hooks/
│   ├── stop.ts             # Stop hook: extract → store → rebuild CLAUDE.md → git commit
│   └── user-prompt.ts      # UserPromptSubmit hook: retrieve → inject (first turn only)
├── package.json
└── tsconfig.json
```

---

## CLI Commands

```
agent-context init                  # create .agent-context/, register in .gitignore exclusions
agent-context install               # write hooks into .claude/settings.json
agent-context extract [--session]   # manually run extractor on latest (or specific) JSONL
agent-context rebuild               # rebuild graph.json from events.jsonl
agent-context query "<prompt>"      # test retrieval, print context slice to stdout
agent-context switch <backend>      # switch graph backend, triggers rebuild
agent-context status                # show event count, last extraction, active backend
```

---

## Hook Configuration

Written to `.claude/settings.json` by `agent-context install`:

```json
{
  "hooks": {
    "Stop": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "npx agent-context extract && npx agent-context rebuild" }]
      }
    ],
    "UserPromptSubmit": [
      {
        "matcher": "",
        "hooks": [{ "type": "command", "command": "npx agent-context query \"$CLAUDE_USER_PROMPT\"" }]
      }
    ]
  }
}
```

---

## Tech Stack

| Component | Choice |
|---|---|
| Language | TypeScript (Node.js) |
| CLI framework | `commander` |
| Anthropic SDK | `@anthropic-ai/sdk` |
| Schema validation | `zod` |
| Git integration | `simple-git` |
| Model for summarization | `claude-haiku-4-5-20251001` |

---

## SWE-bench Evaluation Setup

Standard SWE-bench (one session per problem) cannot test this hypothesis — the context graph starts empty for every problem. The evaluation runs each problem in two passes:

**Pass 1:** Agent attempts the problem with no context injection. `Stop` hook builds the context graph from the session.

**Pass 2:** Agent re-attempts the same problem with the context graph from Pass 1 injected at session start.

**Metrics:**
- Pass rate: Pass 1 vs Pass 2 (primary)
- Pass rate: Pass 2 (file backend) vs Pass 2 (session backend) vs Pass 2 (decision backend)
- Pass rate: Pass 2 vs flat `CLAUDE.md` append baseline (Approach C)
- Token cost per session start
- Latency added by injection (<2s target)

---

## Implementation Order

1. `schema.ts` — Zod types, `ThinkingEvent`, `GraphBackend` interface
2. `extractor.ts` — JSONL parser, extract thinking blocks + model output + tool calls
3. `summarizer.ts` — heuristic mode first, Haiku mode second
4. `graph/file.ts` — file-centric tree (simplest backend, build first)
5. `retriever.ts` + `injector.ts` — query + format context slice
6. `hooks/stop.ts` + `hooks/user-prompt.ts` — wire into Claude Code lifecycle
7. `rebuilder.ts` — CLAUDE.md section writer
8. `cli.ts` — all commands
9. `graph/session.ts` + `graph/decision.ts` — remaining backends
10. SWE-bench harness — two-pass eval runner

Test and verify after each step before moving to the next.
