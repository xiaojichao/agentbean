import { describe, expect, test } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createTaskLifecycleKernel } from '../src/application/management/task-lifecycle-kernel.js';
import { createServerNextUseCases } from '../src/application/usecases.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';

/**
 * #995：根交付人审 accept/reject 接线。
 * - accept/reject 走 lifecycle kernel（human authority）
 * - updateTask 对 managed root 旁路 done/rework 被拒绝
 */

describe('root-delivery review wiring (#995)', () => {
  test('acceptRootDelivery 将 in_review root 置为 done', async () => {
    const harness = await createReviewHarness();
    const accepted = await harness.app.acceptRootDelivery({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'root-task',
      deliveryMessageId: 'msg-delivery',
    });
    expect(accepted).toMatchObject({ ok: true, task: { id: 'root-task', status: 'done' } });
    await expect(harness.repositories.tasks.getById('root-task')).resolves.toMatchObject({ status: 'done' });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({
      status: 'completed',
    });
  });

  test('rejectRootDelivery 提升 revision 并回到 in_progress', async () => {
    const harness = await createReviewHarness();
    const rejected = await harness.app.rejectRootDelivery({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'root-task',
      reason: '需要补充证据',
    });
    expect(rejected).toMatchObject({
      ok: true,
      task: { id: 'root-task', status: 'in_progress', revision: 2 },
    });
    await expect(harness.repositories.management.runs.getById(harness.runId)).resolves.toMatchObject({
      status: 'running',
    });
  });

  test('reject 缺少 reason 时 VALIDATION_ERROR', async () => {
    const harness = await createReviewHarness();
    await expect(harness.app.rejectRootDelivery({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'root-task',
      reason: '   ',
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
  });

  test('updateTask 不能旁路 accept/reject managed root', async () => {
    const harness = await createReviewHarness();
    await expect(harness.app.updateTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'root-task',
      status: 'done',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('accept-root-delivery'),
    });
    await expect(harness.app.updateTask({
      userId: 'user-1',
      teamId: 'team-1',
      taskId: 'root-task',
      status: 'in_progress',
    })).resolves.toMatchObject({
      ok: false,
      error: 'CONFLICT',
      message: expect.stringContaining('reject-root-delivery'),
    });
    await expect(harness.repositories.tasks.getById('root-task')).resolves.toMatchObject({
      status: 'in_review',
      revision: 1,
    });
  });

  test('非成员禁止 accept/reject', async () => {
    const harness = await createReviewHarness();
    await expect(harness.app.acceptRootDelivery({
      userId: 'outsider',
      teamId: 'team-1',
      taskId: 'root-task',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(harness.app.rejectRootDelivery({
      userId: 'outsider',
      teamId: 'team-1',
      taskId: 'root-task',
      reason: 'nope',
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});

async function createReviewHarness() {
  const repositories = createInMemoryRepositories();
  let n = 0;
  const clock = { now: () => 1_000 };
  const ids = { nextId: () => (n++ === 0 ? 'run-1' : `id-${n}`) };

  await repositories.users.create({
    id: 'user-1', username: 'owner', passwordHash: 'x', createdAt: 1,
  });
  await repositories.users.create({
    id: 'outsider', username: 'out', passwordHash: 'x', createdAt: 1,
  });
  await repositories.teams.create({
    id: 'team-1', name: 'Team', ownerId: 'user-1', createdAt: 1,
  });
  await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-1', role: 'owner', joinedAt: 1 });
  await repositories.channels.create({
    id: 'channel-1', teamId: 'team-1', name: 'general', visibility: 'public', createdAt: 1,
  });
  await repositories.tasks.create({
    id: 'root-task',
    teamId: 'team-1',
    title: 'Root review',
    status: 'todo',
    creatorId: 'user-1',
    channelId: 'channel-1',
    tags: [],
    sortOrder: 0,
    createdAt: 1,
    updatedAt: 1,
  });

  let mgmtId = 0;
  const managementKernel = createManagementKernel({
    repositories: repositories.management,
    unitOfWork: repositories.managementUnitOfWork,
    clock,
    ids: { nextId: () => (mgmtId++ === 0 ? 'run-1' : `mgmt-${mgmtId}`) },
  });
  const created = await managementKernel.createOrResumeRun({
    teamId: 'team-1',
    channelId: 'channel-1',
    rootTaskId: 'root-task',
    rootMessageId: 'msg-root',
    requestKey: 'request-1',
    requestHash: 'request-hash',
    placementPolicy: {
      placement: 'device',
      allowServerContext: false,
      requireLocalModelCredentials: true,
    },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  const runId = created.run.id;
  await managementKernel.acquireLease({
    managementRunId: runId,
    workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' },
    leaseToken: 'lease-token',
    ttlMs: 1_000,
  });
  const authority = {
    managementRunId: runId,
    workerId: 'worker-1',
    leaseToken: 'lease-token',
    fencingToken: 1,
  };
  const taskCoordinationKernel = createTaskCoordinationKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  await taskCoordinationKernel.createRootCoordination({
    authority,
    idempotencyKey: 'root-coordination',
    taskId: 'root-task',
    claimPolicy: 'open' as const,
    requiredCapabilities: [],
    acceptanceCriteria: [{ id: 'criterion-root', description: 'root done', evidenceRequired: false }],
    maxAttempts: 1,
    // #1061 AC4：root Human review authority 创建时预绑定（验收人为 user-1）。
    humanReviewAuthorityIds: ['user-1'],
  });

  await repositories.tasks.update({
    taskId: 'root-task',
    changes: { status: 'in_review', updatedAt: 10 },
  });
  const run = await repositories.management.runs.getById(runId);
  if (!run) throw new Error('expected run');
  await repositories.management.runs.update({
    ...run,
    status: 'in_review',
    updatedAt: 10,
  });

  const taskLifecycleKernel = createTaskLifecycleKernel({
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock,
    ids,
  });
  const app = createServerNextUseCases({
    repositories,
    clock,
    ids,
    managementKernel,
    taskCoordinationKernel,
    taskLifecycleKernel,
  });

  return { app, repositories, runId };
}
