import { describe, expect, test } from 'vitest';

import { createInMemoryRepositories } from '../src/index';
import {
  createSendMessageCommandHandler,
  issueReadCandidate,
} from '../src/application/message-tracer-handlers.js';
import { parseMessageTracerCommandResponseV1, type ReadCandidateTokenV1 } from '@agentbean/contracts';

// #921 切片 C-send：send-message handler 集成测试（内存 repos + coordination UoW）。
// 覆盖幂等三层（replay/conflict/timeout 查询）、freshness_hold、rejected（篡改/跨 recipient）、
// 四类 targetKind 投影、自身消息排除、不建 coordination Job、outbox 入队。

const SESSION_SECRET = 'test-message-tracer-secret';
const NOW = 1_700_000_000_000;

interface Harness {
  readonly repos: ReturnType<typeof createInMemoryRepositories>;
  readonly handle: ReturnType<typeof createSendMessageCommandHandler>;
  readonly delivered: number;
}

function setup(): Harness {
  const repos = createInMemoryRepositories();
  let counter = 0;
  let delivered = 0;
  const handle = createSendMessageCommandHandler({
    unitOfWork: repos.channelCoordinationUnitOfWork,
    ids: { nextId: () => `id-${++counter}` },
    clock: { now: () => NOW },
    sessionSecret: SESSION_SECRET,
    deliverOutbox: () => { delivered += 1; },
  });
  return { repos, handle, get delivered() { return delivered; } } as Harness;
}

async function seedChannel(
  repos: ReturnType<typeof createInMemoryRepositories>,
  input: { id: string; kind: 'channel' | 'direct'; humanMemberIds: string[]; agentMemberIds: string[]; dmTargetAgentId?: string },
): Promise<void> {
  if (!(await repos.teams.getById('team-1'))) {
    await repos.teams.create({ id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  }
  await repos.channels.create({
    id: input.id,
    teamId: 'team-1',
    kind: input.kind,
    name: input.id,
    visibility: 'public',
    createdBy: 'user-1',
    createdAt: 1,
    humanMemberIds: input.humanMemberIds,
    agentMemberIds: input.agentMemberIds,
    dmTargetAgentId: input.dmTargetAgentId,
  });
}

function envelope(idempotencyKey: string) {
  return { schemaVersion: 1, commandName: 'send-message' as const, commandSchemaVersion: 1, idempotencyKey };
}

function sendPayload(overrides: Record<string, unknown> = {}) {
  return {
    channelId: 'channel-1',
    senderKind: 'human' as const,
    body: 'hello',
    freshnessBasis: {
      schemaVersion: 1,
      target: { schemaVersion: 1, kind: 'channel-mainline' as const, channelId: 'channel-1' },
    },
    ...overrides,
  };
}

function readCandidate(input: { recipientId: string; channelId: string; threadId?: string; targetSeq: number; kind: 'channel-mainline' | 'thread' | 'dm' | 'dm-thread' }): ReadCandidateTokenV1 {
  return issueReadCandidate({
    recipientId: input.recipientId,
    target: { schemaVersion: 1, kind: input.kind, channelId: input.channelId, threadId: input.threadId },
    targetSeq: input.targetSeq,
    issuedAt: NOW,
    secret: SESSION_SECRET,
  });
}

describe('send-message command handler', () => {
  test('applied：原子提交 Message+Inbox+receipt+tombstone+outbox，不建 Job，自身排除', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: ['agent-1'] });

    const res = await handle({ envelope: envelope('k-1'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });

    expect(res.outcome).toBe('applied');
    expect(res.retryDirective).toBe('none');
    expect(res.result?.commandName).toBe('send-message');
    expect(res.receipt?.outcome).toBe('applied');
    // 受众 = 全成员 − 发送者；自身 user-1 不入自身 inbox
    expect([...(res.result?.inboxItemRecipientIds ?? [])].sort()).toEqual(['agent-1', 'user-2']);
    expect(res.result?.targetSeq).toBe(0);

    // inbox 投影落库（user-2 / agent-1 各一条，user-1 无）
    await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      const user2 = await tx.inbox.listItems({ recipientId: 'user-2', channelId: 'channel-1', threadId: null, afterSeq: -1, limit: 10 });
      const user1 = await tx.inbox.listItems({ recipientId: 'user-1', channelId: 'channel-1', threadId: null, afterSeq: -1, limit: 10 });
      expect(user2).toHaveLength(1);
      expect(user1).toHaveLength(0);
      // outbox 恰好一条 pending
      const pending = await tx.outbox.listPending({ limit: 10 });
      expect(pending).toHaveLength(1);
      expect(pending[0].eventKind).toBe('message-delivered');
    });
    // 不建 coordination Job
    expect(await repos.channelCoordination.jobs.listByChannel('channel-1', 10)).toHaveLength(0);
  });

  test('replay：同 key+hash 返回首次 receipt，不重复写 Message/Inbox/outbox', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    const first = await handle({ envelope: envelope('k-replay'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    const second = await handle({ envelope: envelope('k-replay'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });

    expect(second.outcome).toBe('replayed');
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
    // replay 按 ADR-0067 携带首次 receipt 的 V1 投影（不含存储字段 resultJson/teamId/createdAt），
    // 不重发 result（result 属 applied）；receipt.resultAvailable 标识结果是否可恢复。
    expect(second.result).toBeUndefined();
    expect(second.receipt?.resultAvailable).toBe(true);
    // V1 投影不得泄漏存储字段（exact-key 解析器会拒收）
    expect(second.receipt).not.toHaveProperty('resultJson');
    expect(second.receipt).not.toHaveProperty('teamId');

    // 仍只一条 inbox / 一条 outbox（未双写）
    await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      const items = await tx.inbox.listItems({ recipientId: 'user-2', channelId: 'channel-1', threadId: null, afterSeq: -1, limit: 10 });
      expect(items).toHaveLength(1);
      expect(await tx.outbox.listPending({ limit: 10 })).toHaveLength(1);
    });
  });

  test('conflict：同 key 异 hash 无副作用（不写 Message/Inbox/outbox）', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    await handle({ envelope: envelope('k-conflict'), payload: sendPayload({ body: 'first' }), senderId: 'user-1', teamId: 'team-1' });
    const second = await handle({ envelope: envelope('k-conflict'), payload: sendPayload({ body: 'different' }), senderId: 'user-1', teamId: 'team-1' });

    expect(second.outcome).toBe('conflict');
    expect(second.retryDirective).toBe('reread_then_new_command');
    expect(second.conflictReason).toBeTruthy();

    await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      // 仅首次写了一条 inbox / 一条 outbox
      const items = await tx.inbox.listItems({ recipientId: 'user-2', channelId: 'channel-1', threadId: null, afterSeq: -1, limit: 10 });
      expect(items).toHaveLength(1);
      expect(await tx.outbox.listPending({ limit: 10 })).toHaveLength(1);
    });
  });

  test('timeout→查询：getReceiptByIdempotencyKey 返回首次 receipt（outcome_unknown 收敛）', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    const applied = await handle({ envelope: envelope('k-timeout'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    // 模拟客户端 timeout：用原 key 查 receipt
    const fetched = await repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.commandReceipts.getReceiptByIdempotencyKey('k-timeout'));
    expect(fetched?.receiptId).toBe(applied.receipt?.receiptId);
    expect(fetched?.commandHash).toBe(applied.receipt?.commandHash);
  });

  test('freshness_hold：readCandidate 落后于当前水位 → 不写 Message，携带新 candidate', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    // user-2 发两条 → user-1 收到 inbox seq 0、1（currentMax=1）
    await handle({ envelope: envelope('k-a'), payload: sendPayload(), senderId: 'user-2', teamId: 'team-1' });
    await handle({ envelope: envelope('k-b'), payload: sendPayload({ body: 'second' }), senderId: 'user-2', teamId: 'team-1' });

    // user-1 带陈旧 readCandidate(targetSeq=0) 发送 → hold
    const rc = readCandidate({ recipientId: 'user-1', channelId: 'channel-1', targetSeq: 0, kind: 'channel-mainline' });
    const res = await handle({
      envelope: envelope('k-hold'),
      payload: sendPayload({ body: 'stale', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, readCandidate: rc } }),
      senderId: 'user-1',
      teamId: 'team-1',
    });

    expect(res.outcome).toBe('freshness_hold');
    expect(res.retryDirective).toBe('same_key');
    expect(res.heldTarget?.channelId).toBe('channel-1');
    expect(res.newReadCandidate?.targetSeq).toBe(1); // 推到当前水位
    expect(res.newReadCandidate?.recipientId).toBe('user-1');

    // 未写 Message：outbox 仍只有 user-2 那两条
    await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      expect(await tx.outbox.listPending({ limit: 10 })).toHaveLength(2);
    });
  });

  test('rejected：篡改 proof 的 readCandidate 被拒，无副作用', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    const tampered: ReadCandidateTokenV1 = {
      ...readCandidate({ recipientId: 'user-1', channelId: 'channel-1', targetSeq: 0, kind: 'channel-mainline' }),
      proof: 'tampered-invalid-proof',
    };
    const res = await handle({
      envelope: envelope('k-reject'),
      payload: sendPayload({ freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, readCandidate: tampered } }),
      senderId: 'user-1',
      teamId: 'team-1',
    });

    expect(res.outcome).toBe('rejected');
    expect(res.retryDirective).toBe('reread_then_new_command');
    await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      expect(await tx.outbox.listPending({ limit: 10 })).toHaveLength(0);
    });
  });

  test('rejected：跨 recipient 的 readCandidate 被拒（token 不得挪用）', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    // candidate 绑定 user-2，但发送者是 user-1
    const rc = readCandidate({ recipientId: 'user-2', channelId: 'channel-1', targetSeq: 0, kind: 'channel-mainline' });
    const res = await handle({
      envelope: envelope('k-cross'),
      payload: sendPayload({ freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, readCandidate: rc } }),
      senderId: 'user-1',
      teamId: 'team-1',
    });
    expect(res.outcome).toBe('rejected');
  });

  test('四类 targetKind 投影：channel-mainline / thread / dm / dm-thread', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });
    await seedChannel(repos, { id: 'dm-1', kind: 'direct', humanMemberIds: ['user-1'], agentMemberIds: ['agent-1'], dmTargetAgentId: 'agent-1' });

    const mainline = await handle({ envelope: envelope('k-m'), payload: sendPayload({ channelId: 'channel-1' }), senderId: 'user-1', teamId: 'team-1' });
    const thread = await handle({ envelope: envelope('k-t'), payload: sendPayload({ channelId: 'channel-1', threadId: 'th-1' }), senderId: 'user-1', teamId: 'team-1' });
    const dm = await handle({ envelope: envelope('k-d'), payload: sendPayload({ channelId: 'dm-1', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'dm', channelId: 'dm-1' } } }), senderId: 'user-1', teamId: 'team-1' });
    const dmThread = await handle({ envelope: envelope('k-dt'), payload: sendPayload({ channelId: 'dm-1', threadId: 'dth-1', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'dm-thread', channelId: 'dm-1', threadId: 'dth-1' } } }), senderId: 'user-1', teamId: 'team-1' });

    const targetKinds = await repos.channelCoordinationUnitOfWork.run(async (tx) => {
      const pending = await tx.outbox.listPending({ limit: 10 });
      return pending.map((p) => p.targetKind).sort();
    });
    expect(targetKinds).toEqual(['channel-mainline', 'dm', 'dm-thread', 'thread']);
    // DM 的受众是对方 agent（user-1 发 → agent-1 收）
    expect([...(dm.result?.inboxItemRecipientIds ?? [])]).toEqual(['agent-1']);
    // mainline 与 thread 在同 channel 独立成序（各 seq 0）
    expect(mainline.result?.targetSeq).toBe(0);
    expect(thread.result?.targetSeq).toBe(0);
  });

  test('deliverOutbox 在 applied 后被调用，其他 outcome 不调用', async () => {
    const h = setup();
    await seedChannel(h.repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    await h.handle({ envelope: envelope('k-deliver-1'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    expect(h.delivered).toBe(1);
    // replay 不再调用
    await h.handle({ envelope: envelope('k-deliver-1'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    expect(h.delivered).toBe(1);
  });

  test('channel_not_found → rejected（非 conflict；conflict 专指同 key 异 hash）', async () => {
    const { handle } = setup();
    // 不 seed 任何频道
    const res = await handle({ envelope: envelope('k-nosuch'), payload: sendPayload({ channelId: 'no-such-channel' }), senderId: 'user-1', teamId: 'team-1' });
    expect(res.outcome).toBe('rejected');
    expect(res.retryDirective).toBe('reread_then_new_command');
    expect(res.stableCode).toBe('CHANNEL_NOT_FOUND');
  });

  test('wire-conformance：applied/replay/hold/rejected 响应都能被 contracts 解析器重新解析（无存储字段泄漏）', async () => {
    const { repos, handle } = setup();
    await seedChannel(repos, { id: 'channel-1', kind: 'channel', humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [] });

    const applied = await handle({ envelope: envelope('k-w1'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    const replayed = await handle({ envelope: envelope('k-w1'), payload: sendPayload(), senderId: 'user-1', teamId: 'team-1' });
    const conflict = await handle({ envelope: envelope('k-w1'), payload: sendPayload({ body: 'other' }), senderId: 'user-1', teamId: 'team-1' });

    // 各 outcome 的响应必须能通过 exact-key 解析器（含嵌套 receipt 的白名单校验），否则 wire 边界会炸。
    expect(() => parseMessageTracerCommandResponseV1(applied)).not.toThrow();
    expect(() => parseMessageTracerCommandResponseV1(replayed)).not.toThrow();
    expect(() => parseMessageTracerCommandResponseV1(conflict)).not.toThrow();
  });
});
