---
name: observability-and-instrumentation
description: "AgentBean adaptation of Addy Osmani's observability-and-instrumentation skill. Use when production I/O, retries, cross-process/service calls, Agent runtime chains, or incident diagnosis need durable runtime evidence."
---

# Observability and Instrumentation — AgentBean Adaptation

Derived from Addy Osmani's MIT-licensed `agent-skills`; see `THIRD_PARTY_NOTICES.md`.

This skill improves operability where evidence is missing. It does **not** require every feature PR to add logs, metrics, traces, and alerts.

## Trigger

Use when a change introduces or materially alters:

- Server ↔ Daemon ↔ Agent Runtime communication
- Socket.IO lifecycle, reconnect, dispatch, ack, timeout, retry
- external AgentOS / Gateway / provider calls
- background work, staging/publish flows, Artifact processing
- bounded retry / fallback behavior
- production-facing operations whose failures would otherwise be opaque
- an incident where existing logs/events cannot answer what happened

Do not use for pure computation, mechanical refactors, static docs, or UI-only changes whose behavior is already observable through normal browser evidence.

## Process

### 1. Start from operator questions

Before adding telemetry, write 1–4 concrete questions an operator must be able to answer, for example:

- Did the server authorize and dispatch this Agent invocation?
- Did the target Daemon receive it?
- Which runtime executed it and with what terminal outcome?
- Was a publish/Artifact failure local, network, authorization, or storage related?
- Did reconnect create duplicate listeners or duplicate deliveries?

No question → no new telemetry.

### 2. Choose the smallest signal

- **Structured log / durable event** — why one specific operation failed or changed state
- **Metric** — how often / how slow / how many in aggregate
- **Trace / correlation chain** — where time or failure occurred across process/service boundaries

Prefer existing AgentBean system-activity, run, task, dispatch, or event mechanisms before introducing a new observability subsystem.

### 3. Correlate across boundaries

When one logical operation crosses Browser → Server → Daemon → Agent Runtime, propagate an existing stable correlation/run/task/dispatch identifier where the domain already has one.

Do not invent a second correlation identity if Task ID, ManagementRun ID, WorkspaceRun ID, dispatch ID, request ID, or another existing contract already serves the purpose.

### 4. Emit structured, bounded data

Telemetry should have:

- stable event name / state
- bounded categorical fields
- one or more existing correlation identifiers
- duration / outcome when relevant
- error class/code rather than uncontrolled full objects

Never log full request bodies, secrets, raw credentials, complete env maps, private file contents, or unrestricted model prompts/output.

Do not use high-cardinality values such as user-provided text or arbitrary error messages as metric labels.

### 5. Preserve authority boundaries

Observability is evidence, not business truth.

- a log does not authorize an action;
- a notice/change-feed event does not replace the authoritative query/state;
- a Web projection does not become server truth;
- local Daemon logs do not override Team-scoped server authority.

### 6. Verify telemetry itself

Trigger the relevant success/failure path in the smallest available environment and confirm the new signal actually answers the operator question.

Follow `AGENTS.md` for repository tests/builds. Do not add a full production monitoring exercise to an ordinary PR unless acceptance requires it.

## AgentBean-Specific Review Questions

For cross-process changes, ask only what applies:

- Can one operation be followed from Server to Daemon/Runtime without guessing?
- Are retries distinguishable from duplicate user requests?
- Can timeout vs authorization vs runtime-unavailable vs execution-failed be separated?
- Are Team/user/device/agent identifiers logged only at the minimum necessary level?
- Is any sensitive local workspace path or secret leaking to server/browser telemetry?
- Are high-frequency events sampled/bounded rather than flooding logs or system activity?

## Interaction With Other Skills

- current incident diagnosis → Matt `diagnosing-bugs`
- browser runtime evidence → `browser-testing-with-devtools`
- sensitive data / authorization telemetry → `security-and-hardening`
- retiring a blind legacy path during cutover → `deprecation-and-migration`

Do not automatically chain all skills.

## Red Flags

- adding `console.log` everywhere instead of one structured signal
- logging entire payloads/envs/prompts to make debugging easier
- adding new IDs when a domain/run ID already exists
- metrics with unbounded Team/user/path/error labels
- treating logs as authoritative state
- building a new observability stack when an existing AgentBean event/run surface can answer the question
