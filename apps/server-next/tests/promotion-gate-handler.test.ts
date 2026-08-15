import { describe, expect, test } from 'vitest';

import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createPromotionGateHandler } from '../src/application/promotion-gate-handler.js';
import type { TaskCoordinationUnitOfWork } from '../src/application/task-coordination-unit-of-work.js';
import type { TaskCoordinationTransactionRepositories } from '../src/application/task-coordination-unit-of-work.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';
import type {
  PromotionGateCommandEnvelopeV1,
  PromotionGateCommandInputMapV1,
  PromotionObjectiveSnapshotV1,
} from '../../../packages/contracts/src/index.js';

// #922 Promotion gate handler 测试套件。
// 用 in-memory repositories + 内建 taskCoordinationUnitOfWork（含 snapshot/restore 回滚），
// 覆盖幂等 replay / idempotency conflict / convergence / lineage 冲突 / 原子回滚 / 不推进 todo /
// 非-human-trigger / root Message 校验 / 真实 management event 引用。

let idSeq = 0;
let idemSeq = 0;
let msgSeq = 0;
let tick = 1_000;

function resetCounters(): void {
  idSeq = 0;
  idemSeq = 0;
  msgSeq = 0;
  tick = 1_000;
}

function nextId(): string {
  idSeq += 1;
  return `id-${idSeq}`;
}

function makeEnvelope(overrides?: Partial<PromotionGateCommandEnvelopeV1>): PromotionGateCommandEnvelopeV1 {
  idemSeq += 1;
  return {
    schemaVersion: 1,
    commandName: 'promote-to-task',
    commandSchemaVersion: 1,
    idempotencyKey: `idem-${idemSeq}`,
    ...overrides,
  };
}

type PromoteInput = PromotionGateCommandInputMapV1['promote-to-task'];
type ContinuationInput = PromotionGateCommandInputMapV1['create-task-continuation'];

function objective(
  overrides?: Partial<PromotionObjectiveSnapshotV1>,
): PromotionObjectiveSnapshotV1 {
  return {
    schemaVersion: 1,
    objective: '构建用户管理后台',
    scope: 'team-1:channel-1',
    riskLevel: 'low',
    ...overrides,
  };
}

function makeInput(overrides?: Partial<PromoteInput>): PromoteInput {
  return {
    triggerKind: 'human-structured',
    channelId: 'channel-1',
    objectiveSnapshot: objective(),
    freshnessBasis: {
      schemaVersion: 1,
      sourceLineage: { kind: 'message', id: `msg-${++msgSeq}` },
    },
    ...overrides,
  };
}

async function seedChannel(
  repositories: ServerNextRepositories,
  overrides?: {
    id?: string;
    teamId?: string;
    visibility?: 'public' | 'private';
    humanMemberIds?: string[];
    archivedAt?: number | null;
  },
): Promise<void> {
  const id = overrides?.id ?? 'channel-1';
  if (await repositories.channels.getById(id)) return;
  await repositories.channels.create({
    id,
    teamId: overrides?.teamId ?? 'team-1',
    kind: 'channel',
    name: id,
    title: id,
    visibility: overrides?.visibility ?? 'private',
    humanMemberIds: overrides?.humanMemberIds ?? ['user-1'],
    agentMemberIds: [],
    createdAt: tick,
    updatedAt: tick,
    ...(overrides?.archivedAt != null ? { archivedAt: overrides.archivedAt } : {}),
  });
}

async function seedRootMessage(
  repositories: ServerNextRepositories,
  messageId: string,
  overrides?: { channelId?: string; teamId?: string; meta?: Record<string, unknown> },
): Promise<void> {
  await seedChannel(repositories, { id: overrides?.channelId ?? 'channel-1' });
  await repositories.messages.append({
    id: messageId,
    teamId: overrides?.teamId ?? 'team-1',
    channelId: overrides?.channelId ?? 'channel-1',
    senderKind: 'human',
    senderId: 'user-1',
    body: `promote source ${messageId}`,
    createdAt: tick,
    ...(overrides?.meta ? { meta: overrides.meta } : {}),
  });
}

/** 为 input 解析出的 root Message 预置消息（message lineage 或显式 rootMessageId）。 */
async function seedForInput(
  repositories: ServerNextRepositories,
  input: PromoteInput,
): Promise<void> {
  await seedChannel(repositories, { id: input.channelId });
  const rootMessageId = input.rootMessageId
    ?? (input.freshnessBasis.sourceLineage.kind === 'message'
      ? input.freshnessBasis.sourceLineage.id
      : undefined);
  if (rootMessageId) {
    await seedRootMessage(repositories, rootMessageId, { channelId: input.channelId });
  }
}

function makeHandler(repositories: ServerNextRepositories) {
  return createPromotionGateHandler({
    teamId: 'team-1',
    requesterId: 'user-1',
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock: { now: () => (tick += 100) },
    ids: { nextId },
  });
}

function makeContinuationHandler(
  repositories: ServerNextRepositories,
  currentVersionIds: readonly string[] | null = ['version-1'],
) {
  return createPromotionGateHandler({
    teamId: 'team-1',
    requesterId: 'user-1',
    unitOfWork: repositories.taskCoordinationUnitOfWork,
    clock: { now: () => (tick += 100) },
    ids: { nextId },
    resolveContinuationVersionIdsInTransaction: async () => currentVersionIds,
  });
}

async function seedTerminalTaskContinuation(
  repositories: ServerNextRepositories,
  status: 'done' | 'cancelled' | 'closed' | 'in_progress' = 'done',
): Promise<{
  handler: ReturnType<typeof makeContinuationHandler>;
  input: ContinuationInput;
  sourceTaskId: string;
}> {
  const rootMessageId = 'continuation-root-message';
  await seedRootMessage(repositories, rootMessageId);
  const handler = makeContinuationHandler(repositories);
  const promoted = await handler.promoteToTask(
    makeEnvelope({ idempotencyKey: 'seed-continuation-root' }),
    makeInput({
      rootMessageId,
      freshnessBasis: {
        schemaVersion: 1,
        sourceLineage: { kind: 'message', id: rootMessageId },
      },
    }),
  );
  const sourceTaskId = promoted.result!.rootTaskId;
  const sourceTask = await repositories.tasks.updateAtRevision({
    taskId: sourceTaskId,
    expectedRevision: 1,
    nextRevision: 2,
    reasonCode: 'test-terminal-transition',
    changes: { status, updatedAt: tick += 100 },
  });
  if (!sourceTask) throw new Error('TEST_SOURCE_TASK_MISSING');
  await repositories.messages.append({
    id: 'continuation-source-message',
    teamId: 'team-1',
    channelId: 'channel-1',
    threadId: rootMessageId,
    senderKind: 'human',
    senderId: 'user-1',
    body: '请基于当前交付继续完善移动端适配',
    createdAt: tick += 100,
    meta: {
      taskContinuationSource: {
        schemaVersion: 1,
        sourceTaskId,
        sourceTaskRevision: sourceTask.revision,
      },
    },
  });
  return {
    handler,
    sourceTaskId,
    input: {
      channelId: 'channel-1',
      rootMessageId,
      sourceMessageId: 'continuation-source-message',
      sourceTaskId,
      sourceTaskRevision: sourceTask.revision,
      sourceVersionIds: ['version-1'],
      objectiveSnapshot: objective({ objective: '请基于当前交付继续完善移动端适配' }),
    },
  };
}

describe('#922 Promotion gate handler', () => {
  test('同 idempotencyKey + 同内容 → replayed，返回首次 receipt/result', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const env = makeEnvelope({ idempotencyKey: 'idem-same' });
    const input = makeInput();
    await seedForInput(repositories, input);

    const first = await handler.promoteToTask(env, input);
    expect(first.outcome).toBe('applied');
    expect(first.stableCode).toBe('PROMOTION_APPLIED');
    expect(first.result?.disposition).toBe('created');
    const firstTaskId = first.result?.rootTaskId;
    const firstReceiptId = first.receipt?.receiptId;

    // 第二次：同 key 同内容 → replayed
    const replayed = await handler.promoteToTask(env, input);
    expect(replayed.outcome).toBe('replayed');
    expect(replayed.stableCode).toBe('PROMOTION_REPLAYED');
    expect(replayed.receipt?.receiptId).toBe(firstReceiptId);
    expect(replayed.result?.rootTaskId).toBe(firstTaskId);
    expect(replayed.result?.disposition).toBe('created');

    // 只写了一个 Task
    const receiptCount = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(receiptCount).toHaveLength(1);
  });

  test('同 idempotencyKey + 异内容 → conflict，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const env = makeEnvelope({ idempotencyKey: 'idem-conflict' });
    const inputA = makeInput({ objectiveSnapshot: objective({ objective: '任务 A' }) });
    await seedForInput(repositories, inputA);
    const first = await handler.promoteToTask(env, inputA);
    expect(first.outcome).toBe('applied');

    // 同 key 异内容 → conflict（不需要新 root Message，不会创建）
    const inputB = makeInput({ objectiveSnapshot: objective({ objective: '任务 B' }) });
    const conflicted = await handler.promoteToTask(env, inputB);
    expect(conflicted.outcome).toBe('conflict');
    expect(conflicted.stableCode).toBe('PROMOTION_CONFLICT');
    expect(conflicted.conflictReason).toBe('idempotency-key-hash-mismatch');
    expect(conflicted.receipt).toBeUndefined();
    expect(conflicted.result).toBeUndefined();

    // 无新 Task 被创建
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
  });

  test('不同 idempotencyKey + 同 lineage + 同 snapshot → replayed/converged，返回同一 root Task', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const lineage = { kind: 'message' as const, id: 'msg-shared' };
    const snap = objective();
    await seedRootMessage(repositories, 'msg-shared');

    const first = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-1' }),
      makeInput({ freshnessBasis: { schemaVersion: 1, sourceLineage: lineage }, objectiveSnapshot: snap }),
    );
    expect(first.outcome).toBe('applied');
    const firstTaskId = first.result?.rootTaskId;
    const firstRunId = first.result?.managementRunId;
    const firstRelationId = first.result?.sourceRelationId;

    // 不同 key + 同 lineage + 同 snapshot → converged → replayed, no_op receipt
    const second = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-2' }),
      makeInput({ freshnessBasis: { schemaVersion: 1, sourceLineage: lineage }, objectiveSnapshot: snap }),
    );
    expect(second.outcome).toBe('replayed');
    expect(second.stableCode).toBe('PROMOTION_REPLAYED');
    expect(second.result?.rootTaskId).toBe(firstTaskId);
    expect(second.result?.managementRunId).toBe(firstRunId);
    expect(second.result?.sourceRelationId).toBe(firstRelationId);
    expect(second.result?.disposition).toBe('existing');
    expect(second.receipt?.outcome).toBe('no_op');

    // 只有一个 Task（收敛到同一 root）
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
    expect(tasks[0].id).toBe(firstTaskId);
  });

  test('不同 lineage → 各自 applied（两个不同 Task）', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const inputA = makeInput({
      freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-lineage-A' } },
    });
    const inputB = makeInput({
      freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-lineage-B' } },
    });
    await seedForInput(repositories, inputA);
    await seedForInput(repositories, inputB);

    const first = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-A' }),
      inputA,
    );
    expect(first.outcome).toBe('applied');
    expect(first.result?.disposition).toBe('created');

    const second = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-B' }),
      inputB,
    );
    expect(second.outcome).toBe('applied');
    expect(second.result?.disposition).toBe('created');
    expect(second.result?.rootTaskId).not.toBe(first.result?.rootTaskId);

    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(2);
  });

  test('同 lineage + 异 snapshot → conflict，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const sourceLineage = { kind: 'message' as const, id: 'msg-conflict-lineage' };
    await seedRootMessage(repositories, 'msg-conflict-lineage');

    const first = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-first' }),
      makeInput({
        freshnessBasis: { schemaVersion: 1, sourceLineage },
        objectiveSnapshot: objective({ objective: '原始目标' }),
      }),
    );
    expect(first.outcome).toBe('applied');

    // 同 lineage + 异 snapshot → conflict
    const second = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-second' }),
      makeInput({
        freshnessBasis: { schemaVersion: 1, sourceLineage },
        objectiveSnapshot: objective({ objective: '冲突目标' }),
      }),
    );
    expect(second.outcome).toBe('conflict');
    expect(second.stableCode).toBe('PROMOTION_CONFLICT');
    expect(second.conflictReason).toBe('different-objective-snapshot');
    expect(second.receipt).toBeUndefined();

    // 无新 Task
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
  });

  test('原子回滚：receipts.createReceipt 抛错后无孤立 Task/relation/receipt', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();

    // 包装 unitOfWork，在 receipts.createReceipt 注入抛错
    const throwingUnitOfWork: TaskCoordinationUnitOfWork = {
      run(operation) {
        return repositories.taskCoordinationUnitOfWork.run(async (repos) => {
          const patched: TaskCoordinationTransactionRepositories = {
            ...repos,
            promotion: {
              ...repos.promotion,
              receipts: {
                ...repos.promotion.receipts,
                async createReceipt() {
                  throw new Error('INJECTED_RECEIPT_FAILURE');
                },
              },
            },
          };
          return operation(patched);
        });
      },
    };

    const generatedIds: string[] = [];
    const handler = createPromotionGateHandler({
      teamId: 'team-1',
      requesterId: 'user-1',
      unitOfWork: throwingUnitOfWork,
      clock: { now: () => (tick += 100) },
      ids: {
        nextId() {
          const id = nextId();
          generatedIds.push(id);
          return id;
        },
      },
    });

    const env = makeEnvelope({ idempotencyKey: 'idem-rollback' });
    const input = makeInput({
      freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-rollback' } },
    });
    await seedForInput(repositories, input);

    await expect(handler.promoteToTask(env, input)).rejects.toThrow('INJECTED_RECEIPT_FAILURE');

    // handler 执行顺序：taskId=generatedIds[0], managementRunId=generatedIds[1], sourceRelationId=generatedIds[2]
    const taskId = generatedIds[0];
    const managementRunId = generatedIds[1];

    // 无孤立 Task
    expect(await repositories.tasks.getById(taskId)).toBeNull();
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);

    // 无孤立 source relation
    const lineageKey = 'team-1:message:msg-rollback';
    // source relation 存在 promotion memory state 中，通过 unitOfWork 事务访问
    await repositories.taskCoordinationUnitOfWork.run(async (repos) => {
      expect(await repos.promotion.sourceRelations.getByLineageKey(lineageKey)).toBeNull();
      expect(await repos.promotion.receipts.getReceiptByIdempotencyKey('idem-rollback')).toBeNull();
    });

    // 无孤立 management run
    expect(await repositories.management.runs.getById(managementRunId)).toBeNull();
  });

  test('不推进 todo：applied 后 root Task status === todo', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const input = makeInput();
    await seedForInput(repositories, input);
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-todo' }),
      input,
    );
    expect(response.outcome).toBe('applied');

    const task = await repositories.tasks.getById(response.result!.rootTaskId);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('todo');
    expect(task!.creatorId).toBe('user-1');
    expect(task!.title).toBe('构建用户管理后台');
  });

  test('非-human-trigger → rejected', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const input = makeInput();
    // envelope exact-key 校验会先拒非登记 trigger，这里直接测 handler 用 as-never 绕过 TS 走纯函数
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-rejected' }),
      { ...input, triggerKind: 'agent-escalation' as never },
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('PROMOTION_REJECTED');
    expect(response.retryDirective).toBe('user_action');
    expect(response.receipt).toBeUndefined();

    // 无副作用
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);
  });

  test('root Message 不存在 → rejected，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    await seedChannel(repositories);
    const handler = makeHandler(repositories);

    // 不 seed 消息；频道存在但消息缺失
    // 注意：missing message 在 freshness 阶段先判 source-changed → freshness_hold
    // 为落到 ROOT_MESSAGE_NOT_FOUND，用显式 rootMessageId 指向不存在的消息，
    // 且 lineage 指向现存消息以通过 freshness。
    await seedRootMessage(repositories, 'msg-lineage-ok');
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-missing-msg' }),
      makeInput({
        rootMessageId: 'msg-missing',
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-lineage-ok' } },
      }),
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('PROMOTION_ROOT_MESSAGE_NOT_FOUND');
    expect(response.receipt).toBeUndefined();
    expect(response.result).toBeUndefined();

    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);
  });

  test('root Message 跨频道 → rejected，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    await seedChannel(repositories, { id: 'channel-1' });
    await seedChannel(repositories, { id: 'channel-other' });
    await seedRootMessage(repositories, 'msg-other-channel', { channelId: 'channel-other' });
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-scope' }),
      makeInput({
        channelId: 'channel-1',
        rootMessageId: 'msg-other-channel',
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-other-channel' } },
      }),
    );

    // lineage 消息在 channel-other：freshness 不看 channel；root message scope 在 applied 前校验
    // 但 source message 属于不同 channel 仍 team 内存在 → freshness ok；rootMessage scope 失败
    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('PROMOTION_ROOT_MESSAGE_SCOPE_MISMATCH');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);
  });

  test('非 message lineage 且缺 rootMessageId → rejected', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    await seedChannel(repositories);
    // task lineage 无真实 task → freshness source-changed；先创建一个 task 让 freshness 通过
    await repositories.tasks.create({
      id: 'task-source-1',
      teamId: 'team-1',
      title: 'source',
      status: 'todo',
      creatorId: 'user-1',
      channelId: 'channel-1',
      tags: [],
      sortOrder: 0,
      createdAt: tick,
      updatedAt: tick,
    });
    const handler = makeHandler(repositories);

    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-unresolved' }),
      makeInput({
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'task', id: 'task-source-1' },
        },
      }),
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('PROMOTION_ROOT_MESSAGE_UNRESOLVED');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    // 仅 seed 的 source task，无 promotion 新建
    expect(tasks).toHaveLength(1);
    expect(tasks[0]!.id).toBe('task-source-1');
  });

  test('applied 持久化可读取的 management run-started 事件，eventRefs 非悬空', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const input = makeInput({
      freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-event' } },
    });
    await seedForInput(repositories, input);

    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-event' }),
      input,
    );
    expect(response.outcome).toBe('applied');
    expect(response.receipt?.eventRefs).toHaveLength(1);
    const eventRef = response.receipt!.eventRefs[0]!;
    expect(eventRef.streamKind).toBe('management-run');
    expect(eventRef.streamId).toBe(response.result!.managementRunId);
    expect(eventRef.sequence).toBe(1);

    const events = await repositories.management.events.list(response.result!.managementRunId);
    expect(events).toHaveLength(1);
    expect(events[0]!.event.type).toBe('run-started');
    expect(events[0]!.event.sequence).toBe(eventRef.sequence);
    expect(events[0]!.event.payload).toMatchObject({
      rootMessageId: 'msg-event',
      rootTaskId: response.result!.rootTaskId,
      mode: 'managed',
    });

    // run.rootMessageId 指向真实消息
    const run = await repositories.management.runs.getById(response.result!.managementRunId);
    expect(run?.rootMessageId).toBe('msg-event');
    expect(await repositories.messages.getById('msg-event')).not.toBeNull();
  });

  test('response 结构可被 parsePromotionGateCommandResponseV1 验通过（合同 conformance）', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const handler = makeHandler(repositories);

    const input = makeInput();
    await seedForInput(repositories, input);
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-parse' }),
      input,
    );

    // 引入 contracts runtime parser 验证 response 结构完全合规
    const { parsePromotionGateCommandResponseV1 } = await import('../../../packages/contracts/src/index.js');
    expect(() => parsePromotionGateCommandResponseV1(response)).not.toThrow();
    const parsed = parsePromotionGateCommandResponseV1(response);
    expect(parsed.schemaVersion).toBe(1);
    expect(parsed.commandName).toBe('promote-to-task');
    expect(parsed.outcome).toBe('applied');
  });

  test('private 频道非成员 → rejected CHANNEL_FORBIDDEN，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    await seedChannel(repositories, {
      id: 'channel-private',
      visibility: 'private',
      humanMemberIds: ['other-user'],
    });
    await seedRootMessage(repositories, 'msg-private', { channelId: 'channel-private' });

    const handler = makeHandler(repositories);
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-forbidden' }),
      makeInput({
        channelId: 'channel-private',
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-private' } },
      }),
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('PROMOTION_CHANNEL_FORBIDDEN');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-private'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);
  });

  test('来源消息已删除 → freshness_hold，无副作用', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    await seedRootMessage(repositories, 'msg-deleted', {
      meta: { deletedAt: tick },
    });
    const handler = makeHandler(repositories);

    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-freshness-deleted' }),
      makeInput({
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-deleted' } },
      }),
    );

    expect(response.outcome).toBe('freshness_hold');
    expect(response.stableCode).toBe('PROMOTION_FRESHNESS_HOLD');
    expect(response.freshnessReason).toBe('source-changed');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(0);
  });

  test('sourceRevision 落后于 message.meta.revision → freshness_hold', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    await seedRootMessage(repositories, 'msg-rev', {
      meta: { revision: 3 },
    });
    const handler = makeHandler(repositories);

    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-freshness-rev' }),
      makeInput({
        freshnessBasis: {
          schemaVersion: 1,
          sourceLineage: { kind: 'message', id: 'msg-rev' },
          sourceRevision: 1,
        },
      }),
    );

    expect(response.outcome).toBe('freshness_hold');
    expect(response.freshnessReason).toBe('source-revision-advanced');
  });

  test('终态 root Task + 已发送 thread 消息 → 创建全新 root Task，并固化来源依据', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const seeded = await seedTerminalTaskContinuation(repositories);
    const envelope = makeEnvelope({
      commandName: 'create-task-continuation',
      idempotencyKey: 'continuation-create',
    });

    const response = await seeded.handler.createTaskContinuation(envelope, seeded.input);

    expect(response.outcome).toBe('applied');
    expect(response.stableCode).toBe('TASK_CONTINUATION_CREATED');
    expect(response.result?.rootTaskId).not.toBe(seeded.sourceTaskId);
    const sourceTask = await repositories.tasks.getById(seeded.sourceTaskId);
    const continuationTask = await repositories.tasks.getById(response.result!.rootTaskId);
    expect(sourceTask?.status).toBe('done');
    expect(continuationTask?.status).toBe('todo');
    expect(continuationTask?.revision).toBe(1);

    await repositories.taskCoordinationUnitOfWork.run(async (repos) => {
      const relation = await repos.promotion.sourceRelations.getByLineageKey(
        'team-1:message:continuation-source-message',
      );
      expect(relation).toMatchObject({
        relationKind: 'task-continuation',
        sourceTaskId: seeded.sourceTaskId,
        sourceTaskRevision: seeded.input.sourceTaskRevision,
        sourceVersionIdsJson: JSON.stringify(['version-1']),
      });
    });

    const replayed = await seeded.handler.createTaskContinuation(envelope, seeded.input);
    expect(replayed.outcome).toBe('replayed');
    expect(replayed.result?.rootTaskId).toBe(response.result?.rootTaskId);
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(2);
  });

  test('非终态、过期 revision 或过期版本依据均 fail closed，且不创建后续 Task', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const seeded = await seedTerminalTaskContinuation(repositories, 'in_progress');
    const envelope = makeEnvelope({
      commandName: 'create-task-continuation',
      idempotencyKey: 'continuation-invalid',
    });

    const nonTerminal = await seeded.handler.createTaskContinuation(envelope, seeded.input);
    expect(nonTerminal.outcome).toBe('rejected');
    expect(nonTerminal.stableCode).toBe('TASK_CONTINUATION_SOURCE_INVALID');

    const terminalTask = await repositories.tasks.updateAtRevision({
      taskId: seeded.sourceTaskId,
      expectedRevision: seeded.input.sourceTaskRevision,
      nextRevision: seeded.input.sourceTaskRevision + 1,
      reasonCode: 'test-terminal-transition',
      changes: { status: 'done', updatedAt: tick += 100 },
    });
    expect(terminalTask).not.toBeNull();
    const staleRevision = await seeded.handler.createTaskContinuation(
      makeEnvelope({ commandName: 'create-task-continuation', idempotencyKey: 'continuation-stale-revision' }),
      seeded.input,
    );
    expect(staleRevision.outcome).toBe('freshness_hold');
    expect(staleRevision.stableCode).toBe('TASK_CONTINUATION_SOURCE_STALE');

    await repositories.messages.append({
      id: 'continuation-source-message-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      threadId: seeded.input.rootMessageId,
      senderKind: 'human',
      senderId: 'user-1',
      body: '请按当前 revision 继续',
      createdAt: tick += 100,
      meta: {
        taskContinuationSource: {
          schemaVersion: 1,
          sourceTaskId: seeded.sourceTaskId,
          sourceTaskRevision: terminalTask!.revision,
        },
      },
    });
    const staleVersions = await seeded.handler.createTaskContinuation(
      makeEnvelope({ commandName: 'create-task-continuation', idempotencyKey: 'continuation-stale-versions' }),
      {
        ...seeded.input,
        sourceMessageId: 'continuation-source-message-current',
        sourceTaskRevision: terminalTask!.revision,
        sourceVersionIds: ['version-old'],
      },
    );
    expect(staleVersions.outcome).toBe('freshness_hold');
    expect(staleVersions.stableCode).toBe('TASK_CONTINUATION_VERSIONS_STALE');

    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
  });

  test('普通 thread human 消息未携带 Server 固化来源标记时 fail closed', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const seeded = await seedTerminalTaskContinuation(repositories);
    await repositories.messages.updateMeta({
      messageId: seeded.input.sourceMessageId,
      meta: {},
    });

    const response = await seeded.handler.createTaskContinuation(
      makeEnvelope({ commandName: 'create-task-continuation', idempotencyKey: 'continuation-unmarked-source' }),
      seeded.input,
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('TASK_CONTINUATION_SOURCE_INVALID');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
  });

  test('原讨论串根消息已删除时 fail closed，不创建后续 Task', async () => {
    resetCounters();
    const repositories = createInMemoryRepositories();
    const seeded = await seedTerminalTaskContinuation(repositories);
    const rootMessage = await repositories.messages.getById(seeded.input.rootMessageId);
    expect(rootMessage).not.toBeNull();
    await repositories.messages.softDelete({
      messageId: seeded.input.rootMessageId,
      body: '消息已删除',
      meta: { ...(rootMessage!.meta ?? {}), deletedAt: tick += 100, deletedBy: 'user-1' },
    });

    const response = await seeded.handler.createTaskContinuation(
      makeEnvelope({ commandName: 'create-task-continuation', idempotencyKey: 'continuation-deleted-root' }),
      seeded.input,
    );

    expect(response.outcome).toBe('rejected');
    expect(response.stableCode).toBe('TASK_CONTINUATION_THREAD_MISMATCH');
    const tasks = await repositories.tasks.list({
      teamId: 'team-1',
      channelIds: ['channel-1'],
      includeGlobal: true,
    });
    expect(tasks).toHaveLength(1);
  });
});
