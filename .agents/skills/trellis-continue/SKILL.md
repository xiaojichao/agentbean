---
name: trellis-continue
description: "Resume AgentBean work from shared project truth plus optional Trellis Execution Packet context. Use when continuing across sessions or Coding Agents."
---

# Continue Current Work — AgentBean Override

Do not resume by blindly following a Trellis phase state. `AGENTS.md` owns the repository workflow; Trellis only helps restore context.

## 1. Re-establish current truth

Read, in order:

1. `AGENTS.md` and `docs/agents/harness.md`
2. current GitHub Issue / PR / comments
3. branch, worktree, `git status`, recent commits
4. relevant CONTEXT / ADR
5. relevant `.trellis/spec/`

## 2. Load optional Execution Packet

```bash
python3 ./.trellis/scripts/get_context.py
```

If an active Trellis task exists, read its relevant `prd.md`, `design.md`, `implement.md`, research, or notes only as handoff context. If history is still missing, use `trellis mem` / `trellis-session-insight`.

Trellis `status` describes the packet, not permission to code:

- `planning` → packet context is still being assembled; if the user's implementation request is already clear, no extra approval is required;
- `in_progress` → continue the next bounded slice under `AGENTS.md`;
- no active task → normal state; continue directly if the request is clear.

## 3. Reuse valid evidence

Do not rerun tests or Review solely because a new Coding Agent took over. Reuse evidence that still applies to the current source state; rerun only checks affected by subsequent changes or a new concrete remote failure.

## 4. Continue with AgentBean routing

Use Matt / Addy / Trellis capabilities only when their trigger conditions actually match. Do not default to `trellis-brainstorm`, automatic implement/check sub-agents, mandatory spec update, or `trellis-finish-work`.
