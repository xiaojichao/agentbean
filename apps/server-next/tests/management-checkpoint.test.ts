import { describe, expect, test } from 'vitest';
import { createManagementCheckpointService, collectManagementCheckpointFacts, restoreOrRebuildManagementCheckpoint } from '../src/application/management/management-checkpoint.js';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';

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
    intent: { schemaVersion: 1 as const, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1', targetKind: 'custom' as const, objective: id, acceptanceCriteria: [], dependencyResults: [], ...(memoryCapsuleId && { memoryCapsuleId }), attachmentIds: [] },
  };
}
