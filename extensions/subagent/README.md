# Subagent extension

The master Pi process exposes one `subagent` tool. Use it only when the user explicitly requests delegation or parallel work. Assign non-overlapping scopes and track the results. Child processes run in RPC mode with a minimal extension allowlist; they cannot spawn children unless their definition allows it.

## Agent definitions and trust

Agent definitions are Markdown files in `~/.pi/agent/agents/` and, when the current project is trusted, the current project's `.pi/agents/`. Definitions are discovered again for every `spawn`, using the tool context working directory. Project definitions override global definitions with the same name. In an untrusted project, project definitions are not read or used. Project-controlled names, descriptions, and prompts are never included in the tool description.

The optional `subagent_agents` field enables delegation from a child and restricts the listed names:

```markdown
---
name: scout
description: Fast codebase reconnaissance
tools: read, grep, find, ls
model: openai-codex/gpt-5.6-luna
thinking: low
subagent_agents: scout, researcher
---

Agent instructions go here.
```

The tool actions are:

- `spawn` — starts a child and returns an id such as `scout-1`.
- `wait` — waits for one child. A pending user message releases the wait without cancelling the child; completion is then reported automatically.
- `steer` — sends a message to a running child.

At most **8 active children** can run at once. Completed children remain available for snapshots. Only one wait may be active for a child; duplicate waits are rejected. Failed children return their failure snapshot and an explicit `SUBAGENT_FAILED` marker. The marker is intentional: tool-return `isError` metadata does not make a Pi tool call fail.

Uncollected children automatically notify the master when they complete or fail, with the exact id and result summary. A result already reported automatically remains available as a snapshot, but is not returned twice. Session shutdown terminates active children, removes listeners, and prevents reattachment follow-ups.

The `pi-web-access` package is loaded for definitions that request `web_search`, `fetch_content`, `source_check`, or `get_search_content`. The child subagent tool is available only when the definition includes `subagent_agents`.

Tool results include an expandable observability view with status, duration, tool count, recent tool calls, latest progress text, and final Markdown output. Model-visible output is capped at Pi's 50 KB/2,000-line limits; the complete output is saved to a secure temporary file when truncation occurs. While children are active, a widget below the editor shows each active agent and its two most recent tool calls.
