# AgentBean Next

This folder is the rewrite workspace for AgentBean.

The intent is not to continue patching the current implementation in place. Instead, this workspace extracts the parts of the existing project that are worth preserving, then defines a cleaner target design that can be implemented with a smaller, testable core.

## Decision

Use a spec-first semi-rebuild:

- Keep the product model, workflow knowledge, protocol lessons, daemon execution experience, and existing tests where they describe real behavior.
- Rebuild the core server and client boundaries around explicit domains, use cases, repositories, and transport adapters.
- Migrate feature slices vertically, proving each slice with behavior tests before replacing old code.

## Documents

- `docs/current-behavior.md` summarizes the current product behavior that should survive the rewrite.
- `docs/current-protocol-inventory.md` inventories the current Socket.IO and HTTP protocol surface.
- `docs/current-data-model-inventory.md` inventories the current SQLite data model and persistence concepts.
- `docs/feature-disposition.md` maps existing feature/event surfaces to keep, defer, merge, or drop decisions.
- `docs/agent-identity-rules.md` defines canonical Agent identity, dedupe, conflict, and precedence rules.
- `docs/contracts-dto.md` defines first-slice shared DTOs, `Ack`, and `ErrorCode`.
- `docs/known-gaps.md` records open product, protocol, data model, web, daemon, and testing gaps.
- `docs/asset-inventory.md` lists what to preserve, what to rewrite, and why.
- `docs/target-architecture.md` describes the desired module boundaries.
- `docs/socket-protocol.md` defines the initial `/web` and `/agent` protocol surface for the rewrite.
- `docs/implementation-runbook.md` gives the step-by-step development checklist for the first slice.
- `docs/first-slice-schema-repositories.md` defines the fresh SQLite schema and repository interfaces for the first slice.
- `docs/migration-plan.md` gives the staged implementation plan.
- `docs/verification-matrix.md` maps required tests to phases and source documents.
- `docs/acceptance-tests.md` lists behavior checks that should guard the rebuild.

## Non-Goals

- This folder does not yet contain runnable app code.
- It does not replace current `apps/web`, `apps/server`, or `apps/daemon`.
- It should not carry forward current file shapes just because they exist. Existing code is a reference source, not the target architecture.

## First Implementation Slice

The first runnable slice should be:

1. User login or registration.
2. Network selection and snapshot.
3. Daemon registration.
4. Runtime scan snapshot.
5. Channel creation and message send.
6. Agent dispatch and reply persistence.

Only after this slice is stable should the remaining features be migrated.
