---
name: trellis-continue
description: "Resume AgentBean work from shared project truth plus optional Trellis Execution Packet context. Use when continuing across sessions or Coding Agents."
---

# Continue Current Work — AgentBean Override

`AGENTS.md` owns the workflow. Trellis restores context; it does not decide the next mandatory phase.

1. Read `AGENTS.md` + `docs/agents/harness.md`.
2. Read the current GitHub Issue / PR / comments and current git state.
3. Read relevant CONTEXT / ADR / `.trellis/spec/`.
4. Run `python3 ./.trellis/scripts/get_context.py` and, if an Execution Packet exists, use its relevant artifacts as handoff context.
5. Use `trellis mem` only when needed to recover conversation context that is not already captured in authoritative sources.
6. Reuse tests / Review evidence that still matches the current source state; do not rerun everything merely because Kimi took over from another Coding Agent.

A Trellis `planning` status is not a second approval gate, `in_progress` does not imply automatic implement/check workers, and no active Trellis task is a normal state.
