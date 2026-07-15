import type {
  DispatchMemoryContextItemDto,
  ID,
  MemoryCapsuleDto,
  MemoryCapsuleItemDto,
  MemoryCapsuleRefDto,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';
import { hashCapsuleItems } from '../../../../packages/domain/src/index.js';
import type { CapsuleInjectionValidator } from './capsule-injection-validator.js';
import type {
  MemoryAuditEventRecord,
  MemoryCapsuleItemManifestRecord,
  MemoryCapsuleRefRecord,
  MemoryItemRecord,
  MemoryRepositories,
} from './memory-repositories.js';
import type { MemoryUnitOfWork } from './memory-unit-of-work.js';

export class ServerCapsuleRuntimeContextError extends Error {
  constructor(readonly code: string) { super(code); }
}

export interface ResolveServerCapsuleRuntimeContextInput {
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly memoryCapsuleRef: MemoryCapsuleRefDto;
  readonly now: UnixMs;
}

export interface ServerCapsuleRuntimeContextResolver {
  resolve(input: ResolveServerCapsuleRuntimeContextInput): Promise<readonly DispatchMemoryContextItemDto[]>;
}

export interface CreateServerCapsuleRuntimeContextServiceInput {
  readonly unitOfWork: MemoryUnitOfWork;
  readonly validator: CapsuleInjectionValidator;
  readonly ids: { nextId(): ID };
  readonly currentPolicyVersion: () => number;
}

/**
 * Rebuilds a body-free persisted Capsule manifest from current Server Memory truth, then performs
 * the same authorization checks as first delivery. Any drift rejects the whole Capsule: an
 * Invocation must never continue with a silently reduced projection.
 */
export function createServerCapsuleRuntimeContextService(
  input: CreateServerCapsuleRuntimeContextServiceInput,
): ServerCapsuleRuntimeContextResolver {
  return {
    async resolve(resolveInput) {
      const snapshot = await input.unitOfWork.run(async (memory) => loadSnapshot(memory, resolveInput));
      assertBoundRef(snapshot.ref, resolveInput);
      if (snapshot.ref.deniedAt !== undefined || snapshot.ref.expiresAt <= resolveInput.now) {
        throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_NOT_CURRENT');
      }
      if (snapshot.manifests.length === 0) {
        if (snapshot.ref.contentHash !== hashCapsuleItems([])) {
          await denyRef(input.unitOfWork, input.ids, snapshot.ref, resolveInput.now);
          throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_RECONSTRUCTION_FAILED');
        }
        await input.unitOfWork.run(async (memory) => {
          await memory.auditEvents.append(capsuleReadAudit(
            input.ids.nextId(), snapshot.ref, undefined, resolveInput.now,
          ));
        });
        return [];
      }

      let capsule: MemoryCapsuleDto;
      try {
        capsule = rebuildCapsule(snapshot.ref, snapshot.manifests, snapshot.memories);
      } catch {
        await denyRef(input.unitOfWork, input.ids, snapshot.ref, resolveInput.now);
        throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_RECONSTRUCTION_FAILED');
      }
      const validation = await input.validator.validateCapsuleForInjection({
        capsule,
        requesterUserId: snapshot.manifests[0]?.requesterUserId ?? '',
        now: resolveInput.now,
        currentPolicyVersion: input.currentPolicyVersion(),
      });
      if (validation.capsuleExpired || validation.decisions.some((decision) => !decision.allowed)
        || hashCapsuleItems(capsule.items) !== snapshot.ref.contentHash) {
        await denyRef(input.unitOfWork, input.ids, snapshot.ref, resolveInput.now);
        throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_REVALIDATION_FAILED');
      }

      await input.unitOfWork.run(async (memory) => {
        await memory.auditEvents.append(capsuleReadAudit(
          input.ids.nextId(), snapshot.ref, snapshot.manifests[0]?.requesterUserId, resolveInput.now,
        ));
        for (const item of capsule.items) {
          await memory.auditEvents.append(capsuleInjectedAudit(
            input.ids.nextId(), snapshot.ref, snapshot.manifests[0]?.requesterUserId, item, resolveInput.now,
          ));
        }
      });

      return capsule.items.map((item): DispatchMemoryContextItemDto => ({
        schemaVersion: 1,
        id: item.memoryId,
        kind: memoryKind(snapshot.memories.get(item.memoryId)!.item),
        scopeType: item.scopeType,
        content: item.content,
        selectionReason: 'invocation-bound-capsule-currently-authorized',
        provenance: {
          origin: 'server',
          capsuleId: capsule.id,
          authorizationDecisionId: item.authorization.decisionId,
          sourceRefs: item.sourceRefs,
        },
      }));
    },
  };
}

async function loadSnapshot(
  memory: MemoryRepositories,
  input: ResolveServerCapsuleRuntimeContextInput,
): Promise<{
  ref: MemoryCapsuleRefRecord;
  manifests: MemoryCapsuleItemManifestRecord[];
  memories: Map<ID, { item: MemoryItemRecord; sourceRefs: MemoryCapsuleItemDto['sourceRefs'] }>;
}> {
  const ref = await memory.capsuleRefs.getById({ teamId: input.teamId, id: input.memoryCapsuleRef.id });
  if (!ref) throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_NOT_FOUND');
  const manifests = await memory.capsuleItems.listByCapsule({ teamId: input.teamId, capsuleId: ref.id });
  const memories = new Map<ID, { item: MemoryItemRecord; sourceRefs: MemoryCapsuleItemDto['sourceRefs'] }>();
  for (const manifest of manifests) {
    const item = await memory.items.getById({ teamId: input.teamId, id: manifest.memoryId });
    if (!item) continue;
    const sources = await memory.sources.listByMemory({ teamId: input.teamId, memoryId: manifest.memoryId });
    memories.set(manifest.memoryId, {
      item,
      sourceRefs: sources.map((source) => ({
        schemaVersion: 1,
        sourceKind: source.sourceKind,
        sourceId: source.sourceId,
        snapshotHash: source.snapshotHash,
      })),
    });
  }
  return { ref, manifests, memories };
}

function rebuildCapsule(
  ref: MemoryCapsuleRefRecord,
  manifests: readonly MemoryCapsuleItemManifestRecord[],
  memories: ReadonlyMap<ID, { item: MemoryItemRecord; sourceRefs: MemoryCapsuleItemDto['sourceRefs'] }>,
): MemoryCapsuleDto {
  const items = manifests.map((manifest): MemoryCapsuleItemDto => {
    const current = memories.get(manifest.memoryId);
    if (!current) throw new Error('memory missing');
    const content = manifest.contentField === 'summary' ? current.item.summary?.trim() : current.item.content;
    if (!content) throw new Error('projected content missing');
    return {
      schemaVersion: 1,
      memoryId: manifest.memoryId,
      scopeType: manifest.scopeType,
      scopeRef: manifest.scopeRef,
      sourceVisibility: manifest.sourceVisibility,
      contentKind: manifest.contentKind,
      redactionLevel: manifest.redactionLevel,
      content,
      sourceRefs: current.sourceRefs,
      authorization: manifest.authorization,
      expiresAt: manifest.expiresAt,
    };
  });
  return {
    schemaVersion: 1,
    id: ref.id,
    teamId: ref.teamId,
    managementRunId: ref.managementRunId,
    taskId: ref.taskId,
    targetAgentId: ref.targetAgentId,
    items,
    createdAt: ref.issuedAt,
    expiresAt: ref.expiresAt,
  };
}

function assertBoundRef(ref: MemoryCapsuleRefRecord, input: ResolveServerCapsuleRuntimeContextInput): void {
  const requested = input.memoryCapsuleRef;
  if (ref.id !== requested.id || ref.teamId !== input.teamId || ref.teamId !== requested.teamId
    || ref.managementRunId !== input.managementRunId || ref.managementRunId !== requested.managementRunId
    || ref.taskId !== input.taskId || ref.taskId !== requested.taskId
    || ref.targetAgentId !== input.targetAgentId || ref.targetAgentId !== requested.targetAgentId
    || ref.contentHash !== requested.contentHash
    || ref.authorizationDecisionId !== requested.authorizationDecisionId
    || ref.expiresAt !== requested.expiresAt) {
    throw new ServerCapsuleRuntimeContextError('SERVER_CAPSULE_INVOCATION_BINDING_INVALID');
  }
}

async function denyRef(
  unitOfWork: MemoryUnitOfWork,
  ids: { nextId(): ID },
  ref: MemoryCapsuleRefRecord,
  now: UnixMs,
): Promise<void> {
  if (ref.deniedAt !== undefined || now < ref.issuedAt || now > ref.expiresAt) return;
  await unitOfWork.run(async (memory) => {
    const current = await memory.capsuleRefs.getById({ teamId: ref.teamId, id: ref.id });
    if (!current || current.deniedAt !== undefined) return;
    await memory.capsuleRefs.markDenied({ teamId: ref.teamId, id: ref.id, deniedAt: now });
    await memory.auditEvents.append({
      id: ids.nextId(), teamId: ref.teamId, subjectKind: 'capsule', subjectId: ref.id,
      eventType: 'capsule-denied', actorKind: 'system', targetAgentId: ref.targetAgentId,
      sourceRefs: [], createdAt: now,
    });
  });
}

function capsuleReadAudit(
  id: ID,
  ref: MemoryCapsuleRefRecord,
  actorId: ID | undefined,
  now: UnixMs,
): MemoryAuditEventRecord {
  return {
    id, teamId: ref.teamId, subjectKind: 'capsule', subjectId: ref.id,
    eventType: 'capsule-read', actorKind: 'system', actorId,
    targetAgentId: ref.targetAgentId, sourceRefs: [], createdAt: now,
  };
}

function capsuleInjectedAudit(
  id: ID,
  ref: MemoryCapsuleRefRecord,
  actorId: ID | undefined,
  item: MemoryCapsuleItemDto,
  now: UnixMs,
): MemoryAuditEventRecord {
  return {
    id, teamId: ref.teamId, subjectKind: 'capsule', subjectId: ref.id,
    eventType: 'capsule-injected', actorKind: 'system', actorId,
    decisionId: item.authorization.decisionId, targetAgentId: ref.targetAgentId,
    scopeType: item.scopeType, scopeRef: item.scopeRef, sourceRefs: item.sourceRefs,
    sourceRefsHash: item.authorization.sourceRefsHash,
    contentHash: item.authorization.contentHash,
    redactionLevel: item.redactionLevel,
    createdAt: now,
  };
}

function memoryKind(item: MemoryItemRecord): DispatchMemoryContextItemDto['kind'] {
  return item.kind;
}
