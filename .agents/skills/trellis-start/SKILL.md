---
name: trellis-start
description: "Loads AgentBean's shared Trellis context for a coding session without taking over the repository workflow. Use when beginning or resuming work and Trellis context may help."
---

# Start Session — AgentBean Override

`AGENTS.md` is the canonical engineering contract. Trellis is a context / memory / collaboration harness only. This skill must not introduce a second planning or approval pipeline.

## 1. Load canonical project rules

Read:

```text
AGENTS.md
docs/agents/harness.md
```

Then inspect the current GitHub Issue / PR and git state relevant to the user's request.

## 2. Load Trellis context only if useful

```bash
python3 ./.trellis/scripts/get_context.py
python3 ./.trellis/scripts/get_context.py --mode packages
```

If an active Execution Packet exists, read only the task artifacts needed for handoff. If no active task exists, that is normal: **do not ask the user for Trellis task-creation consent**.

Create a Trellis task only when cross-session, cross-Coding-Agent, or genuinely multi-stage context persistence is useful.

## 3. Load project coding guidance

For code you are about to touch, read the relevant domain / ADR truth first, then the relevant Trellis spec indexes and concrete guidelines:

```bash
cat .trellis/spec/guides/index.md
cat .trellis/spec/<package>/<layer>/index.md
```

Do not preload unrelated specs.

## 4. Resume under AgentBean routing

- clear bounded request → execute directly;
- underspecified GitHub Issue → normal `triage` path;
- unresolved product/domain decisions → Matt `grill-with-docs` / `domain-modeling` when appropriate;
- hard/flaky/performance bug → Matt `diagnosing-bugs`;
- cross-session / cross-Agent task → use the existing Trellis Execution Packet and `trellis mem` when history is needed.

Do not default-route to `trellis-brainstorm`, `trellis-implement`, `trellis-check`, `trellis-break-loop`, or `trellis-finish-work` merely because Trellis is installed.

The current `.trellis/workflow.md` is a context lifecycle reference, not a repository development authority.
