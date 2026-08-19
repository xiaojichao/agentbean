---
name: deprecation-and-migration
description: "AgentBean adaptation of Addy Osmani's deprecation-and-migration skill. Use for legacy-to-next replacement, schema/protocol migration, authority cutover, compatibility retirement, runtime replacement, or other staged removals."
---

# Deprecation and Migration — AgentBean Adaptation

Derived from Addy Osmani's MIT-licensed `agent-skills`; see `THIRD_PARTY_NOTICES.md`.

`AGENTS.md`, current ADRs, and the owning GitHub Issue define scope. This skill provides migration discipline; it does not create its own roadmap or release process.

## Trigger

Use when work includes:

- legacy `apps/*` or compatibility path retirement
- old → next implementation replacement
- protocol / DTO / API contract migration
- SQLite/schema migration that must coexist with old/new code
- PI authority or ownership cutover
- Agent runtime / Daemon / package-name transition
- feature flag / dual-read / dual-write / shadow mode / staged traffic switch
- removal of an old capability after consumers move

Do not use for normal additive features with no old-system coexistence or removal problem.

## Process

### 1. Identify old, new, and authority

Write down:

- **old path**: what currently serves users/agents?
- **new path**: what will replace it?
- **consumer set**: who still depends on old behavior?
- **authority during transition**: which side is source of truth at each stage?
- **irreversible step**: what cannot be safely rolled back once executed?

If the authority boundary is not clear, do not begin destructive removal.

### 2. Define coexistence invariants

During migration, specify what must remain true while old and new code coexist, for example:

- both versions can read the current schema;
- only one side is authoritative for a state transition;
- compatibility adapters preserve required external contracts;
- new behavior can be disabled without corrupting old state;
- old clients do not observe fields/events they cannot tolerate.

Record system-level decisions in ADR / owning issue, not only in the implementation plan.

### 3. Prefer expand → migrate → contract

For data/protocol changes, default to additive stages:

```text
EXPAND
  add new shape/path while old remains valid
    ↓
MIGRATE
  dual-write / backfill / shadow / switch consumers
    ↓
VERIFY
  prove old path has zero required consumers / traffic
    ↓
CONTRACT
  remove old shape/path in a later bounded change
```

Avoid rename/drop/in-place destructive changes when multiple deployed versions can overlap.

### 4. Make cutover evidence explicit

Before switching authority or deleting old code, identify measurable proof:

- all known consumers migrated
- compatibility call/event count reaches the required threshold/zero
- new path handles real production traffic/work
- rollback path is understood
- main CI / deploy / smoke / live health evidence is available under AgentBean's normal closeout contract

Do not accept “the new code exists” as proof the old code is removable.

### 5. Remove completely when the contract step arrives

Once removal is safe, delete the old implementation **and** its dead tests, configs, docs, flags, compatibility adapters, stale generated artifacts, and routing references when they no longer serve another supported path.

Search for residual references before declaring the migration done.

### 6. Keep migration PRs bounded

Prefer independently verifiable vertical slices over one giant migration PR. Each slice should have:

- a clear reversible or forward-safe state;
- targeted tests + required builds under `AGENTS.md`;
- explicit rollout/cutover implications when relevant.

Use `wayfinder` / `to-tickets` only when the migration genuinely exceeds a single session/task and needs GitHub-level decomposition.

## Database / Persistent State Rules

- additive schema first;
- backfill separately when data volume/risk warrants it;
- switch reads only after the new shape is populated;
- destructive drop/rename after no supported code references the old shape;
- do not assume deploy is instantaneous—old and new processes may overlap;
- test the rollback/forward-recovery mechanism appropriate to AgentBean's SQLite/runtime model.

## Interaction With Other Skills

- current third-party migration guidance → `source-driven-development`
- permission / credential implications → `security-and-hardening`
- proving production usage/cutover → `observability-and-instrumentation`
- browser-visible compatibility/cutover → `browser-testing-with-devtools`

Invoke only what the migration actually needs.

## Red Flags

- removing old code before identifying every consumer
- two implementations both believing they are authoritative
- schema rename/drop in the same deploy that first requires the new name
- compatibility shim with no retirement condition
- feature flag that becomes permanent zombie infrastructure
- migration marked done while old routing/config/docs remain live
- adding new features to a path already scheduled for retirement
