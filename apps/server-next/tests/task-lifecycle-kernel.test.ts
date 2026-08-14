import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createTaskCoordinationKernel } from '../src/application/management/task-coordination-kernel.js';
import { createTaskLifecycleKernel, type TaskLifecycleKernelDependencies } from '../src/application/management/task-lifecycle-kernel.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type {
  TaskLifecycleCommandEnvelopeV1,
  TaskLifecycleCommandInputMapV1,
} from '../../../packages/contracts/src/index.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

type Authority = { managementRunId: string; workerId: string; leaseToken: string; fencingToken: number };

/**
 * #926 Task lifecycle kernel 测试：覆盖 10 个 command handler 的 happy path、
 * 幂等 replay、idempotency conflict、precondition 失败与 terminal immutability。
 * 用 memory + sqlite 双 fixture（与 task-coordination-kernel.test.ts 同款）。
 */

let idemSeq = 0;
function nextIdem(): string { idemSeq += 1; return `lifecycle-idem-${idemSeq}`; }
function makeEnvelope(commandName: TaskLifecycleCommandEnvelopeV1['commandName']): TaskLifecycleCommandEnvelopeV1 {
  return { schemaVersion: 1, commandName, commandSchemaVersion: 1, idempotencyKey: nextIdem() };
}

describe.each([
  ['memory', () => ({ repositories: createInMemoryRepositories(), close() {} })],
  ['sqlite', () => {
    const globalDb = new Database(':memory:');
    const teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    return {
      repositories: createSqliteRepositories({ globalDb, teamDb }),
      close: () => {
        globalDb.close();
        teamDb.close();
      },
    };
  }],
] as const)('Task Lifecycle Kernel (%s)', (_name, createFixture) => {
  test('transition-task-in-progress: root todo → in_progress', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const r = await h.lifecycle.transitionTaskInProgress(
        makeEnvelope('transition-task-in-progress'),
        { taskId: 'root-task', expectedTaskRevision: 1 },
        h.authority, 'pi_driver', 'team-1',
      );
      expect(r.result.status).toBe('in_progress');
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress');
    } finally { fixture.close(); }
  });

  test('transition-task-in-progress rejects non-todo root', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      // in_review（非 todo）→ validateTransition allowed，但 status !== 'todo' → TASK_NOT_TODO
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      await expect(h.lifecycle.transitionTaskInProgress(
        makeEnvelope('transition-task-in-progress'),
        { taskId: 'root-task', expectedTaskRevision: 1 },
        h.authority, 'pi_driver', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_TASK_NOT_TODO' });
    } finally { fixture.close(); }
  });

  test('start-execution records start without changing status', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_progress', updatedAt: 100 } });
      // 需要 claim
      const claim = await fixture.repositories.taskCoordination.claimLeases.create({
        id: 'claim-exec', teamId: 'team-1', taskId: 'root-task', taskRevision: 1, taskAttempt: 1,
        agentId: 'agent-1', leaseTokenHash: 'h', leaseFingerprint: 'f', fencingToken: 1,
        status: 'active', acquiredAt: 10, heartbeatAt: 10, expiresAt: 1000,
      });
      const r = await h.lifecycle.startExecution(
        makeEnvelope('start-execution'),
        { taskId: 'root-task', expectedTaskRevision: 1, claimLeaseId: claim.id },
        h.authority, 'agent', 'team-1',
      );
      expect(r.result.startedAt).toBe(100);
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress'); // 不改 status
    } finally { fixture.close(); }
  });

  test('cancel-task: todo → cancelled', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const r = await h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'not needed' },
        h.authority, 'admin', 'team-1',
      );
      expect(r.result.status).toBe('cancelled');
      expect(r.result.cancelledSubtaskIds).toEqual([]);
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('cancelled');
    } finally { fixture.close(); }
  });

  test('cancel-task rejects terminal task (done)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'done', updatedAt: 100 } });
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_ALREADY_TERMINAL' });
    } finally { fixture.close(); }
  });

  test('close-task: admin only', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      // human 不能 close
      await expect(h.lifecycle.closeTask(
        makeEnvelope('close-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'human', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REQUIRES_ADMIN' });
      // admin 可以
      const r = await h.lifecycle.closeTask(
        makeEnvelope('close-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'admin close' },
        h.authority, 'admin', 'team-1',
      );
      expect(r.result.status).toBe('closed');
    } finally { fixture.close(); }
  });

  test('idempotent replay: same envelope+input returns same result', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const env = makeEnvelope('cancel-task');
      const input: TaskLifecycleCommandInputMapV1['cancel-task'] = { taskId: 'root-task', expectedTaskRevision: 1, reason: 'dup' };
      const first = await h.lifecycle.cancelTask(env, input, h.authority, 'admin', 'team-1');
      const second = await h.lifecycle.cancelTask(env, input, h.authority, 'admin', 'team-1');
      expect(second.result).toEqual(first.result);
    } finally { fixture.close(); }
  });

  test('idempotency conflict: same key, different input', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      const env = makeEnvelope('cancel-task');
      await h.lifecycle.cancelTask(env, { taskId: 'root-task', expectedTaskRevision: 1, reason: 'a' }, h.authority, 'admin', 'team-1');
      await expect(h.lifecycle.cancelTask(
        env, { taskId: 'root-task', expectedTaskRevision: 1, reason: 'different' },
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_COMMAND_IDEMPOTENCY_CONFLICT' });
    } finally { fixture.close(); }
  });

  test('authority check: agent cannot cancel', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'x' },
        h.authority, 'agent', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REQUIRES_REQUESTER_OR_ADMIN' });
    } finally { fixture.close(); }
  });

  test('revision fencing: stale revision rejected', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await expect(h.lifecycle.cancelTask(
        makeEnvelope('cancel-task'),
        { taskId: 'root-task', expectedTaskRevision: 5, reason: 'stale' }, // 实际 revision=1
        h.authority, 'admin', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_FUTURE_REVISION' });
    } finally { fixture.close(); }
  });

  test('accept-root-delivery: human accepts in_review root → done', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      await fixture.repositories.management.runs.update({ ...(await fixture.repositories.management.runs.getByRootTaskId('root-task'))!, status: 'in_review', updatedAt: 100 });
      const r = await h.lifecycle.acceptRootDelivery(
        makeEnvelope('accept-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, deliveryMessageId: 'msg-1' },
        h.authority, 'human', 'team-1',
      );
      expect(r.result.status).toBe('done');
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('done');
    } finally { fixture.close(); }
  });

  test('#1196: accept-subtask requires every package-backed current version to be approved', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.create({
        id: 'subtask-package', teamId: 'team-1', title: 'Package-backed subtask',
        description: 'deliver one reviewed file', status: 'in_review', creatorId: 'user-1',
        channelId: 'channel-1', tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
      });
      await fixture.repositories.taskCoordination.coordinations.create({
        schemaVersion: 1,
        taskId: 'subtask-package', teamId: 'team-1', taskRevision: 1,
        managementRunId: 'run-1', rootTaskId: 'root-task', parentTaskId: 'root-task',
        nodeKind: 'subtask', reviewPolicy: 'human', claimPolicy: 'open',
        requiredCapabilities: [], maxAttempts: 1, attempt: 1,
        humanAcceptanceAuthorityIds: ['worker-1'], createdAt: 1, updatedAt: 1,
      });
      await fixture.repositories.taskCoordination.claimLeases.create({
        id: 'claim-subtask-package', teamId: 'team-1', taskId: 'subtask-package',
        taskRevision: 1, taskAttempt: 1, agentId: 'agent-1', leaseTokenHash: 'claim-hash',
        leaseFingerprint: 'claim-fingerprint', fencingToken: 1, status: 'active',
        acquiredAt: 10, heartbeatAt: 10, expiresAt: 1_000,
      });
      await fixture.repositories.management.invocations.create({
        schemaVersion: 1,
        id: 'invocation-subtask-package', managementRunId: 'run-1',
        intent: {
          schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1',
          targetAgentId: 'agent-1', targetKind: 'custom', objective: 'deliver package',
          taskContext: {
            taskId: 'subtask-package', rootTaskId: 'root-task', taskRevision: 1,
            taskAttempt: 1, claimLeaseId: 'claim-subtask-package',
          },
          acceptanceCriteria: [], dependencyResults: [], attachmentIds: [],
        },
        intentHash: 'intent-subtask-package', idempotencyKey: 'invocation-subtask-package', createdAt: 20,
      });
      await fixture.repositories.taskCoordination.deliveries.create({
        schemaVersion: 1,
        id: 'delivery-subtask-package', teamId: 'team-1', taskId: 'subtask-package',
        taskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-subtask-package',
        invocationId: 'invocation-subtask-package', summary: 'package delivered', claims: [],
        evidenceRefs: [], idempotencyKey: 'delivery-subtask-package', createdAt: 30,
      });
      await fixture.repositories.artifacts.create({
        id: 'artifact-subtask-package', teamId: 'team-1', channelId: 'channel-1',
        uploaderId: 'agent-1', filename: 'report.md', mimeType: 'text/markdown',
        sizeBytes: 12, pathKind: 'workspace', createdAt: 30,
      });
      const formed = await fixture.repositories.outputPackages.recordPackageFormation({
        record: {
          teamId: 'team-1', packageId: 'package-subtask', channelId: 'channel-1',
          // coordination delivery 与 OutputPackage delivery 是独立事实，不能依赖 ID 相等关联。
          deliveryId: 'output-package-delivery-subtask', publishId: 'publish-subtask-package',
          workspaceRevisionId: 'workspace-revision-subtask-package', agentId: 'agent-1',
          taskId: 'subtask-package', taskBinding: 'managed', taskRevision: 1, taskAttempt: 1,
          memberCount: 1, status: 'recorded', createdAt: 30,
        },
        members: [{
          sequence: 1, shortLabel: 'F1', role: 'deliverable', requiredForFinal: true,
          sourcePath: 'out/report.md', filename: 'report.md', sizeBytes: 12,
          collection: {
            mode: 'create', collectionId: 'collection-subtask-package',
            name: 'out/report.md', kind: 'deliverable',
          },
          version: {
            id: 'version-subtask-package', artifactId: 'artifact-subtask-package',
            taskId: 'subtask-package', taskRevision: 1,
          },
        }],
        receipt: {
          receiptId: 'receipt-subtask-package', teamId: 'team-1',
          commandName: 'record-agent-output-package', commandSchemaVersion: 1,
          idempotencyKey: 'record-agent-output-package:channel-1:publish-subtask-package',
          commandHash: 'package-subtask-hash', outcome: 'applied', committedRevisions: [],
          eventRefs: [], commitTime: 30, resultAvailable: true, createdAt: 30,
        },
        tombstone: {
          id: 'tombstone-subtask-package', teamId: 'team-1',
          commandName: 'record-agent-output-package',
          idempotencyKey: 'record-agent-output-package:channel-1:publish-subtask-package',
          commandHash: 'package-subtask-hash', receiptId: 'receipt-subtask-package',
          outcome: 'applied', resultAvailable: true, createdAt: 30,
        },
      });
      expect(formed.kind).toBe('created');

      const acceptance: TaskLifecycleCommandInputMapV1['accept-subtask']['acceptance'] = {
        schemaVersion: 1, taskId: 'subtask-package', deliveryId: 'delivery-subtask-package',
        expectedTaskRevision: 1, taskAttempt: 1, claimLeaseId: 'claim-subtask-package',
        decision: 'accepted', criteriaResults: [], reason: '文件审核完成',
        decidedBy: 'human', decidedAt: 40,
      };
      await expect(h.lifecycle.acceptSubtask(
        makeEnvelope('accept-subtask'), { acceptance }, h.authority, 'human', 'team-1',
      )).rejects.toMatchObject({ code: 'TASK_LIFECYCLE_REQUIRED_FILE_REVIEWS_INCOMPLETE' });
      await expect(fixture.repositories.tasks.getById('subtask-package'))
        .resolves.toMatchObject({ status: 'in_review' });
      await expect(fixture.repositories.taskCoordination.acceptances.getCanonicalByDelivery('delivery-subtask-package'))
        .resolves.toBeNull();

      await fixture.repositories.channelProjects.appendArtifactReview({
        review: {
          id: 'review-subtask-package', teamId: 'team-1', channelId: 'channel-1',
          collectionId: 'collection-subtask-package', versionId: 'version-subtask-package',
          decision: 'approved', comment: '通过', authorityBasis: 'root-review-authority',
          basis: [], reviewedBy: 'worker-1', createdAt: 50,
        },
        mutation: {
          teamId: 'team-1', channelId: 'channel-1',
          idempotencyKey: 'review-subtask-package', requestFingerprint: 'review-subtask-package',
          kind: 'review', collectionId: 'collection-subtask-package',
          versionId: 'version-subtask-package', reviewId: 'review-subtask-package', createdAt: 50,
        },
      });
      await expect(h.lifecycle.acceptSubtask(
        makeEnvelope('accept-subtask'), { acceptance }, h.authority, 'human', 'team-1',
      )).resolves.toMatchObject({ result: { status: 'done' } });
      await expect(fixture.repositories.tasks.getById('subtask-package'))
        .resolves.toMatchObject({ status: 'done' });
      await expect(fixture.repositories.taskCoordination.acceptances.getCanonicalByDelivery('delivery-subtask-package'))
        .resolves.toMatchObject({ decision: 'accepted', canonical: true });
    } finally { fixture.close(); }
  });

  test('reject-root-delivery: human rejects in_review root → in_progress (new revision)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_review', updatedAt: 100 } });
      const run = await fixture.repositories.management.runs.getByRootTaskId('root-task');
      await fixture.repositories.management.runs.update({ ...run!, status: 'in_review', updatedAt: 100 });
      const r = await h.lifecycle.rejectRootDelivery(
        makeEnvelope('reject-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, reason: 'needs rework' },
        h.authority, 'human', 'team-1',
      );
      expect(r.result.status).toBe('in_progress');
      expect(r.result.taskRevision).toBe(2); // revision bumped
      const task = await fixture.repositories.tasks.getById('root-task');
      expect(task?.status).toBe('in_progress');
      expect(task?.revision).toBe(2);
    } finally { fixture.close(); }
  });

  test('submit-root-delivery rejects when no subtasks (readiness)', async () => {
    const fixture = createFixture();
    try {
      const h = await createHarness(fixture.repositories);
      await fixture.repositories.tasks.update({ taskId: 'root-task', changes: { status: 'in_progress', updatedAt: 100 } });
      // 无 subtask → readiness 失败
      await expect(h.lifecycle.submitRootDelivery(
        makeEnvelope('submit-root-delivery'),
        { taskId: 'root-task', expectedTaskRevision: 1, messageId: 'msg-1', contributingInvocationIds: [] },
        h.authority, 'pi_driver', 'team-1',
      )).rejects.toMatchObject({ code: 'MANAGEMENT_ROOT_DELIVERY_SUBTASKS_REQUIRED' });
    } finally { fixture.close(); }
  });
});

// ---------------------------------------------------------------------------
// Test harness（复用 task-coordination-kernel.test.ts 的 setup 模式）
// ---------------------------------------------------------------------------

async function createHarness(repositories: ServerNextRepositories) {
  let id = 0;
  const clock = { now: () => 100 };
  const ids = { nextId: () => id++ === 0 ? 'run-1' : `lc-${id}` };
  await repositories.users.create({
    id: 'user-1', username: 'owner', role: 'user', passwordHash: 'unused',
    createdAt: 1, updatedAt: 1,
  });
  await repositories.teams.create({
    id: 'team-1', name: 'Team', path: 'team', visibility: 'private',
    ownerId: 'user-1', createdAt: 1,
  });
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-1', username: 'owner', role: 'owner', joinedAt: 1,
  });
  await repositories.agents.upsert({
    id: 'agent-1', primaryTeamId: 'team-1', visibleTeamIds: ['team-1'], name: 'Agent',
    adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online',
  });
  await repositories.channels.create({
    id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general',
    visibility: 'public', createdBy: 'user-1', humanMemberIds: ['user-1'],
    agentMemberIds: ['agent-1'], createdAt: 1,
  });
  await repositories.tasks.create({
    id: 'root-task', teamId: 'team-1', title: 'Root', description: 'root objective',
    status: 'todo', creatorId: 'user-1', channelId: 'channel-1',
    tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
  });
  const managementKernel = createManagementKernel({
    repositories: repositories.management, unitOfWork: repositories.managementUnitOfWork,
    clock, ids,
  });
  await managementKernel.createOrResumeRun({
    teamId: 'team-1', channelId: 'channel-1', rootTaskId: 'root-task',
    rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'request-hash',
    placementPolicy: { placement: 'device' as const, allowServerContext: false, requireLocalModelCredentials: true },
    budget: { maxSubtasks: 4, maxDepth: 2, maxExternalInvocations: 4 },
  });
  await managementKernel.acquireLease({
    managementRunId: 'run-1', workerId: 'worker-1',
    host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'lease-token', ttlMs: 1_000,
  });
  const authority: Authority = { managementRunId: 'run-1', workerId: 'worker-1', leaseToken: 'lease-token', fencingToken: 1 };

  // bootstrap root coordination（lifecycle handler 需要 coordination 记录）
  // 用 createRootCoordination（manager lease 授权），与 task-coordination-kernel.test.ts 同款
  const coordKernel = createTaskCoordinationKernel({ unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids });
  await coordKernel.createRootCoordination({
    authority, idempotencyKey: 'root-coordination', taskId: 'root-task',
    claimPolicy: 'open' as const, requiredCapabilities: [],
    acceptanceCriteria: [{ id: 'criterion-root', description: 'root done', evidenceRequired: false }],
    maxAttempts: 1,
    // #1061 AC4：root Human review authority 创建时预绑定（human accept 测试的 actor）。
    humanReviewAuthorityIds: ['worker-1'],
  });

  const lifecycleDeps: TaskLifecycleKernelDependencies = {
    unitOfWork: repositories.taskCoordinationUnitOfWork, clock, ids,
  };

  return {
    authority,
    lifecycle: createTaskLifecycleKernel(lifecycleDeps),
  };
}
