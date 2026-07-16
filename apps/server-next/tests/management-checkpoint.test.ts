import { describe, expect, test } from 'vitest';
import { createManagementCheckpointService, collectManagementCheckpointFacts, restoreOrRebuildManagementCheckpoint } from '../src/application/management/management-checkpoint.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

describe('management checkpoint', () => {
  test('captures exact disjoint waiting/completed Invocation facts in one Unit of Work', async () => {
    const harness = await createHarness();
    await harness.repositories.invocations.create(invocation('invocation-waiting', 'capsule-1', 20));
    await harness.repositories.invocations.create(invocation('invocation-completed', undefined, 21));
    await harness.repositories.dispatchAttempts.create({ id: 'attempt-1', invocationId: 'invocation-completed', dispatchId: 'dispatch-1', attemptNumber: 1, status: 'succeeded', startedAt: 22, completedAt: 23 });

    const checkpoint = await harness.checkpoints.save({ authority: harness.authority, idempotencyKey: 'checkpoint-1', contextHints: { objective: 'finish root task', planSummary: 'one pending', completedInvocationSummaries: [], unresolvedQuestions: [] } });
    expect(checkpoint.authoritative).toMatchObject({
      openTaskIds: ['task-1'],
      waitingInvocationIds: ['invocation-waiting'],
      completedInvocationIds: ['invocation-completed'],
      memoryCapsuleIds: [],
      lastEventSequence: 3,
    });
    expect(new Set([...checkpoint.authoritative.waitingInvocationIds, ...checkpoint.authoritative.completedInvocationIds]).size).toBe(2);
    await expect(harness.checkpoints.save({ authority: harness.authority, idempotencyKey: 'checkpoint-2', contextHints: { ...checkpoint.contextHints, planSummary: 'second snapshot' } })).resolves.toMatchObject({ revision: 2 });
    await expect(harness.checkpoints.save({ authority: harness.authority, idempotencyKey: 'checkpoint-1', contextHints: checkpoint.contextHints })).resolves.toEqual(checkpoint);
  });

  test('discards all stale hints when any authoritative reference drifts', async () => {
    const harness = await createHarness();
    const run = await harness.repositories.runs.getById(harness.authority.managementRunId);
    if (!run) throw new Error('missing run');
    const facts = await collectManagementCheckpointFacts(harness.repositories, run);
    const stale = {
      schemaVersion: 1 as const, managementRunId: run.id, revision: 1,
      authoritative: { lastEventSequence: facts.lastEventSequence, taskGraphRevision: facts.taskGraphRevision, openTaskIds: ['task-1', 'ghost-task'], waitingInvocationIds: [], completedInvocationIds: [], memoryCapsuleIds: [] },
      contextHints: { objective: 'secret stale objective', planSummary: 'stale plan', completedInvocationSummaries: [], unresolvedQuestions: ['stale question'], nextAction: 'stale action' },
      updatedAt: 1,
    };
    const result = restoreOrRebuildManagementCheckpoint({ checkpoint: stale, facts, objective: 'authoritative objective', now: 30 });
    expect(result.kind).toBe('rebuilt');
    expect(result.checkpoint.contextHints).toEqual({ objective: 'authoritative objective', planSummary: '', completedInvocationSummaries: [], unresolvedQuestions: [] });
    expect(JSON.stringify(result.checkpoint.contextHints)).not.toContain('stale');
  });

  test('captures the complete Phase 2 DAG, revisions, active claims and Invocation sets from one authoritative snapshot', async () => {
    const repositories = createInMemoryRepositories();
    let sequence = 0;
    const clock = { now: () => 100 };
    const ids = { nextId: () => sequence++ === 0 ? 'run-p2' : `id-${sequence}` };
    await repositories.tasks.create({ id: 'root-p2', teamId: 'team-1', title: 'Root', status: 'todo',
      creatorId: 'user-1', channelId: 'channel-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1 });
    const management = createManagementKernel({ repositories: repositories.management,
      unitOfWork: repositories.managementUnitOfWork, clock, ids });
    await management.createOrResumeRun({ teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'root-p2',
      rootMessageId: 'message-1', requestKey: 'request-p2', requestHash: 'hash-p2',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 } });
    await management.acquireLease({ managementRunId: 'run-p2', workerId: 'worker-1',
      host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 1_000 });
    const taskKernel = createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork,
      clock, ids });
    const authority = { managementRunId: 'run-p2', workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 };
    await taskKernel.createRootCoordination({ authority, idempotencyKey: 'root', taskId: 'root-p2',
      claimPolicy: 'open', requiredCapabilities: [], acceptanceCriteria: [], maxAttempts: 1 });
    await taskKernel.createSubtasks({ authority, idempotencyKey: 'children', parentTaskId: 'root-p2',
      subtasks: [{ taskId: 'child-p2', clientKey: 'child', title: 'Child', claimPolicy: 'open',
        requiredCapabilities: [], acceptanceCriteria: [], maxAttempts: 2 }] });
    await repositories.taskCoordination.claimLeases.create({ id: 'claim-p2', teamId: 'team-1',
      taskId: 'child-p2', taskRevision: 1, taskAttempt: 1, agentId: 'agent-1',
      leaseTokenHash: 'hash', leaseFingerprint: 'fingerprint', fencingToken: 1, status: 'active',
      acquiredAt: 10, heartbeatAt: 10, expiresAt: 1_000 });
    await repositories.management.invocations.create({ schemaVersion: 1, id: 'invocation-p2',
      managementRunId: 'run-p2', intentHash: 'intent-hash', idempotencyKey: 'invocation-key', createdAt: 20,
      intent: { schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1',
        targetKind: 'custom', objective: 'child', taskContext: { taskId: 'child-p2', rootTaskId: 'root-p2',
          taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-p2' }, acceptanceCriteria: [],
        dependencyResults: [], attachmentIds: [] } });
    const run = await repositories.management.runs.getById('run-p2');
    if (!run) throw new Error('missing run');
    const facts = await repositories.taskCoordinationUnitOfWork.run((snapshot) =>
      collectManagementCheckpointFacts(snapshot.management, run, {
        tasks: snapshot.tasks, coordination: snapshot.coordination,
      }));
    expect(facts).toMatchObject({ taskGraphRevision: 1,
      openTaskIds: ['child-p2', 'root-p2'], waitingInvocationIds: ['invocation-p2'],
      activeClaimLeaseIds: ['claim-p2'] });
    expect(facts.taskSnapshots).toEqual([
      { taskId: 'child-p2', taskRevision: 1, taskAttempt: 1, status: 'todo', claimLeaseId: 'claim-p2' },
      { taskId: 'root-p2', taskRevision: 1, taskAttempt: 1, status: 'todo' },
    ]);
    const checkpoint = await createManagementCheckpointService({ unitOfWork: repositories.managementUnitOfWork,
      taskCoordinationUnitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids }).save({
        authority, idempotencyKey: 'checkpoint-p2',
        contextHints: { objective: 'continue DAG', planSummary: '',
          completedInvocationSummaries: [], unresolvedQuestions: [] },
      });
    expect(checkpoint.authoritative).toMatchObject({
      activeClaimLeaseIds: ['claim-p2'], waitingInvocationIds: ['invocation-p2'],
      taskSnapshots: facts.taskSnapshots,
    });
  });

  test('reads validMemoryCapsuleIds from runtime truth provider and otherwise fails closed', async () => {
    const harness = await createHarness();
    const run = await harness.repositories.runs.getById(harness.authority.managementRunId);
    if (!run) throw new Error('run not found');
    const now = 5_000;
    const memoryCapsules = { async listValidMemoryCapsuleIds() { return ['cap-valid']; } };
    const facts = await collectManagementCheckpointFacts(
      harness.repositories, run, undefined, memoryCapsules, now,
    );
    expect(facts.validMemoryCapsuleIds).toEqual(['cap-valid']);

    // 不注入 runtime truth provider → fail-closed 空数组（Phase 1 占位，向后兼容）。
    const closedFacts = await collectManagementCheckpointFacts(harness.repositories, run, undefined, undefined, now);
    expect(closedFacts.validMemoryCapsuleIds).toEqual([]);
  });

  test('rebuild drops invalid capsules from authoritative (P3-16: recovery 不恢复无效 Capsule)', async () => {
    const harness = await createHarness();
    const run = await harness.repositories.runs.getById(harness.authority.managementRunId);
    if (!run) throw new Error('run not found');
    const now = 5_000;
    const memoryCapsules = { async listValidMemoryCapsuleIds() { return ['cap-valid']; } };
    const facts = await collectManagementCheckpointFacts(
      harness.repositories, run, undefined, memoryCapsules, now,
    );
    expect(facts.validMemoryCapsuleIds).toEqual(['cap-valid']);

    // authoritative 引用了全部三个 capsule（含已失效的 expired/denied）→ 与 facts 不一致 → rebuild。
    const stale = {
      schemaVersion: 1 as const, managementRunId: run.id, revision: 1,
      authoritative: {
        lastEventSequence: facts.lastEventSequence, taskGraphRevision: facts.taskGraphRevision,
        openTaskIds: facts.openTaskIds, waitingInvocationIds: facts.waitingInvocationIds,
        completedInvocationIds: facts.completedInvocationIds,
        memoryCapsuleIds: ['cap-valid', 'cap-expired', 'cap-denied'],
      },
      contextHints: { objective: 'stale objective', planSummary: '', completedInvocationSummaries: [], unresolvedQuestions: [] },
      updatedAt: 1,
    };
    const result = restoreOrRebuildManagementCheckpoint({ checkpoint: stale, facts, objective: 'rebuilt objective', now });
    expect(result.kind).toBe('rebuilt');
    // rebuild 后 authoritative 只保留有效 capsule（不恢复失效的 expired/denied）。
    expect(result.checkpoint.authoritative.memoryCapsuleIds).toEqual(['cap-valid']);
    if (result.kind === 'rebuilt') {
      expect(result.reasons).toContain('invalid-memory-capsule');
    }
  });
});

async function createHarness() {
  const persistence = createInMemoryManagementPersistence();
  let id = 0;
  const dependencies = { ...persistence, clock: { now: () => 10 }, ids: { nextId: () => `id-${++id}` } };
  const kernel = createManagementKernel(dependencies);
  const { run } = await kernel.createOrResumeRun({
    teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'task-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1',
    placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
  return { ...persistence, checkpoints: createManagementCheckpointService(dependencies), authority: { managementRunId: run.id, workerId: 'worker-1', leaseToken: 'token', fencingToken: 1 } };
}

function invocation(id: string, memoryCapsuleId: string | undefined, createdAt: number) {
  return {
    schemaVersion: 1 as const, id, managementRunId: 'id-1', intentHash: `${id}-hash`, idempotencyKey: `${id}-key`, createdAt,
    intent: {
      schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: id, acceptanceCriteria: [], dependencyResults: [],
      ...(memoryCapsuleId && {
        memoryCapsuleRef: {
          schemaVersion: 1 as const, id: memoryCapsuleId, teamId: 'team-1', managementRunId: 'id-1',
          targetAgentId: 'agent-1', contentHash: `sha256:${memoryCapsuleId}`, authorizationDecisionId: 'decision-1', expiresAt: 100,
        },
      }),
      attachmentIds: [],
    },
  };
}
