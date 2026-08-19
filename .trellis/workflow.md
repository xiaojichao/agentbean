# AgentBean Trellis Context Workflow

> `AGENTS.md` is the canonical engineering contract. This file only defines
> how Trellis contributes context, memory, execution packets, and collaboration
> across Coding Agents. It must not create a second development pipeline.

---

## Core Principles

1. **AGENTS.md owns workflow** — Trellis never overrides repository intake, worktree, verification, Review, PR, merge, or production rules.
2. **Context, not control** — Trellis tells an Agent where the work is and what project knowledge applies; it does not decide what the Agent must do next.
3. **GitHub Issues are authoritative** — `.trellis/tasks/` is an Execution Packet cache, never the issue tracker or product truth source.
4. **Use Trellis only when it earns its cost** — create a task for cross-session, cross-Coding-Agent, or genuinely multi-stage work; ordinary bounded tasks run directly.
5. **No duplicate gates** — Trellis task creation, planning artifacts, checks, spec updates, journals, and archives are not extra approval or completion gates.
6. **No bookkeeping commits by default** — `.trellis/config.yaml` disables session auto-commit; product Git history stays focused on product changes.
7. **Cross-agent continuity** — Codex, Claude Code, Cursor, Kimi Code, and other supported agents resume from the same GitHub / git / domain / spec truth.

See `docs/agents/harness.md` for the complete role matrix and routing policy.

---

## Trellis System

### Developer Identity

Initialize a Trellis developer identity only when using workspace journals or
other developer-scoped Trellis features:

```bash
python3 ./.trellis/scripts/init_developer.py <your-name>
```

This is not required for ordinary AgentBean coding work.

### Spec System

`.trellis/spec/` holds project-specific implementation guidance by package and
layer. It answers **how AgentBean code should be implemented safely**, not what
the product should do or why the architecture exists.

```bash
python3 ./.trellis/scripts/get_context.py --mode packages
cat .trellis/spec/guides/index.md
cat .trellis/spec/<package>/<layer>/index.md
```

Source-of-truth boundaries:

- product requirements / acceptance → GitHub Issue / PRD
- domain language / context boundary → `CONTEXT.md`
- architecture rationale → ADR
- concrete implementation conventions → `.trellis/spec/`

Update `.trellis/spec/` only when a task produces durable, reusable coding
knowledge. Do not force a spec update after every task or bug fix.

### Task System: Execution Packets

A Trellis task is an optional **Execution Packet** for work that needs durable
handoff across sessions or Coding Agents.

Create one only when at least one is true:

- the work is expected to continue across multiple sessions;
- Codex / Claude Code / another Coding Agent may hand the work to each other;
- the work has substantial research/design/execution material that is useful as
  temporary task-local context.

Do **not** create a Trellis task for ordinary small UI changes, simple bugs,
single-file refactors, or other clear bounded work.

```bash
# Optional task lifecycle
python3 ./.trellis/scripts/task.py create "<title>" [--slug <name>] [--parent <dir>]
python3 ./.trellis/scripts/task.py start <name>
python3 ./.trellis/scripts/task.py current --source
python3 ./.trellis/scripts/task.py finish
python3 ./.trellis/scripts/task.py archive <name>
python3 ./.trellis/scripts/task.py list [--mine] [--status <s>]

# Optional context manifests for deliberately dispatched Trellis workers
python3 ./.trellis/scripts/task.py add-context <name> <action> <file> <reason>
python3 ./.trellis/scripts/task.py list-context <name> [action]

# Metadata
python3 ./.trellis/scripts/task.py set-branch <name> <branch>
python3 ./.trellis/scripts/task.py set-base-branch <name> <branch>
python3 ./.trellis/scripts/task.py set-scope <name> <scope>
```

When possible, record the owning GitHub Issue plus branch / worktree / PR URL in
the task metadata or notes. GitHub remains authoritative if the two disagree.

`task.py start` marks an existing Execution Packet as being actively executed.
It is **not** a user approval gate. If the user already gave a clear
implementation instruction and the repository evidence resolves the task, do
not ask for an extra Trellis approval round.

### Cross-Session Memory

Use `trellis mem` / `trellis-session-insight` when context has actually fallen
out of reach, especially across Codex ↔ Claude Code handoff.

Prefer current truth first:

1. GitHub Issue / PR / comments
2. branch, worktree, git status, commits
3. relevant CONTEXT / ADR
4. relevant `.trellis/spec/`
5. current Execution Packet
6. raw historical conversations via `trellis mem`

Historical chat is evidence, not authority.

### Multi-Agent Collaboration

Use `trellis channel` when durable cross-agent discussion, an independent
reviewer, or a long-running peer worker is genuinely useful. Do not replace
normal direct tool calls or ordinary single-agent implementation with channel
ceremony.

### Workspace Journals

Workspace journals are optional memory aids. They are not required completion
artifacts and are not automatically committed in AgentBean.

```bash
python3 ./.trellis/scripts/add_session.py \
  --title "<title>" \
  --commit "<hashes>" \
  --summary "<summary>"
```

---

<!--
  WORKFLOW-STATE BREADCRUMB CONTRACT

  Platform hooks parse the blocks below and inject them on supported Coding
  Agents. For AgentBean these blocks are deliberately context-only. They must
  never impose a mandatory Plan -> Implement -> Check -> Finish pipeline.

  Keep the status tags because Trellis runtime scripts use them:
    no_task
    planning
    planning-inline
    in_progress
    in_progress-inline
    completed
-->

## Phase Index

```text
No Trellis task  → follow AGENTS.md directly; do not ask for Trellis consent
Planning packet  → optionally collect durable handoff context
In progress      → implement under AGENTS.md; Trellis only supplies context
Finish           → close the product loop under AGENTS.md; archive packet if useful
```

### Request Triage

Triage is owned by `AGENTS.md`, not Trellis.

- Clear bounded task → direct execution, no Trellis task required.
- Underspecified GitHub Issue → use the repository's normal `triage` path.
- Product/domain decision still unclear → use the normal project clarification
  path such as Matt `grill-with-docs` / `domain-modeling` when appropriate.
- Cross-session / cross-Agent / large multi-stage work → optionally create a
  Trellis Execution Packet without introducing a second approval gate.

### Planning Artifacts

For an Execution Packet:

- `prd.md` may cache the current requirement snapshot or link back to GitHub;
- `design.md` may hold task-local technical design;
- `implement.md` may hold task-local execution notes;
- `research/` may hold task-local research;
- `implement.jsonl` / `check.jsonl` are only needed when deliberately
  dispatching Trellis workers that need curated context injection.

These files are convenience artifacts, not universal prerequisites for coding.
Do not duplicate a complete GitHub PRD into Trellis unless durable handoff needs
that snapshot.

[workflow-state:no_task]
No active Trellis Execution Packet. Follow `AGENTS.md` directly. Do not ask the user for Trellis task-creation consent. Create a Trellis task only when cross-session, cross-Coding-Agent, or genuinely multi-stage context persistence is useful.
[/workflow-state:no_task]

### Phase 1: Context Packet

- 1.0 Create packet `[optional]`
- 1.1 Capture handoff context `[optional · repeatable]`
- 1.2 Research `[optional · repeatable]`
- 1.3 Curate worker context `[optional]`
- 1.4 Mark packet active `[optional]`
- 1.5 Ready to execute

[workflow-state:planning]
Trellis packet exists in planning state. Treat it as context, not an approval gate. Follow `AGENTS.md`; inspect GitHub / domain / ADR truth first, then update only the task-local artifacts needed for durable handoff. When implementation is already authorized and context is sufficient, mark the packet active or proceed without asking for another planning approval.
[/workflow-state:planning]

[workflow-state:planning-inline]
Trellis packet exists in planning state. Treat it as context, not an approval gate. Follow `AGENTS.md`; inspect GitHub / domain / ADR truth first, then update only the task-local artifacts needed for durable handoff. When implementation is already authorized and context is sufficient, mark the packet active or proceed without asking for another planning approval.
[/workflow-state:planning-inline]

### Phase 2: Execute With Context

- 2.1 Implement under `AGENTS.md` `[repeatable]`
- 2.2 Verify under repository contracts `[repeatable]`
- 2.3 Roll back / refresh context `[on demand]`

[workflow-state:in_progress]
Active Trellis Execution Packet: use it only as durable context. Main Coding Agent executes under `AGENTS.md`; do not default-dispatch `trellis-implement` or `trellis-check`. Load relevant `.trellis/spec/` plus task artifacts as needed. Use native subagents or `trellis channel` only for bounded independent work that genuinely benefits from separate context.
[/workflow-state:in_progress]

[workflow-state:in_progress-inline]
Active Trellis Execution Packet: use it only as durable context. Main Coding Agent executes under `AGENTS.md`; do not default-dispatch `trellis-implement` or `trellis-check`. Load relevant `.trellis/spec/` plus task artifacts as needed. Use native subagents or `trellis channel` only for bounded independent work that genuinely benefits from separate context.
[/workflow-state:in_progress-inline]

### Phase 3: Finish Product Work

- 3.2 Debug retrospective `[on demand]`
- 3.3 Promote durable knowledge `[on demand]`
- 3.4 Commit / PR / merge under `AGENTS.md`
- 3.5 Archive or retain Execution Packet `[optional]`

[workflow-state:completed]
Trellis packet is completed. Product completion is determined by `AGENTS.md` and GitHub remote truth, not by Trellis archive state. Archive or retain the packet as useful; do not create bookkeeping commits automatically.
[/workflow-state:completed]

### Rules

1. A Trellis status describes the Execution Packet, not the authority to code.
2. No active packet is a normal state; do not interrupt the user to create one.
3. `planning` does not require a second user approval if implementation was
   already clearly requested and repository evidence resolves the work.
4. `in_progress` does not imply automatic Trellis sub-agent dispatch.
5. Trellis checks do not replace AgentBean targeted tests, matching builds,
   GitHub Review, or merge readiness.
6. Trellis spec updates are on-demand knowledge promotion, not mandatory task
   closeout.
7. Trellis archive / journal operations are optional bookkeeping and do not
   determine whether a PR is done.

### Active Task Routing

For an active Execution Packet:

- need current project coding rules → read relevant `.trellis/spec/`;
- need previous conversation context → `trellis-session-insight` / `trellis mem`;
- need durable peer collaboration / independent worker → `trellis-channel`;
- learned reusable implementation convention → `trellis-update-spec`;
- Trellis itself needs maintenance → `trellis-meta`;
- `.trellis/spec/` needs a structural refresh → `trellis-spec-bootstrap`.

`trellis-brainstorm`, `trellis-break-loop`, `trellis-check`,
`trellis-finish-work`, and default implement/check/research sub-agent dispatch
are not AgentBean default routing. Their files may remain managed by Trellis.

### Loading Step Detail

The following step sections exist for compatibility with `get_context.py` and
can be loaded when working with an Execution Packet:

```bash
python3 ./.trellis/scripts/get_context.py --mode phase --step <X.Y>
```

---

## Phase 1: Plan

This phase exists only for optional Execution Packet context preparation. It is
not the product planning authority.

#### 1.0 Create packet `[optional]`

Create a task only when durable cross-session / cross-Agent context is useful:

```bash
python3 ./.trellis/scripts/task.py create "<title>" --slug <name>
```

Do not ask the user for process-only consent merely because Trellis is
installed. A clear implementation request already authorizes the project work;
the packet is an internal context mechanism.

#### 1.1 Capture handoff context `[optional · repeatable]`

Capture only what another Coding Agent would need after a context switch:

- owning GitHub Issue / acceptance reference;
- confirmed scope and unresolved product decisions;
- relevant branch / worktree / PR;
- task-local design or research that is not already authoritative elsewhere.

Do not duplicate stable domain rules from `CONTEXT.md`, ADR, or `.trellis/spec/`.
If product decisions remain genuinely unresolved, use the normal AgentBean
clarification path defined by `AGENTS.md`.

#### 1.2 Research `[optional · repeatable]`

Research directly or with an independent agent when useful. Version-sensitive
third-party questions should use the repository's selected
`source-driven-development` quality skill. Persist research under the task only
when another session / Agent will benefit from it.

#### 1.3 Curate worker context `[optional]`

Only if deliberately dispatching a Trellis worker, add the minimal spec/research
files it needs:

```bash
python3 ./.trellis/scripts/task.py add-context <task> implement <file> <reason>
python3 ./.trellis/scripts/task.py add-context <task> check <file> <reason>
```

Do not curate JSONL manifests for normal inline AgentBean development.

#### 1.4 Mark packet active `[optional]`

When an Execution Packet is useful during implementation:

```bash
python3 ./.trellis/scripts/task.py start <task-dir>
```

This changes Trellis context state only. It is not an implementation approval
boundary and must not cause a second user confirmation round.

#### 1.5 Ready to execute

The task is ready when the **project** contract is ready: GitHub requirements
are sufficiently clear, required domain/ADR context has been read, and the
current Agent can perform the next bounded slice. Trellis artifact completeness
is not a universal gate.

---

## Phase 2: Execute

Goal: use Trellis context without changing AgentBean's normal delivery loop.

#### 2.1 Implement `[repeatable]`

The current Coding Agent implements directly under `AGENTS.md`.

Before changing code, load only the context that matters:

1. GitHub Issue / PR and current git state;
2. relevant `CONTEXT.md` / ADR;
3. relevant `.trellis/spec/`;
4. task-local artifacts when an Execution Packet exists.

Use native subagents or `trellis channel` only for bounded independent work,
research, or review that benefits from isolated context. Do not auto-dispatch
`trellis-implement` because the packet status is `in_progress`.

#### 2.2 Verify `[repeatable]`

Verification is controlled by `AGENTS.md` and
`docs/agents/pr-merge-gate.md`:

- targeted behavior tests;
- matching TypeScript build from the Local Verification Contract;
- additional integration / browser / SEA / production checks only when the
  changed surface or acceptance contract requires them;
- one deep independent Review when required, not a Review loop after every push.

`trellis-check` is not required. If explicitly used, its output is advisory and
must not expand the repository verification matrix without evidence.

#### 2.3 Rollback / refresh context `[on demand]`

If execution exposes a requirement or architecture problem, return to the
appropriate authoritative source:

- product requirement defect → GitHub Issue / PRD;
- domain terminology defect → `CONTEXT.md` / domain-modeling;
- architecture decision defect → ADR discussion;
- implementation convention gap → `.trellis/spec/`;
- task-local stale handoff → update the Execution Packet.

---

## Phase 3: Finish

Product closeout belongs to AgentBean, not Trellis.

#### 3.2 Debug retrospective `[on demand]`

For hard / flaky / performance bugs, use Matt `diagnosing-bugs` as the primary
debugging discipline. After a fix, promote only genuinely reusable lessons to
`.trellis/spec/` or ADR / domain docs as appropriate. `trellis-break-loop` is
not a default required step.

#### 3.3 Promote durable knowledge `[on demand]`

Use `trellis-update-spec` only when the task discovered an implementation rule,
contract, gotcha, or anti-pattern that future AgentBean work should reuse.

Do not write product requirements or architecture rationale into
`.trellis/spec/`; route them to GitHub / CONTEXT / ADR.

#### 3.4 Commit / PR / merge

Follow `AGENTS.md` and `docs/agents/pr-merge-gate.md` exactly. Trellis does not
add a second commit plan, Review cycle, full-suite requirement, or merge gate.

`session_auto_commit: false` means task archive / journal bookkeeping must not
silently create product-history commits.

#### 3.5 Archive or retain Execution Packet `[optional]`

Archive only when useful for local organization:

```bash
python3 ./.trellis/scripts/task.py archive <task-name>
```

Archive status is not proof of product completion. GitHub PR / main CI /
deployment evidence remains authoritative.

---

## Customizing Trellis In AgentBean

When changing Trellis locally, preserve these invariants:

1. `AGENTS.md` remains the engineering authority.
2. `no_task` never requests process-only consent.
3. planning state never creates an extra implementation approval round.
4. in-progress state never defaults to implement/check sub-agent dispatch.
5. Trellis never makes spec updates, journal commits, or archive commits a
   universal completion requirement.
6. breadcrumbs remain context-only and platform-neutral.
7. project-local Trellis changes should survive Agent switching; do not encode
   a workflow that works only in Codex or only in Claude Code.

The workflow-state tag bodies above are intentionally the shared, platform-
neutral source consumed by supported Trellis hooks. Platform-specific files
should be thin adapters around this policy rather than separate workflow
owners.
