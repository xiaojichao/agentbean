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

async function seedRootMessage(
  repositories: ServerNextRepositories,
  messageId: string,
  overrides?: { channelId?: string; teamId?: string },
): Promise<void> {
  await repositories.messages.append({
    id: messageId,
    teamId: overrides?.teamId ?? 'team-1',
    channelId: overrides?.channelId ?? 'channel-1',
    senderKind: 'human',
    senderId: 'user-1',
    body: `promote source ${messageId}`,
    createdAt: tick,
  });
}

/** 为 input 解析出的 root Message 预置消息（message lineage 或显式 rootMessageId）。 */
async function seedForInput(
  repositories: ServerNextRepositories,
  input: PromoteInput,
): Promise<void> {
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
    const handler = makeHandler(repositories);

    // 不 seed 消息
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-missing-msg' }),
      makeInput({
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-missing' } },
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

    await seedRootMessage(repositories, 'msg-other-channel', { channelId: 'channel-other' });
    const response = await handler.promoteToTask(
      makeEnvelope({ idempotencyKey: 'idem-scope' }),
      makeInput({
        channelId: 'channel-1',
        freshnessBasis: { schemaVersion: 1, sourceLineage: { kind: 'message', id: 'msg-other-channel' } },
      }),
    );

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
    expect(tasks).toHaveLength(0);
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
});
