# agent-reason Design Document

**Date:** 2026-02-21
**Status:** Approved

## Overview

`agent-reason` is a CLI tool that captures an AI agent's reasoning during a coding session and links it to git commits. It preserves *why* decisions were made, not just *what* changed.

## Problem

AI coding agents (Claude Code, etc.) leave no record of their reasoning. When you look at a commit, you see what changed — not the alternatives considered, approaches rejected, or tradeoffs made. This makes it hard to:
- Understand why code is structured a certain way
- Audit AI-generated decisions after the fact
- Replay or evaluate agent sessions

## Solution

Wrap the Anthropic API, intercept thinking blocks and tool call sequences, serialize them into structured trace files, and link those traces to git commits via post-commit hooks.

## Tech Stack

| Component | Choice |
|-----------|--------|
| Language | TypeScript (Node.js) |
| CLI framework | `commander` |
| Anthropic SDK | `@anthropic-ai/sdk` |
| Git integration | `simple-git` |
| Storage | Local `.agent-traces/` in repo root |
| Schema validation | `zod` |

## Directory Structure

```
agent-reason/
├── src/
│   ├── cli.ts          # Entry point, commander setup
│   ├── proxy.ts        # API proxy/interceptor (Mode 2)
│   ├── capture.ts      # Session capture logic
│   ├── schema.ts       # Zod schemas for trace format
│   ├── git.ts          # Git integration helpers
│   ├── hooks.ts        # Git hook installer
│   └── retrieval.ts    # blame + query commands
├── package.json
├── tsconfig.json
└── README.md
```

## Data Model

### DecisionPoint

Represents a single reasoning moment extracted from a thinking block.

```
type: approach_selection | rejection | tradeoff | constraint | unknown
summary: one-line human-readable description
alternatives_considered: string[]
chosen: string
rationale: string
files_affected: string[]
raw_content: verbatim thinking block excerpt
```

### AgentTrace

The top-level trace file for a session.

```
version: '0.1'
session_id: uuid
tool: { name, model }
started_at / ended_at: ISO datetimes
commit_sha: filled in post-commit
branch: current git branch
files_affected: from git diff at session end
decision_points: DecisionPoint[]
tool_call_sequence: [{ timestamp, tool_name, input_summary, outcome, revert_reason }]
session_prompt: the initial user task
```

Storage: `.agent-traces/<session_id>.json` in the repo root, **committed to git**.

## Core Modules

### capture.ts — Session lifecycle

- `startSession(prompt)` — generates session_id, records start state, writes initial trace file
- `recordToolCall(ctx, ...)` — appends to tool_call_sequence
- `recordDecisionPoint(ctx, ...)` — appends to decision_points
- `endSession(ctx)` — records ended_at, detects changed files via `git diff --name-only`, writes final trace

### Decision Point Extraction

Heuristic pattern matching on thinking block text — no LLM call (v1):

| Pattern type | Signals |
|---|---|
| approach_selection | "I could ... but instead I'll ...", "I'll go with X because ..." |
| rejection | "Actually, that won't work", "Let me revert ...", "That approach has a problem" |
| tradeoff | "The tradeoff here is ...", "This is slower but ...", "For now I'll ... but ideally ..." |

Each match extracts ~200 chars of surrounding context as `raw_content` and the first sentence as `summary`.

### hooks.ts — Git hook installer

**post-commit:**
- Reads `AGENT_REASON_SESSION_ID` from env
- If set: fills in `commit_sha`, appends trace reference to git notes
- Exits 0 silently if env var not set

**prepare-commit-msg:**
- If `AGENT_REASON_SESSION_ID` is set, appends `Agent-Reason-Session: <session_id>` to commit message
- Makes session findable from `git log` without tooling

### retrieval.ts — Query commands

- `blame(file, line)` — runs `git blame`, finds matching trace, prints decision_points
- `listSessions(limit)` — reads all traces, sorts by date, prints table
- `showSession(idOrSha)` — finds trace by session_id prefix or commit SHA, pretty-prints

### proxy.ts — API interceptor (Mode 2, Phase 2)

Thin Express server that forwards to `api.anthropic.com`, intercepting the stream. Agent sets `ANTHROPIC_BASE_URL` to point here. Auto-manages session lifecycle per conversation thread.

## CLI Commands

```
agent-reason init                   # create .agent-traces/ dir, stage for git tracking
agent-reason install                # install git hooks in current repo
agent-reason start [--prompt "..."] # start a session, prints SESSION_ID
agent-reason end <session_id>       # end session, detect file changes
agent-reason blame <file> <line>    # show reasoning for a line
agent-reason log [--limit 20]       # list all sessions
agent-reason show <session-id|sha>  # show full trace
```

## Integration Modes

**Mode 1 (build first):** Manual session wrapper
```bash
export AGENT_REASON_SESSION_ID=$(agent-reason start --prompt "add rate limiting")
# run Claude Code
agent-reason end $AGENT_REASON_SESSION_ID
git commit -m "add rate limiting"
# post-commit hook links the trace automatically
```

**Mode 2 (Phase 2):** API proxy — agent points `ANTHROPIC_BASE_URL` at local Express server.

## Key Constraints

- `.agent-traces/` is **committed to the repo** (shared with the team)
- Trace files store only thinking blocks and tool call summaries — not full API responses
- Git hooks must be no-ops (exit 0) when `AGENT_REASON_SESSION_ID` is not set
- No network calls except Anthropic API in Mode 2

## Implementation Order

1. `schema.ts` — types and validation
2. `capture.ts` — session lifecycle + decision extraction
3. `cli.ts` — `start`, `end`, `show`, `log` commands (no git yet)
4. `git.ts` + `hooks.ts` — post-commit linking
5. `retrieval.ts` — `blame` command
6. `proxy.ts` — API interception (Mode 2)

Test and verify after each step before moving to the next.
