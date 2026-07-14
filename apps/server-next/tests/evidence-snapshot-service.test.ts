import { describe, expect, test } from 'vitest';
import { createEvidenceSnapshotService } from '../src/application/management/evidence-snapshot-service.js';
import { createSubtaskEvidenceHarness } from './subtask-evidence-harness.js';

describe('Evidence Snapshot Service', () => {
  test('resolves visible sources and stores only Server-canonical hashes', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const service = createEvidenceSnapshotService({ ids: harness.ids });
    const captured = await harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
      service.capture(repositories, { teamId: 'team-1', channelId: 'channel-1',
        managementRunId: harness.run.id, taskId: 'task-child', taskRevision: 1,
        taskAttempt: 1, claimLeaseId: 'claim-child', invocationId: 'invocation-1' },
      harness.deliveryInput.locators, harness.clock.now()));

    expect(captured.refs.map((ref) => ref.kind)).toEqual([
      'message', 'artifact', 'workspace-run', 'invocation', 'task',
    ]);
    expect(captured.refs.every((ref) => /^[a-f0-9]{64}$/.test(ref.snapshotHash))).toBe(true);
    expect(captured.snapshots.find((snapshot) => snapshot.kind === 'artifact')?.snapshot)
      .not.toHaveProperty('storagePath');
  });

  test('fails closed for a hidden source and for a non-current successful Invocation', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const service = createEvidenceSnapshotService({ ids: harness.ids });
    const authority = { teamId: 'team-1', channelId: 'channel-1',
      managementRunId: harness.run.id, taskId: 'task-child', taskRevision: 1,
      taskAttempt: 1, claimLeaseId: 'claim-child', invocationId: 'invocation-1' };
    await expect(harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
      service.capture(repositories, authority,
        [{ kind: 'artifact', id: 'artifact-private' }], harness.clock.now())))
      .rejects.toThrow('EVIDENCE_SOURCE_NOT_VISIBLE');

    await harness.repositories.management.dispatchAttempts.create({ id: 'attempt-2',
      invocationId: 'invocation-1', dispatchId: 'dispatch-2', attemptNumber: 2,
      status: 'queued', startedAt: 20 });
    await expect(harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
      service.capture(repositories, authority,
        [{ kind: 'message', id: 'delivery-message' }], harness.clock.now())))
      .rejects.toThrow('EVIDENCE_INVOCATION_NOT_CURRENT_SUCCEEDED');
  });

  test('detects drift by re-resolving the current source instead of trusting the stored digest', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const service = createEvidenceSnapshotService({ ids: harness.ids });
    const authority = { teamId: 'team-1', channelId: 'channel-1',
      managementRunId: harness.run.id, taskId: 'task-child', taskRevision: 1,
      taskAttempt: 1, claimLeaseId: 'claim-child', invocationId: 'invocation-1' };
    const captured = await harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
      service.capture(repositories, authority,
        [{ kind: 'message', id: 'delivery-message' }], harness.clock.now()));
    await harness.repositories.messages.edit({ messageId: 'delivery-message', body: '结果已被修改',
      meta: { dispatchId: 'dispatch-1' } });
    const fact = await harness.repositories.taskCoordinationUnitOfWork.run((repositories) =>
      service.inspect(repositories, authority, captured.refs[0]!));
    expect(fact).toMatchObject({ available: true, visible: true });
    expect(fact.currentSnapshotHash).not.toBe(captured.refs[0]!.snapshotHash);
  });
});
