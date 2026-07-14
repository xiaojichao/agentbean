import { describe, expect, test } from 'vitest';
import { createSubtaskAcceptanceService } from '../src/application/management/subtask-acceptance-service.js';
import { createSubtaskDeliveryService } from '../src/application/management/subtask-delivery-service.js';
import { createSubtaskEvidenceHarness } from './subtask-evidence-harness.js';

describe('Subtask Acceptance Service', () => {
  test('accepts complete canonical evidence and moves the Task to done', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const delivery = await submitDelivery(harness);
    const messageRef = delivery.evidenceRefs.find((ref) => ref.kind === 'message')!;
    const service = createSubtaskAcceptanceService({
      unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    const result = await service.decide({ authority: harness.authority, idempotencyKey: 'accept-1',
      acceptance: acceptance(delivery.id, messageRef, 'accepted', '验收通过') });
    const replay = await service.decide({ authority: harness.authority, idempotencyKey: 'accept-1',
      acceptance: acceptance(delivery.id, messageRef, 'accepted', '验收通过') });

    expect(result).toMatchObject({ status: 'done', disposition: 'updated' });
    expect(replay).toEqual({ ...result, disposition: 'existing' });
    await expect(harness.repositories.tasks.getById('task-child'))
      .resolves.toMatchObject({ status: 'done' });
    await expect(harness.repositories.taskCoordination.acceptances.getCanonicalByDelivery(delivery.id))
      .resolves.toMatchObject({ decision: 'accepted', canonical: true });
  });

  test('rejects a client digest mismatch before writing an acceptance', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const delivery = await submitDelivery(harness);
    const messageRef = delivery.evidenceRefs.find((ref) => ref.kind === 'message')!;
    const service = createSubtaskAcceptanceService({
      unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    await expect(service.decide({ authority: harness.authority, idempotencyKey: 'accept-tampered',
      acceptance: acceptance(delivery.id, { ...messageRef, snapshotHash: 'client-controlled' },
        'accepted', '验收通过') })).rejects.toThrow('TASK_ACCEPTANCE_CLIENT_DIGEST_MISMATCH');
    await expect(harness.repositories.taskCoordination.acceptances.getCanonicalByDelivery(delivery.id))
      .resolves.toBeNull();
  });

  test('fails closed when evidence drifts after delivery', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const delivery = await submitDelivery(harness);
    const messageRef = delivery.evidenceRefs.find((ref) => ref.kind === 'message')!;
    await harness.repositories.messages.edit({ messageId: 'delivery-message', body: '篡改后的结果',
      meta: { dispatchId: 'dispatch-1' } });
    const service = createSubtaskAcceptanceService({
      unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    await expect(service.decide({ authority: harness.authority, idempotencyKey: 'accept-drift',
      acceptance: acceptance(delivery.id, messageRef, 'accepted', '验收通过') }))
      .rejects.toThrow('TASK_ACCEPTANCE_POLICY_EVIDENCE_SNAPSHOT_DRIFTED');
    await expect(harness.repositories.tasks.getById('task-child'))
      .resolves.toMatchObject({ status: 'in_review' });
  });

  test('routes high-risk judgment to waiting_for_user instead of accepting it', async () => {
    const harness = await createSubtaskEvidenceHarness();
    const delivery = await submitDelivery(harness);
    const messageRef = delivery.evidenceRefs.find((ref) => ref.kind === 'message')!;
    const service = createSubtaskAcceptanceService({
      unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
      clock: harness.clock, ids: harness.ids });
    const result = await service.decide({ authority: harness.authority, idempotencyKey: 'accept-risk',
      acceptance: acceptance(delivery.id, messageRef, 'needs_human', 'HIGH_RISK_JUDGMENT') });
    expect(result.status).toBe('in_review');
    await expect(harness.repositories.management.runs.getById(harness.run.id))
      .resolves.toMatchObject({ status: 'waiting_for_user' });
    const events = await harness.repositories.management.events.list(harness.run.id);
    expect(events.at(-1)?.event).toMatchObject({ type: 'waiting-for-user',
      payload: { reasonCode: 'HIGH_RISK_JUDGMENT' } });
  });
});

async function submitDelivery(harness: Awaited<ReturnType<typeof createSubtaskEvidenceHarness>>) {
  const service = createSubtaskDeliveryService({ unitOfWork: harness.repositories.taskCoordinationUnitOfWork,
    clock: harness.clock, ids: harness.ids });
  return (await service.submit(harness.deliveryInput)).delivery;
}

function acceptance(deliveryId: string,
  evidenceRef: Awaited<ReturnType<typeof submitDelivery>>['evidenceRefs'][number],
  decision: 'accepted' | 'needs_human', reason: string) {
  return { schemaVersion: 1 as const, taskId: 'task-child', deliveryId,
    expectedTaskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-child', decision,
    criteriaResults: [{ criterionId: 'criterion-child', passed: true,
      evidenceRefs: [evidenceRef] }], reason, decidedBy: 'manager' as const, decidedAt: 20 };
}
