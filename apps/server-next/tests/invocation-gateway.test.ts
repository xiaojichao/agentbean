import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createInvocationGateway } from '../src/application/management/invocation-gateway.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { hasActiveProjectStageInvocation } from '../src/application/project-stage-advance-service.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

describe('Phase 1 Invocation Gateway', () => {
  test('validates the frozen target, permission, Team, channel, attachment, and target kind', async () => {
    const harness = await createHarness();
    const cases = [
      [{ frozenTargetAgentId: 'agent-2' }, 'INVOCATION_FROZEN_TARGET_MISMATCH'],
      [{ allowedTargetAgentIds: [] }, 'INVOCATION_TARGET_FORBIDDEN'],
      [{ intent: { ...intent(), teamId: 'team-2' } }, 'INVOCATION_TEAM_MISMATCH'],
      [{ intent: { ...intent(), channelId: 'channel-2' } }, 'INVOCATION_CHANNEL_MISMATCH'],
      [{ intent: { ...intent(), targetKind: 'agentos-hosted' as const } }, 'INVOCATION_TARGET_KIND_MISMATCH'],
      [{ intent: { ...intent(), attachmentIds: ['artifact-other-channel'] } }, 'INVOCATION_ATTACHMENT_FORBIDDEN'],
    ] as const;

    for (const [changes, code] of cases) {
      await expect(harness.gateway.invoke({ ...invokeInput(harness.authority), ...changes }))
        .rejects.toMatchObject({ code });
    }
  });

  test('atomically creates immutable Invocation, canonical Dispatch, attempt, and two events', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));

    expect(created.disposition).toBe('created');
    expect(created.view).toMatchObject({ status: 'pending', dispatchAttempts: [{ attemptNumber: 1, status: 'queued' }] });
    const events = await harness.repositories.management.events.list(harness.authority.managementRunId);
    expect(events.map(({ event }) => event.type)).toEqual([
      'run-started', 'worker-leased', 'invocation-created', 'dispatch-attempt-started',
    ]);
    await expect(harness.repositories.dispatches.getById(created.view.dispatchAttempts[0]!.dispatchId))
      .resolves.toMatchObject({ requestId: `management:${created.view.id}:1`, prompt: '完成目标' });
  });

  test('rolls back Invocation and Dispatch when a typed event cannot be committed', async () => {
    const harness = await createHarness();
    const append = harness.repositories.management.events.append;
    harness.repositories.management.events.append = async (record) => {
      if (record.event.type === 'invocation-created') throw new Error('EVENT_WRITE_FAILED');
      return append(record);
    };

    await expect(harness.gateway.invoke(invokeInput(harness.authority))).rejects.toThrow('EVENT_WRITE_FAILED');
    await expect(harness.repositories.management.invocations.listByRun(harness.authority.managementRunId)).resolves.toEqual([]);
    await expect(harness.repositories.dispatches.listByTeam('team-1')).resolves.toEqual([]);
  });

  test('persists the same Invocation/Dispatch lifecycle through SQLite', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    try {
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      const repositories = createSqliteRepositories({ globalDb, teamDb });
      let id = 0;
      const clock = { now: () => 20 };
      const ids = { nextId: () => `sqlite-${++id}` };
      await repositories.users.create({ id: 'user-1', username: 'user', role: 'user', passwordHash: 'unused', createdAt: 1, updatedAt: 1 });
      await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
      await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
      await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
      await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1 });
      await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
      const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
      const { run } = await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
      await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
      const authority = { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
      const gateway = createInvocationGateway({ repositories, clock, ids });

      const created = await gateway.invoke(invokeInput(authority));
      await gateway.completeAttempt({ dispatchId: created.view.dispatchAttempts[0]!.dispatchId, status: 'succeeded' });
      await expect(gateway.getView(created.view.id)).resolves.toMatchObject({ status: 'succeeded', dispatchAttempts: [{ attemptNumber: 1, status: 'succeeded' }] });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  test('returns the existing Invocation for the same key/hash and rejects intent drift', async () => {
    const harness = await createHarness();
    const first = await harness.gateway.invoke(invokeInput(harness.authority));
    const replay = await harness.gateway.invoke(invokeInput(harness.authority));

    expect(replay).toEqual({ disposition: 'existing', view: first.view });
    await expect(harness.gateway.invoke({
      ...invokeInput(harness.authority),
      intent: { ...intent(), objective: '偷偷换目标' },
    })).rejects.toMatchObject({ code: 'INVOCATION_IDEMPOTENCY_CONFLICT' });
    await expect(harness.repositories.management.invocations.listByRun(harness.authority.managementRunId)).resolves.toHaveLength(1);
  });

  test('freezes root-message document selections into a deterministic V2 InputSet and gates capabilities', async () => {
    const unsupported = await createHarness();
    await seedProjectDocumentInputSet(unsupported.repositories, false);
    await expect(unsupported.gateway.invoke(invokeInput(unsupported.authority)))
      .rejects.toMatchObject({ code: 'INVOCATION_INPUT_SET_AGENT_CAPABILITY_MISSING' });

    const harness = await createHarness();
    await seedProjectDocumentInputSet(harness.repositories, true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    expect(created.view.intent).toMatchObject({
      schemaVersion: 2,
      projectDocumentInputSet: {
        contractVersion: 1,
        required: true,
        referenceSetId: 'reference-set-1',
        items: [{
          documentId: 'document-1',
          baseRevisionId: 'revision-1',
          artifactId: 'artifact-document-1',
          displayName: 'plan.md',
          sha256: 'sha256-document-1',
          source: { selectionSourceKind: 'document' },
        }],
      },
    });
    const replay = await harness.gateway.invoke(invokeInput(harness.authority));
    expect(replay.disposition).toBe('existing');
    expect(replay.view.intent).toEqual(created.view.intent);
  });

  test('rejects an explicit V2 InputSet that omits a frozen Selection item', async () => {
    const harness = await createHarness();
    await seedProjectDocumentInputSet(harness.repositories, true);
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    expect(created.view.intent.schemaVersion).toBe(2);
    if (created.view.intent.schemaVersion !== 2) throw new Error('expected V2 intent');

    await expect(harness.gateway.invoke({
      ...invokeInput(harness.authority),
      idempotencyKey: 'invoke-incomplete-input-set',
      intent: {
        ...created.view.intent,
        projectDocumentInputSet: {
          ...created.view.intent.projectDocumentInputSet,
          items: [],
        },
      },
    })).rejects.toMatchObject({ code: 'INVOCATION_INPUT_SET_REFERENCE_STALE' });
  });

  test('rejects a stale Task revision instead of rewriting it while freezing InputSet', async () => {
    const harness = await createHarness();
    await seedProjectDocumentInputSet(harness.repositories, true);
    await harness.repositories.tasks.create({
      id: 'task-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      title: 'Task',
      description: 'Task',
      status: 'in_progress',
      creatorId: 'user-1',
      assigneeId: 'agent-1',
      tags: [],
      sortOrder: 1,
      revision: 2,
      createdAt: 1,
      updatedAt: 2,
    });

    await expect(harness.gateway.invoke({
      ...invokeInput(harness.authority),
      intent: {
        ...intent(),
        taskContext: {
          taskId: 'task-1',
          taskRevision: 1,
          taskAttempt: 1,
          claimLeaseId: 'claim-1',
        },
      },
    })).rejects.toMatchObject({ code: 'INVOCATION_TASK_REVISION_STALE' });
  });

  test('blocks active retries and only creates attempt +1 after an explicit terminal retry', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    await expect(harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id }))
      .rejects.toMatchObject({ code: 'INVOCATION_ACTIVE_ATTEMPT' });

    const firstDispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    const completed = await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'failed', error: 'PROVIDER_DOWN' });
    await expect(harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'failed', error: 'PROVIDER_DOWN' }))
      .resolves.toEqual({ ...completed, changed: false });
    const retried = await harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id });
    expect(retried).toMatchObject({ status: 'pending', dispatchAttempts: [{ attemptNumber: 1, status: 'failed' }, { attemptNumber: 2, status: 'queued' }] });
  });

  test('keeps a late result on its original Dispatch without overwriting a newer attempt', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const firstDispatchId = created.view.dispatchAttempts[0]!.dispatchId;
    await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'timed_out', error: 'DISPATCH_TIMEOUT' });
    const retried = await harness.gateway.retry({ authority: harness.authority, invocationId: created.view.id });
    const secondDispatchId = retried.dispatchAttempts[1]!.dispatchId;

    await harness.gateway.completeAttempt({ dispatchId: firstDispatchId, status: 'succeeded' });
    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({
      status: 'pending',
      activeDispatchId: secondDispatchId,
      dispatchAttempts: [
        { dispatchId: firstDispatchId, attemptNumber: 1, status: 'succeeded' },
        { dispatchId: secondDispatchId, attemptNumber: 2, status: 'queued' },
      ],
    });
  });

  test('derives Invocation status only from canonical Dispatch rows', async () => {
    const harness = await createHarness();
    const created = await harness.gateway.invoke(invokeInput(harness.authority));
    const attempt = (await harness.repositories.management.dispatchAttempts.list(created.view.id))[0]!;
    await harness.repositories.management.dispatchAttempts.update({ ...attempt, status: 'succeeded', completedAt: 30 });

    await expect(harness.gateway.getView(created.view.id)).resolves.toMatchObject({
      status: 'pending',
      dispatchAttempts: [{ status: 'queued' }],
    });
  });
});

describe('Phase 2 claim-bound Invocation Gateway', () => {
  test('derives target, criteria and dependency results from authoritative Server state', async () => {
    const harness = await createPhase2Harness({ withDependency: true });
    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));

    expect(created.disposition).toBe('created');
    expect(created.view.intent).toMatchObject({
      targetAgentId: 'agent-1', targetKind: 'custom',
      taskContext: { taskId: 'task-child', rootTaskId: 'task-root', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-child' },
      acceptanceCriteria: [{ id: 'criterion-child', description: '完成 child' }],
      dependencyResults: [{ invocationId: 'invocation-dependency', resultRevision: 1,
        artifactIds: ['artifact-dependency'], workspaceRunId: 'workspace-dependency' }],
    });
  });

  test.each([
    ['stale revision', { expectedTaskRevision: 2 }, 'INVOCATION_TASK_REVISION_STALE'],
    ['stale attempt', { taskAttempt: 2 }, 'INVOCATION_TASK_ATTEMPT_STALE'],
    ['stale claim', { claimLeaseId: 'claim-stale' }, 'INVOCATION_CLAIM_STALE'],
    ['expired deadline', { deadlineAt: 20 }, 'INVOCATION_DEADLINE_EXPIRED'],
    ['forbidden attachment', { attachmentIds: ['artifact-other-channel'] }, 'INVOCATION_ATTACHMENT_FORBIDDEN'],
  ] as const)('fails closed for %s', async (_label, changes, code) => {
    const harness = await createPhase2Harness();
    await expect(harness.gateway.invokeTask({ ...phase2InvokeInput(harness.authority), ...changes }))
      .rejects.toMatchObject({ code });
  });

  test('rejects unmet dependencies and a second active Invocation for the same Task attempt', async () => {
    const blocked = await createPhase2Harness({ withDependency: true, dependencyDone: false });
    await expect(blocked.gateway.invokeTask(phase2InvokeInput(blocked.authority)))
      .rejects.toMatchObject({ code: 'INVOCATION_DEPENDENCIES_NOT_READY' });

    const harness = await createPhase2Harness();
    await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));
    await expect(harness.gateway.invokeTask({
      ...phase2InvokeInput(harness.authority), idempotencyKey: 'invoke-child-second',
    })).rejects.toMatchObject({ code: 'INVOCATION_TASK_ATTEMPT_ACTIVE' });
  });

  test('creates the claim-bound Invocation through the SQLite atomic unit of work', async () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    try {
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      const harness = await createPhase2Harness({}, createSqliteRepositories({ globalDb, teamDb }));
      await expect(harness.gateway.invokeTask(phase2InvokeInput(harness.authority)))
        .resolves.toMatchObject({ disposition: 'created', view: { status: 'pending',
          intent: { targetAgentId: 'agent-1', taskContext: { claimLeaseId: 'claim-child' } } } });
    } finally {
      globalDb.close();
      teamDb.close();
    }
  });

  test('only freezes a live authoritative Capsule ref and compares the complete ref on replay', async () => {
    const harness = await createPhase2Harness();
    const ref = phase2CapsuleRef(harness.authority.managementRunId);
    await harness.repositories.memory.capsuleRefs.create({ ...ref, issuedAt: 1, createdAt: 1 });

    const mismatches = [
      { ...ref, teamId: 'team-2' },
      { ...ref, managementRunId: 'run-other' },
      { ...ref, taskId: 'task-other' },
      { ...ref, targetAgentId: 'agent-2' },
      { ...ref, contentHash: 'sha256:other' },
      { ...ref, authorizationDecisionId: 'decision-other' },
      { ...ref, expiresAt: 101 },
    ];
    for (const memoryCapsuleRef of mismatches) {
      await expect(harness.gateway.invokeTask({
        ...phase2InvokeInput(harness.authority),
        memoryCapsuleRef,
      })).rejects.toMatchObject({ code: 'INVOCATION_MEMORY_CAPSULE_REF_INVALID' });
    }

    const created = await harness.gateway.invokeTask({
      ...phase2InvokeInput(harness.authority),
      memoryCapsuleRef: ref,
    });
    expect(created.view.intent.memoryCapsuleRef).toEqual(ref);
    for (const memoryCapsuleRef of mismatches) {
      await expect(harness.gateway.invokeTask({
        ...phase2InvokeInput(harness.authority),
        memoryCapsuleRef,
      })).rejects.toMatchObject({ code: 'INVOCATION_IDEMPOTENCY_CONFLICT' });
    }

    const unavailable = await createPhase2Harness();
    const expiredRef = { ...phase2CapsuleRef(unavailable.authority.managementRunId), id: 'capsule-expired', expiresAt: 10 };
    await unavailable.repositories.memory.capsuleRefs.create({ ...expiredRef, issuedAt: 1, createdAt: 1 });
    await expect(unavailable.gateway.invokeTask({
      ...phase2InvokeInput(unavailable.authority), memoryCapsuleRef: expiredRef,
    })).rejects.toMatchObject({ code: 'INVOCATION_MEMORY_CAPSULE_REF_INVALID' });

    const deniedRef = { ...phase2CapsuleRef(unavailable.authority.managementRunId), id: 'capsule-denied' };
    await unavailable.repositories.memory.capsuleRefs.create({ ...deniedRef, issuedAt: 1, createdAt: 1 });
    await unavailable.repositories.memory.capsuleRefs.markDenied({
      teamId: deniedRef.teamId, id: deniedRef.id, deniedAt: 10,
    });
    await expect(unavailable.gateway.invokeTask({
      ...phase2InvokeInput(unavailable.authority), memoryCapsuleRef: deniedRef,
    })).rejects.toMatchObject({ code: 'INVOCATION_MEMORY_CAPSULE_REF_INVALID' });
  });

  test('项目阶段推进只把显式绑定的最终 ArtifactVersion 合入下游 Invocation', async () => {
    const harness = await createPhase2Harness();
    await seedArtifactStageInput(harness.repositories);

    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));

    expect(created.view.intent.attachmentIds).toEqual(['artifact-1', 'artifact-stage-final']);
    expect(created.view.intent.projectStageInputFence).toEqual({
      stageId: 'stage-downstream',
      inputs: [expect.objectContaining({
        kind: 'artifact_version',
        collectionId: 'collection-stage-input',
        versionId: 'version-stage-final',
        reviewId: 'review-stage-final',
        finalizationId: 'finalization-stage-final',
      })],
    });
  });

  test('最终产物的最新审核改变后，Invocation 在提交边界重新校验并 fail closed', async () => {
    const harness = await createPhase2Harness();
    await seedArtifactStageInput(harness.repositories);
    await harness.repositories.channelProjects.appendArtifactReview({
      review: {
        id: 'review-stage-invalidated',
        teamId: 'team-1',
        channelId: 'channel-1',
        collectionId: 'collection-stage-input',
        versionId: 'version-stage-final',
        stageId: 'stage-upstream',
        decision: 'changes_requested',
        comment: '需要修改',
        basis: [],
        reviewedBy: 'user-1',
        createdAt: 5,
      },
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'review-stage-invalidated',
        requestFingerprint: 'review-stage-invalidated',
        action: 'review',
        collectionId: 'collection-stage-input',
        versionId: 'version-stage-final',
        resultId: 'review-stage-invalidated',
        createdAt: 5,
      },
    });

    await expect(harness.gateway.invokeTask(phase2InvokeInput(harness.authority)))
      .rejects.toMatchObject({ code: 'INVOCATION_PROJECT_INPUT_STALE' });
  });

  test('Invocation 冻结精确 ArtifactVersion 审核 fence，事实变化后不能重试旧 intent', async () => {
    const harness = await createPhase2Harness();
    await seedArtifactStageInput(harness.repositories);
    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));
    const dispatchId = created.view.activeDispatchId!;
    await harness.gateway.completeAttempt({
      dispatchId,
      status: 'failed',
      error: 'TEST_FAILURE',
    });
    const task = await harness.repositories.tasks.getById('task-child');
    const coordination = await harness.repositories.taskCoordination.coordinations
      .getByTaskId('task-child');
    expect(task && coordination
      ? await hasActiveProjectStageInvocation(harness.repositories, task, coordination)
      : true).toBe(false);
    await harness.repositories.channelProjects.appendArtifactReview({
      review: {
        id: 'review-stage-after-invocation',
        teamId: 'team-1',
        channelId: 'channel-1',
        collectionId: 'collection-stage-input',
        versionId: 'version-stage-final',
        stageId: 'stage-upstream',
        decision: 'changes_requested',
        comment: '撤回通过',
        basis: [],
        reviewedBy: 'user-1',
        createdAt: 7,
      },
      mutation: {
        teamId: 'team-1',
        channelId: 'channel-1',
        idempotencyKey: 'review-stage-after-invocation',
        requestFingerprint: 'review-stage-after-invocation',
        action: 'review',
        collectionId: 'collection-stage-input',
        versionId: 'version-stage-final',
        resultId: 'review-stage-after-invocation',
        createdAt: 7,
      },
    });

    await expect(harness.gateway.retry({
      authority: harness.authority,
      invocationId: created.view.id,
    })).rejects.toMatchObject({ code: 'INVOCATION_PROJECT_INPUT_STALE' });
  });

  test('V1 项目阶段 Invocation 重试时重新校验当前 Claim，而非仅依赖冻结 intent', async () => {
    const harness = await createPhase2Harness();
    await seedArtifactStageInput(harness.repositories);
    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));
    await harness.gateway.completeAttempt({
      dispatchId: created.view.activeDispatchId!,
      status: 'failed',
      error: 'TEST_FAILURE',
    });
    await harness.repositories.taskCoordination.claimLeases.update({
      id: 'claim-child',
      expectedStatus: 'active',
      status: 'released',
      heartbeatAt: 21,
      expiresAt: 21,
      releasedAt: 21,
    });

    await expect(harness.gateway.retry({
      authority: harness.authority,
      invocationId: created.view.id,
    })).rejects.toMatchObject({ code: 'INVOCATION_CLAIM_STALE' });
  });

  test('项目阶段推进把显式文档包的当前 revision 冻结为 InputSet', async () => {
    const harness = await createPhase2Harness();
    await seedProjectDocumentInputSet(harness.repositories, true);
    await seedDocumentStageInput(harness.repositories, harness.authority.managementRunId);

    const created = await harness.gateway.invokeTask(phase2InvokeInput(harness.authority));

    expect(created.view.intent).toMatchObject({
      schemaVersion: 2,
      projectDocumentInputSet: {
        required: true,
        items: [{
          documentId: 'document-1',
          baseRevisionId: 'revision-1',
          source: { bundleId: 'bundle-stage-input' },
        }],
      },
    });
  });
});

async function createHarness() {
  const repositories = createInMemoryRepositories();
  let id = 0;
  const dependencies = { repositories, clock: { now: () => 20 }, ids: { nextId: () => `id-${++id}` } };
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.channels.create({ id: 'channel-2', teamId: 'team-1', kind: 'channel', name: 'other', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成目标', createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-other-channel', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'secret.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  const kernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock: dependencies.clock, ids: dependencies.ids });
  const { run } = await kernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  return {
    repositories,
    gateway: createInvocationGateway(dependencies),
    authority: { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 },
  };
}

function intent() {
  return { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: '完成目标', acceptanceCriteria: [], dependencyResults: [], attachmentIds: ['artifact-1'] };
}

function invokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, frozenTargetAgentId: 'agent-1', allowedTargetAgentIds: ['agent-1'] as readonly string[], idempotencyKey: 'invoke-1', intent: intent() };
}

async function seedProjectDocumentInputSet(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  supported: boolean,
): Promise<void> {
  await repositories.devices.upsertHello({
    id: 'device-1',
    teamId: 'team-1',
    ownerId: 'user-1',
    status: 'online',
    capabilities: supported ? { projectDocumentInputSetVersions: [1] } : {},
    lastSeenAt: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  const agent = await repositories.agents.getById('agent-1');
  await repositories.agents.upsert({
    ...agent!,
    deviceId: 'device-1',
    projectDocumentInputSetVersions: supported ? [1] : undefined,
  });
  const artifact = {
    id: 'artifact-document-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    uploaderId: 'user-1',
    filename: 'plan.md',
    mimeType: 'text/markdown',
    sizeBytes: 10,
    sha256: 'sha256-document-1',
    createdAt: 1,
  };
  await repositories.channelDocuments.create({
    document: {
      id: 'document-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      filename: 'plan.md',
      currentRevisionId: 'revision-1',
      createdAt: 1,
      updatedAt: 1,
    },
    revision: {
      id: 'revision-1',
      documentId: 'document-1',
      artifact,
      revision: 1,
      createdBy: 'user-1',
      createdAt: 1,
      source: 'attachment',
      published: false,
    },
  });
  const selection = {
    id: 'selection-1',
    referenceSetId: 'reference-set-1',
    sourceKind: 'document' as const,
    position: 0,
    createdAt: 1,
    items: [],
  };
  const item = {
    id: 'reference-item-1',
    selectionId: selection.id,
    kind: 'document_revision' as const,
    position: 0,
    documentId: 'document-1',
    revisionId: 'revision-1',
    revisionNumber: 1,
    filename: 'plan.md',
    createdAt: 1,
  };
  await repositories.projectReferenceSets.create({
    set: {
      id: 'reference-set-1',
      contractVersion: 1,
      teamId: 'team-1',
      channelId: 'channel-1',
      messageId: 'message-1',
      createdBy: 'user-1',
      createdAt: 1,
      selections: [],
    },
    selections: [selection],
    items: [item],
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'reference-set-create',
      requestFingerprint: 'reference-set-fingerprint',
      referenceSetId: 'reference-set-1',
      createdAt: 1,
    },
  });
}

async function createPhase2Harness(
  options: { withDependency?: boolean; dependencyDone?: boolean } = {},
  repositories = createInMemoryRepositories(),
) {
  let id = 0;
  const clock = { now: () => 20 };
  const ids = { nextId: () => `phase2-${++id}` };
  await repositories.users.create({ id: 'user-1', username: 'user', role: 'user', passwordHash: 'unused', createdAt: 1, updatedAt: 1 });
  await repositories.teams.create({ id: 'team-1', name: 'Team', path: 'team', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  await repositories.channels.create({ id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], createdAt: 1 });
  await repositories.channels.create({ id: 'channel-2', teamId: 'team-1', kind: 'channel', name: 'other', visibility: 'public', humanMemberIds: ['user-1'], agentMemberIds: [], createdAt: 1 });
  await repositories.agents.upsert({ id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent', adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online' });
  await repositories.messages.append({ id: 'message-1', teamId: 'team-1', channelId: 'channel-1', senderKind: 'human', senderId: 'user-1', body: '完成 DAG', createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-1', uploaderId: 'user-1', filename: 'spec.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.artifacts.create({ id: 'artifact-other-channel', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'secret.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 1 });
  await repositories.tasks.create({ id: 'task-root', teamId: 'team-1', channelId: 'channel-1', title: 'Root', status: 'in_progress', creatorId: 'user-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
  await repositories.tasks.create({ id: 'task-child', teamId: 'team-1', channelId: 'channel-1', title: 'Child', description: '执行 child', status: 'in_progress', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const managementKernel = createManagementKernel({ repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork, clock, ids });
  const { run } = await managementKernel.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-root', rootMessageId: 'message-1', requestKey: 'request-phase2', requestHash: 'hash-phase2', placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
  await managementKernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-root', teamId: 'team-1', managementRunId: run.id, nodeKind: 'root', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-child', teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root', managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
  await repositories.taskCoordination.criteria.create({ id: 'criterion-child', taskId: 'task-child', description: '完成 child', evidenceRequired: true, introducedRevision: 1, position: 0 });
  await repositories.taskCoordination.claimLeases.create({ id: 'claim-child', teamId: 'team-1', taskId: 'task-child', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1, status: 'active', acquiredAt: 1, heartbeatAt: 10, expiresAt: 100 });
  if (options.withDependency) {
    await repositories.tasks.create({ id: 'task-dependency', teamId: 'team-1', channelId: 'channel-1', title: 'Dependency', status: options.dependencyDone === false ? 'in_review' : 'done', creatorId: 'user-1', assigneeId: 'agent-1', tags: [], sortOrder: 2, createdAt: 1, updatedAt: 1 });
    await repositories.taskCoordination.coordinations.create({ schemaVersion: 1, taskId: 'task-dependency', teamId: 'team-1', rootTaskId: 'task-root', parentTaskId: 'task-root', managementRunId: run.id, nodeKind: 'subtask', reviewPolicy: 'manager', claimPolicy: 'open', requiredCapabilities: [], attempt: 1, maxAttempts: 2, taskRevision: 1, createdAt: 1, updatedAt: 1 });
    await repositories.taskCoordination.dependencies.create({ taskId: 'task-child', dependencyTaskId: 'task-dependency', taskRevision: 1 });
    if (options.dependencyDone !== false) {
      await repositories.taskCoordination.claimLeases.create({ id: 'claim-dependency', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'hash-dep', leaseFingerprint: 'fingerprint-dep', fencingToken: 1, status: 'released', acquiredAt: 1, heartbeatAt: 10, expiresAt: 100, releasedAt: 15 });
      await repositories.taskCoordination.evidenceSnapshots.create({ id: 'snapshot-artifact', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, invocationId: 'invocation-dependency', kind: 'artifact', sourceId: 'artifact-dependency', snapshotHash: 'sha256:artifact', snapshot: {}, capturedAt: 12 });
      await repositories.taskCoordination.evidenceSnapshots.create({ id: 'snapshot-workspace', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, invocationId: 'invocation-dependency', kind: 'workspace-run', sourceId: 'workspace-dependency', snapshotHash: 'sha256:workspace', snapshot: {}, capturedAt: 12 });
      await repositories.taskCoordination.deliveries.create({ schemaVersion: 1, id: 'delivery-dependency', teamId: 'team-1', taskId: 'task-dependency', taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-dependency', invocationId: 'invocation-dependency', summary: 'dependency done', claims: [], evidenceRefs: [{ kind: 'artifact', id: 'artifact-dependency', snapshotHash: 'sha256:artifact', capturedAt: 12 }, { kind: 'workspace-run', id: 'workspace-dependency', snapshotHash: 'sha256:workspace', capturedAt: 12 }], idempotencyKey: 'delivery-dependency', createdAt: 12 });
      await repositories.taskCoordination.acceptances.create({ schemaVersion: 1, id: 'acceptance-dependency', teamId: 'team-1', taskId: 'task-dependency', deliveryId: 'delivery-dependency', expectedTaskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-dependency', decision: 'accepted', criteriaResults: [], reason: 'ok', decidedBy: 'manager', decidedAt: 14, decisionVersion: 1, canonical: true });
    }
  }
  return { repositories, gateway: createInvocationGateway({ repositories, clock, ids }), authority: { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 } };
}

function phase2InvokeInput(authority: { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number }) {
  return { authority, idempotencyKey: 'invoke-child', taskId: 'task-child', expectedTaskRevision: 1,
    taskAttempt: 1, claimLeaseId: 'claim-child', objective: '执行 child', attachmentIds: ['artifact-1'] };
}

function phase2CapsuleRef(managementRunId: string) {
  return {
    schemaVersion: 1 as const,
    id: 'capsule-1',
    teamId: 'team-1',
    managementRunId,
    taskId: 'task-child',
    targetAgentId: 'agent-1',
    contentHash: 'sha256:capsule-content',
    authorizationDecisionId: 'decision-1',
    expiresAt: 100,
  };
}

async function seedProjectStages(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  requiredInputs: Parameters<typeof repositories.channelProjects.createStageEdge>[0]['edge']['requiredInputs'],
) {
  await repositories.tasks.create({
    id: 'task-upstream', teamId: 'team-1', channelId: 'channel-1', title: 'Upstream',
    status: 'done', creatorId: 'user-1', tags: [], sortOrder: 3, createdAt: 1, updatedAt: 1,
  });
  const downstreamCoordination = await repositories.taskCoordination.coordinations
    .getByTaskId('task-child');
  if (!downstreamCoordination) throw new Error('downstream coordination missing');
  await repositories.taskCoordination.coordinations.create({
    schemaVersion: 1,
    taskId: 'task-upstream',
    teamId: 'team-1',
    rootTaskId: downstreamCoordination.rootTaskId,
    parentTaskId: downstreamCoordination.parentTaskId,
    managementRunId: downstreamCoordination.managementRunId,
    nodeKind: 'subtask',
    reviewPolicy: 'manager',
    claimPolicy: 'open',
    requiredCapabilities: [],
    attempt: 1,
    maxAttempts: 2,
    taskRevision: 1,
    createdAt: 1,
    updatedAt: 1,
  });
  await repositories.taskCoordination.claimLeases.create({
    id: 'claim-stage-upstream',
    teamId: 'team-1',
    taskId: 'task-upstream',
    taskRevision: 1,
    taskAttempt: 1,
    agentId: 'agent-1',
    leaseTokenHash: 'stage-upstream-hash',
    leaseFingerprint: 'stage-upstream-fingerprint',
    fencingToken: 1,
    status: 'released',
    acquiredAt: 1,
    heartbeatAt: 2,
    expiresAt: 100,
    releasedAt: 3,
  });
  await repositories.taskCoordination.deliveries.create({
    schemaVersion: 1,
    id: 'delivery-stage-upstream',
    teamId: 'team-1',
    taskId: 'task-upstream',
    taskRevision: 1,
    taskAttempt: 1,
    claimLeaseId: 'claim-stage-upstream',
    invocationId: 'invocation-stage-upstream',
    summary: '上游阶段已交付',
    claims: [],
    evidenceRefs: [],
    idempotencyKey: 'delivery-stage-upstream',
    createdAt: 3,
  });
  await repositories.taskCoordination.acceptances.create({
    schemaVersion: 1,
    id: 'acceptance-stage-upstream',
    teamId: 'team-1',
    taskId: 'task-upstream',
    deliveryId: 'delivery-stage-upstream',
    expectedTaskRevision: 1,
    taskAttempt: 1,
    claimLeaseId: 'claim-stage-upstream',
    decision: 'accepted',
    criteriaResults: [],
    reason: '人审通过',
    decidedBy: 'manager',
    decidedAt: 4,
    decisionVersion: 1,
    canonical: true,
  });
  const profile = {
    id: 'profile-stage-input', teamId: 'team-1', channelId: 'channel-1',
    projectLeadId: 'user-1', defaultReviewerIds: ['user-1'], revision: 1,
    createdBy: 'user-1', createdAt: 1, updatedAt: 1,
  };
  const upstream = {
    id: 'stage-upstream', teamId: 'team-1', channelId: 'channel-1',
    taskId: 'task-upstream', taskRevision: 1, name: 'Upstream', goal: '交付输入',
    ownerId: 'user-1', reviewerIds: ['user-1'], acceptanceCriteria: ['完成'],
    createdAt: 1, updatedAt: 1,
  };
  await repositories.channelProjects.createInitialStage({
    expectedRevision: 0, profile, stage: upstream,
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'stage-upstream',
      requestFingerprint: 'stage-upstream', profileId: profile.id, stageId: upstream.id,
      resultRevision: 1, resultOverview: {} as never, createdAt: 1,
    },
  });
  const downstream = {
    id: 'stage-downstream', teamId: 'team-1', channelId: 'channel-1',
    taskId: 'task-child', taskRevision: 1, name: 'Downstream', goal: '消费输入',
    ownerId: 'user-1', reviewerIds: ['user-1'], acceptanceCriteria: ['完成'],
    createdAt: 2, updatedAt: 2,
  };
  await repositories.channelProjects.createStage({
    expectedRevision: 1, nextRevision: 2, updatedAt: 2, stage: downstream,
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'stage-downstream',
      requestFingerprint: 'stage-downstream', profileId: profile.id, stageId: downstream.id,
      resultRevision: 2, resultOverview: {} as never, createdAt: 2,
    },
  });
  await repositories.channelProjects.createStageEdge({
    expectedRevision: 2, nextRevision: 3, updatedAt: 3,
    edge: {
      id: 'edge-stage-input', teamId: 'team-1', channelId: 'channel-1',
      upstreamStageId: upstream.id, downstreamStageId: downstream.id,
      upstreamTaskId: upstream.taskId, upstreamTaskRevision: 1,
      downstreamTaskId: downstream.taskId, downstreamTaskRevision: 1,
      semantics: 'blocks_start', requiredInputs, mirroredTaskDependency: false,
      createdBy: 'user-1', createdAt: 3, updatedAt: 3,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'edge-stage-input',
      requestFingerprint: 'edge-stage-input', profileId: profile.id, stageId: downstream.id,
      resultRevision: 3, resultOverview: {} as never, createdAt: 3,
    },
  });
}

async function seedArtifactStageInput(
  repositories: ReturnType<typeof createInMemoryRepositories>,
) {
  await seedProjectStages(repositories, [{
    key: 'final-artifact', kind: 'artifact', label: '最终产物',
    source: {
      kind: 'artifact_collection', collectionId: 'collection-stage-input',
      versionPolicy: 'final',
    },
  }]);
  await repositories.artifacts.create({
    id: 'artifact-stage-final', teamId: 'team-1', channelId: 'channel-1',
    uploaderId: 'user-1', filename: 'final.pdf', mimeType: 'application/pdf',
    sizeBytes: 8, sha256: 'sha256-stage-final', createdAt: 4,
  });
  await repositories.channelProjects.promoteArtifact({
    teamId: 'team-1', channelId: 'channel-1', createsCollection: true,
    collection: {
      id: 'collection-stage-input', teamId: 'team-1', channelId: 'channel-1',
      name: '最终产物', kind: 'file', revision: 1,
      currentVersionId: 'version-stage-final',
      versionCount: 1, createdBy: 'user-1', createdAt: 4, updatedAt: 4,
    },
    version: {
      id: 'version-stage-final', teamId: 'team-1', channelId: 'channel-1',
      collectionId: 'collection-stage-input', versionNumber: 1,
      artifactId: 'artifact-stage-final', stageId: 'stage-upstream',
      taskId: 'task-upstream', taskRevision: 1, lineage: [],
      promotedBy: 'user-1', createdAt: 4,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'promote-stage-final',
      requestFingerprint: 'promote-stage-final', collectionId: 'collection-stage-input',
      versionId: 'version-stage-final', createdAt: 4,
    },
  });
  await repositories.channelProjects.appendArtifactReview({
    review: {
      id: 'review-stage-final', teamId: 'team-1', channelId: 'channel-1',
      collectionId: 'collection-stage-input', versionId: 'version-stage-final',
      stageId: 'stage-upstream', decision: 'approved', comment: '通过', basis: [],
      reviewedBy: 'user-1', createdAt: 5,
    },
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'review-stage-final',
      requestFingerprint: 'review-stage-final', action: 'review',
      collectionId: 'collection-stage-input', versionId: 'version-stage-final',
      resultId: 'review-stage-final', createdAt: 5,
    },
  });
  await repositories.channelProjects.setArtifactFinalVersion({
    teamId: 'team-1',
    channelId: 'channel-1',
    collectionId: 'collection-stage-input',
    expectedCollectionRevision: 1,
    nextRevision: 2,
    updatedAt: 6,
    finalization: {
      id: 'finalization-stage-final',
      teamId: 'team-1',
      channelId: 'channel-1',
      collectionId: 'collection-stage-input',
      versionId: 'version-stage-final',
      basisReviewId: 'review-stage-final',
      actorKind: 'human',
      finalizedBy: 'user-1',
      createdAt: 6,
    },
    mutation: {
      teamId: 'team-1',
      channelId: 'channel-1',
      idempotencyKey: 'finalize-stage-final',
      requestFingerprint: 'finalize-stage-final',
      action: 'finalize',
      collectionId: 'collection-stage-input',
      versionId: 'version-stage-final',
      resultId: 'finalization-stage-final',
      createdAt: 6,
    },
  });
}

async function seedDocumentStageInput(
  repositories: ReturnType<typeof createInMemoryRepositories>,
  managementRunId: string,
) {
  await seedProjectStages(repositories, [{
    key: 'documents', kind: 'document', label: '冻结文档',
    source: { kind: 'document_bundle', bundleId: 'bundle-stage-input' },
  }]);
  await repositories.management.invocations.create({
    schemaVersion: 1, id: 'invocation-upstream', managementRunId,
    intent: {
      schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1',
      targetAgentId: 'agent-1', targetKind: 'custom', objective: '上游',
      taskContext: {
        taskId: 'task-upstream', rootTaskId: 'task-root', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-upstream',
      },
      acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
    },
    intentHash: 'upstream-hash', idempotencyKey: 'upstream', createdAt: 4,
  });
  await repositories.projectDocumentBundles.create({
    bundle: {
      id: 'bundle-stage-input', teamId: 'team-1', channelId: 'channel-1',
      name: '上游文档', source: {
        kind: 'workspace_run', workspaceRunId: 'run-upstream', agentId: 'agent-1',
        invocationId: 'invocation-upstream', taskId: 'task-upstream', runCreatedAt: 4,
      },
      memberCount: 1, createdBy: 'user-1', createdAt: 4,
    },
    members: [{
      bundleId: 'bundle-stage-input', position: 1, documentId: 'document-1',
      initialRevisionId: 'revision-1', initialRevisionNumber: 1, initialFilename: 'plan.md',
    }],
    mutation: {
      teamId: 'team-1', channelId: 'channel-1', idempotencyKey: 'bundle-stage-input',
      requestFingerprint: 'bundle-stage-input', bundleId: 'bundle-stage-input', createdAt: 4,
    },
  });
}
