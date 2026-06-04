# Asset Inventory

This document separates reusable project assets from implementation shapes that should be replaced.

## Preserve As Product Sources

These files capture product intent and should become the source material for the rewrite specs:

- `README.md`
- `docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- `docs/superpowers/specs/2026-05-09-agentbean-architecture-design.md`
- `docs/superpowers/specs/2026-06-01-agentbean-current-behavior-baseline-spec.md`
- `docs/superpowers/plans/2026-05-09-agentbean-implementation-roadmap.md`

The most important product invariants to preserve:

- AgentBean is a local-first team collaboration platform for humans, local agents, remote-device agents, and AgentOS-hosted agents.
- A team or network owns channels, DMs, threads, tasks, files, members, devices, and agent visibility.
- The system has three processes: Web, Server, and Daemon.
- Web talks to Server over Socket.IO and artifact HTTP routes.
- Daemon talks to Server over Socket.IO and executes local tools or bridges to AgentOS gateways.
- SQLite remains acceptable for the first rewrite version: global database plus team/network-scoped storage.

## Preserve As Behavior Assets

These areas contain useful behavior and edge-case knowledge:

- `apps/server/src/routing.ts`
  - Small, isolated message routing rule for mention, human mention, fallback, and no-online states.
- `apps/server/src/auth.ts`, `apps/server/src/password.ts`, `apps/server/src/invite.ts`
  - Useful authentication and invite mechanics, though they should move behind application services.
- `apps/server/src/channels.ts`
  - Channel membership and private-channel behavior are reusable as domain/use-case requirements.
- `apps/server/src/artifact-routes.ts`, `apps/server/src/storage.ts`
  - Artifact and per-network storage behavior should be preserved, but the repository boundary should be cleaner.
- `apps/server/src/registry.ts`, `apps/server/src/heartbeat-scanner.ts`
  - Runtime state, heartbeat, reconnect, and offline behavior are valuable, but should be split from transport code.
- `apps/daemon/src/scanner.ts`
  - Runtime detection and AgentOS/local-agent scanning have high migration value.
- `apps/daemon/src/adapters/*`
  - Adapter behavior should be migrated behind a stable execution interface.
- `apps/daemon/src/device-daemon.ts`
  - Device lifecycle, scan cache, periodic rescan, and dispatch behavior are important, but the file should be decomposed.
- `apps/web/app/[networkPath]/*`
  - Information architecture and feature coverage are useful.
- `apps/web/tests/*`, `apps/server/tests/*`, `apps/daemon/tests/*`
  - Existing tests are not complete, but they are good regression seeds.

## Rewrite Instead Of Porting

These files are useful references but should not be copied as the target shape:

- `apps/server/src/index.ts`
  - Too many responsibilities: app boot, auth, Socket.IO handlers, network management, devices, tasks, messages, artifacts, and dispatch.
- `apps/server/src/db.ts`
  - Schema, migration, row mapping, repository behavior, and types are too tightly combined.
- `apps/server/src/namespaces/agent.ts`
  - Valuable behavior, but transport handling, persistence, registry updates, device state, and dispatch coordination are interleaved.
- `apps/web/lib/socket.ts`
  - Too broad as a single client module. It should become feature-scoped protocol clients.
- `apps/web/lib/store.ts`
  - Contains domain-ish agent dedupe and selection logic that duplicates server/daemon rules.
- `apps/web/app/[networkPath]/tasks/page.tsx`
  - Page, local UI state, socket calls, filters, thread UI, upload behavior, and rendering are combined.
- `apps/web/app/[networkPath]/chat/page.tsx`
  - Same concern: feature behavior and presentation should be split before migration.

## Risks To Preserve Explicitly

The rewrite should treat these as explicit requirements rather than accidental implementation details:

- Agent identity is not trivial. Scanned agents, self-registered agents, custom agents, device IDs, runtime paths, and AgentOS gateway agents must dedupe consistently.
- Network membership and agent publishing are distinct concepts.
- DM and private channel visibility must be enforced server-side, not only hidden in the UI.
- Dispatch history must not duplicate the current user prompt.
- Daemon reconnect and periodic scan behavior are part of correctness, not just observability.
- Artifact upload must connect generated files to messages, channels, agents, and workspace runs.
- Device invite flow must preserve the distinction between browser-authenticated users and daemon sockets waiting for token delivery.

## Suggested Extraction Rules

- Extract behavior first, not files.
- Each migrated behavior needs an acceptance test before old code is replaced.
- Shared normalization rules should live in one shared domain module or be generated from a single protocol schema.
- Socket event payloads should be typed at the boundary and converted into domain commands.
- Repositories should expose use-case-oriented methods, not raw table-shaped APIs.
