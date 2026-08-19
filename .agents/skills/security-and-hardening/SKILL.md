---
name: security-and-hardening
description: "AgentBean adaptation of Addy Osmani's security-and-hardening skill. Use for authentication, authorization, Team isolation, Device credentials, files/artifacts, untrusted input, Agent invocation, remote execution, secrets, or external trust boundaries."
---

# Security and Hardening — AgentBean Adaptation

Derived from Addy Osmani's MIT-licensed `agent-skills`; see `THIRD_PARTY_NOTICES.md`.

`AGENTS.md`, current ADRs, and AgentBean's existing authorization/domain contracts are authoritative. This skill is a **targeted security gate**, not a mandatory step for every PR.

## Trigger

Use when a change touches one or more trust boundaries:

- login, session, invitation, authentication
- owner/admin/member authorization
- Team data isolation or cross-Team access
- Device Profile / credential / secret handling
- Agent configuration, invocation, tool/command authorization
- local daemon ↔ server trust
- file upload, Artifact preview/download, Workspace publish/staging
- user-controlled paths, URLs, shell arguments, commands, env values
- Socket.IO events carrying untrusted data or authority
- external AgentOS / Gateway / webhook / third-party APIs
- memory visibility / projection / permission boundaries

Do not run this skill for pure visual styling or internal mechanical refactors with no trust-boundary impact.

## Process

### 1. Map the boundary

Before proposing controls, identify:

- **actor**: who initiates the action?
- **credential / identity**: how is the actor authenticated?
- **resource**: what can be read, changed, invoked, downloaded, or executed?
- **authority**: what project rule decides whether the actor may do it?
- **boundary**: where does untrusted input become trusted state?
- **blast radius**: what happens if the check is missing or bypassed?

For Team-scoped behavior, explicitly verify the Team boundary rather than relying on UI filtering or caller discipline.

### 2. Threat-model the changed surface

Use a lightweight STRIDE pass where relevant:

- Spoofing — can identity/device/agent be impersonated?
- Tampering — can payloads, files, paths, artifacts, task state, or memory be changed outside authority?
- Repudiation — does a security-sensitive action need audit evidence?
- Information disclosure — can another Team/user/Agent see data it should not?
- Denial of service — can untrusted input create unbounded work, files, Agent loops, or socket pressure?
- Elevation of privilege — can member/device/Agent gain owner/admin/system capability?

Write abuse cases only for plausible paths touched by the diff; do not produce a generic OWASP essay.

### 3. Verify enforcement in code

Prefer structural enforcement:

- validate untrusted input at the boundary;
- authorize server-side at the resource boundary;
- never trust Web UI hiding as authorization;
- parameterize database operations;
- normalize/contain filesystem paths before access;
- use explicit allowlists for executable operations and exposed capabilities;
- keep secrets/env values out of snapshots, logs, artifacts, and prompts;
- treat LLM / Agent output as untrusted input before shell, filesystem, SQL, HTML, URL fetch, or privileged tool execution;
- bound retries, recursion, worker counts, payload sizes, upload sizes, and timeouts where the changed path can amplify work.

### 4. Add the smallest meaningful regression evidence

For a security boundary, test the negative path, not only the happy path. Examples:

- wrong Team cannot read/update the resource;
- revoked device credential is rejected;
- user-controlled path cannot escape allowed roots;
- forbidden Agent capability cannot be invoked;
- unsafe MIME / file type cannot execute in preview;
- untrusted URL / redirect cannot reach disallowed targets.

Follow `AGENTS.md` for the actual validation matrix and matching build.

### 5. Review secrets and logging

Check changed code for:

- raw tokens / credentials in Git
- secrets or full env maps in logs / responses
- PII or cross-Team data in telemetry
- stack traces or internal paths exposed to untrusted clients

If a real secret was committed remotely, treat it as compromised and rotate it; deleting the line is insufficient.

## Interaction With Other Skills

- version-sensitive security API → `source-driven-development`
- browser-only verification of a security UI flow → `browser-testing-with-devtools` after server enforcement is verified
- production security signal / auditability gap → `observability-and-instrumentation`
- staged replacement of an insecure legacy path → `deprecation-and-migration`

Do not automatically invoke all of them.

## Red Flags

- authorization only in Web code
- trusting `teamId`, `userId`, `deviceId`, `agentId`, path, MIME, URL, or role because the client sent it
- broad catch-all permissions for convenience
- shell command composition from untrusted strings
- Agent/LLM output passed directly into privileged execution
- security review that lists theoretical issues without checking the changed code path
- expanding a small change into a repo-wide hardening project without evidence
