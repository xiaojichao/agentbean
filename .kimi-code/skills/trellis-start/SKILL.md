---
name: trellis-start
description: "Loads AgentBean's shared Trellis context for a coding session without taking over the repository workflow. Use when beginning or resuming work and Trellis context may help."
---

# Start Session — AgentBean Override

`AGENTS.md` is the canonical engineering contract across Codex, Claude Code, Kimi Code, Cursor, and other Coding Agents. Trellis only supplies context, memory, and collaboration capabilities.

## Load current truth

Read `AGENTS.md` and `docs/agents/harness.md`, then inspect the current GitHub Issue / PR and git state.

## Load Trellis context only when useful

```bash
python3 ./.trellis/scripts/get_context.py
python3 ./.trellis/scripts/get_context.py --mode packages
```

If an active Execution Packet exists, read its relevant artifacts. If no active task exists, that is normal: **do not ask for Trellis task-creation consent**.

Create a Trellis task only for cross-session, cross-Coding-Agent, or genuinely multi-stage context persistence.

## Load relevant project guidance

Read the relevant CONTEXT / ADR first, then only the `.trellis/spec/` indexes and concrete guideline files that apply to the code being changed.

## Continue under AgentBean routing

- clear bounded request → direct execution;
- unclear requirement → normal AgentBean clarification / Matt skills when appropriate;
- hard bug → Matt `diagnosing-bugs`;
- cross-Agent handoff → existing Execution Packet + `trellis mem` if needed.

Do not default-route to `trellis-brainstorm`, `trellis-implement`, `trellis-check`, `trellis-break-loop`, or `trellis-finish-work`.
