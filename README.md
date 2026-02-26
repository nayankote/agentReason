# agentReason

A research project testing the hypothesis that **storing and feeding an AI coding agent's reasoning history back into future sessions improves performance on long multi-turn tasks** — particularly when the same functionality is revisited or rewritten.

## Hypothesis

AI coding agents (Claude Code, etc.) leave a code artifact trail — the *what* — but no reasoning trail — the *why*. When an agent or human revisits a project, there is no record of:

- Alternatives considered and rejected
- Trade-offs made between approaches
- Constraints that shaped a design decision
- The chain of reasoning across multiple rewrites

This project tests whether capturing that reasoning and injecting it as structured context improves agent performance, validated against a multi-pass SWE-bench setup.

## What's in this repo

### `agent-context/` — The plugin

A Claude Code plugin that:

1. **Extracts** thinking blocks and model outputs from Claude Code JSONL transcripts after each session
2. **Summarizes** them via Claude Haiku (or heuristic patterns as fallback)
3. **Stores** them in a pluggable context graph committed to the project repo under `.agent-context/`
4. **Retrieves** relevant past reasoning on demand using graph traversal + Haiku ranking
5. **Injects** that context into new sessions via Claude Code hooks

### `docs/plans/` — Design documents

- `2026-02-25-agent-context-design.md` — Full architecture and design decisions
- `2026-02-25-agent-context-implementation.md` — Step-by-step implementation plan

## How it works

```
┌─────────────────────────────────────────────────────┐
│  Claude Code Session                                 │
│                                                      │
│  UserPromptSubmit hook ──► Retriever ──► inject      │
│                                  │                   │
│                                  ▼                   │
│                          Graph Store                 │
│                          .agent-context/             │
│                                  ▲                   │
│  Stop hook ──────────► Extractor ┘                  │
│                                                      │
│  Stop hook ──────────► CLAUDE.md rebuilder          │
└─────────────────────────────────────────────────────┘
```

**End of session (Stop hook):**
- Parses the JSONL transcript for thinking blocks and model outputs
- Summarizes each event (Haiku batch call, heuristic fallback if no API key)
- Appends to `.agent-context/events.jsonl` (lossless, append-only)
- Updates `.agent-context/graph.json` via the active graph backend
- Rewrites the `## Agent Context` section of `CLAUDE.md` grouped by file
- Auto-commits `.agent-context/` and `CLAUDE.md` to git

**Start of session (UserPromptSubmit hook, first turn only):**
- Queries the graph for events relevant to the user's prompt
- Injects a ≤2000-token context slice as additional context

## Three graph backends (experimental variable)

The graph structure is the primary experimental variable for SWE-bench evaluation:

| Backend | Structure | Best for |
|---|---|---|
| `file` | Tree: file → sessions → decisions | "Why is this file structured this way?" |
| `session` | DAG: sessions in temporal order | "What was the chain of reasoning?" |
| `decision` | Graph: only decision/rejection/tradeoff events | "What constraints apply here?" |

Switch backends with `agent-context switch <file|session|decision>`.

## Quick start

```bash
cd agent-context
npm install
npm run build

# In your project:
node /path/to/agent-context/dist/src/cli.js init
node /path/to/agent-context/dist/src/cli.js install
```

Then use Claude Code normally. After each session, the Stop hook automatically extracts reasoning and updates the graph. On the next session start, relevant past reasoning is injected.

### CLI commands

```
agent-context init                  # create .agent-context/ in current project
agent-context install               # register hooks in .claude/settings.json
agent-context query "<prompt>"      # test what context would be injected
agent-context status                # show event count and active backend
agent-context switch <backend>      # switch graph backend (rebuilds graph.json)
agent-context rebuild               # rebuild graph.json from events.jsonl
```

## Eval plan

Standard SWE-bench cannot test this hypothesis (each problem is a fresh repo with no prior sessions). The evaluation runs each problem in two passes:

- **Pass 1:** Agent attempts the problem. Stop hook builds the context graph.
- **Pass 2:** Agent re-attempts with the context graph from Pass 1 injected at session start.

**Metrics:** pass rate (Pass 1 vs Pass 2), pass rate across three graph backends, token cost per session start, context rot rate.

## Tech stack

- TypeScript (Node.js)
- `@anthropic-ai/sdk` — Haiku summarization
- `zod` — schema validation
- `simple-git` — auto-commit after each session
- `commander` — CLI

## Status

- [x] JSONL extractor (thinking blocks + model output)
- [x] Heuristic summarizer + Haiku batch summarizer
- [x] Three graph backends (file tree, session DAG, decision graph)
- [x] Token-budgeted retriever + markdown injector
- [x] CLAUDE.md rebuilder
- [x] Claude Code hooks (Stop + UserPromptSubmit)
- [x] CLI
- [x] End-to-end smoke test on real Claude Code session
- [ ] SWE-bench two-pass eval harness
- [ ] Haiku-ranked retrieval (currently keyword + graph traversal)
- [ ] File attribution from git diff (currently `files_affected: []`)
