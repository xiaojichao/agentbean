import { describe, expect, test } from 'vitest';

import { createInMemoryRepositories } from '../src/index';
import {
  createAckReadCandidateCommandHandler,
  createCheckInboxCommandHandler,
  createSendMessageCommandHandler,
  issueReadCandidate,
} from '../src/application/message-tracer-handlers.js';
import type { ReadCandidateTokenV1 } from '@agentbean/contracts';

// #921 切片 C-read：check-inbox + ack-read-candidate handler 集成测试。
// 流程：send 投递 → check-inbox 签发 candidate（不推进 boundary）→ ack 推进 boundary（单调、幂等）。

const SESSION_SECRET = 'test-message-tracer-secret';
const NOW = 1_700_000_000_000;

interface Harness {
  readonly repos: ReturnType<typeof createInMemoryRepositories>;
  readonly send: ReturnType<typeof createSendMessageCommandHandler>;
  readonly checkInbox: ReturnType<typeof createCheckInboxCommandHandler>;
  readonly ack: ReturnType<typeof createAckReadCandidateCommandHandler>;
}

function setup(): Harness {
  const repos = createInMemoryRepositories();
  let counter = 0;
  const common = {
    unitOfWork: repos.channelCoordinationUnitOfWork,
    ids: { nextId: () => `id-${++counter}` },
    clock: { now: () => NOW },
    sessionSecret: SESSION_SECRET,
  };
  return {
    repos,
    send: createSendMessageCommandHandler(common),
    checkInbox: createCheckInboxCommandHandler(common),
    ack: createAckReadCandidateCommandHandler(common),
  };
}

async function seedChannel(
  repos: ReturnType<typeof createInMemoryRepositories>,
): Promise<void> {
  if (!(await repos.teams.getById('team-1'))) {
    await repos.teams.create({ id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1 });
  }
  await repos.channels.create({
    id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public',
    createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1', 'user-2'], agentMemberIds: [],
  });
}

function sendEnvelope(key: string) {
  return { schemaVersion: 1, commandName: 'send-message' as const, commandSchemaVersion: 1, idempotencyKey: key };
}
function checkEnvelope(key: string) {
  return { schemaVersion: 1, commandName: 'check-inbox' as const, commandSchemaVersion: 1, idempotencyKey: key };
}
function ackEnvelope(key: string) {
  return { schemaVersion: 1, commandName: 'ack-read-candidate' as const, commandSchemaVersion: 1, idempotencyKey: key };
}

function candidate(input: { recipientId: string; targetSeq: number; kind?: 'channel-mainline' | 'thread' }): ReadCandidateTokenV1 {
  return issueReadCandidate({
    recipientId: input.recipientId,
    target: { schemaVersion: 1, kind: input.kind ?? 'channel-mainline', channelId: 'channel-1' },
    targetSeq: input.targetSeq,
    issuedAt: NOW,
    secret: SESSION_SECRET,
  });
}

describe('check-inbox command handler', () => {
  test('返回连续前缀 + 签发 candidate（audienceScope/asOf），不推进 read boundary', async () => {
    const h = setup();
    await seedChannel(h.repos);
    // user-2 发两条 → user-1 inbox seq 0、1
    await h.send({ envelope: sendEnvelope('s-1'), payload: { channelId: 'channel-1', senderKind: 'human', body: 'a', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });
    await h.send({ envelope: sendEnvelope('s-2'), payload: { channelId: 'channel-1', senderKind: 'human', body: 'b', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });

    const res = await h.checkInbox({
      envelope: checkEnvelope('c-1'),
      payload: { recipientId: 'user-1', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, limit: 10 },
      requesterId: 'user-1',
      teamId: 'team-1',
    });

    expect(res.outcome).toBe('applied');
    expect(res.stableCode).toBe('INBOX_CHECKED');
    const result = res.result;
    expect(result?.commandName).toBe('check-inbox');
    expect(result?.items.map((i) => i.targetSeq)).toEqual([0, 1]);
    expect(result?.items.every((i) => !('body' in i))).toBe(true); // audience redaction：无正文
    expect(result?.readCandidate.targetSeq).toBe(2); // exclusive 下一未读位（maxSeq=1 → 2）
    expect(result?.readCandidate.recipientId).toBe('user-1');
    expect(result?.audienceScope).toBe('recipient:user-1');
    expect(result?.asOf).toBe(NOW);

    // check-inbox 不推进 read boundary
    const boundary = await h.repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.inbox.getReadBoundary({ recipientId: 'user-1', channelId: 'channel-1', threadId: null }));
    expect(boundary).toBeNull();
  });

  test('afterSeq/limit 分页；candidate 仍反映完整水位', async () => {
    const h = setup();
    await seedChannel(h.repos);
    for (let i = 0; i < 3; i++) {
      await h.send({ envelope: sendEnvelope(`s-${i}`), payload: { channelId: 'channel-1', senderKind: 'human', body: `m${i}`, freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });
    }
    const res = await h.checkInbox({
      envelope: checkEnvelope('c-page'),
      payload: { recipientId: 'user-1', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, afterSeq: 0, limit: 1 },
      requesterId: 'user-1',
      teamId: 'team-1',
    });
    expect(res.result?.items.map((i) => i.targetSeq)).toEqual([1]); // 仅 seq>0 的第一条
    expect(res.result?.readCandidate.targetSeq).toBe(3); // exclusive 完整水位（maxSeq=2 → 3）
  });

  test('recipient 不匹配（requesterId ≠ recipientId）→ rejected', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const res = await h.checkInbox({
      envelope: checkEnvelope('c-mismatch'),
      payload: { recipientId: 'user-2', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, limit: 10 },
      requesterId: 'user-1', // 试图查别人的 inbox
      teamId: 'team-1',
    });
    expect(res.outcome).toBe('rejected');
    expect(res.stableCode).toBe('RECIPIENT_MISMATCH');
  });

  test('空 inbox：candidate targetSeq=0（exclusive=未读任何），ack 后 readSeq=0 不静默跳过首条消息', async () => {
    const h = setup();
    await seedChannel(h.repos);
    // user-1 inbox 为空（无人发消息）
    const checked = await h.checkInbox({
      envelope: checkEnvelope('c-empty'),
      payload: { recipientId: 'user-1', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, limit: 10 },
      requesterId: 'user-1', teamId: 'team-1',
    });
    expect(checked.result?.readCandidate.targetSeq).toBe(0); // exclusive：未读任何
    expect(checked.result?.items).toHaveLength(0);

    // ack 空 candidate → readSeq=0（exclusive：未读任何）
    const acked = await h.ack({
      envelope: ackEnvelope('a-empty'),
      payload: { readCandidate: checked.result!.readCandidate },
      requesterId: 'user-1', teamId: 'team-1',
    });
    expect(acked.result?.advancedToSeq).toBe(0);

    // 之后 user-2 发首条消息（seq 0）；readSeq 仍为 0 → 该消息未读（targetSeq 0 >= readSeq 0），不静默跳过
    await h.send({ envelope: sendEnvelope('s-late'), payload: { channelId: 'channel-1', senderKind: 'human', body: 'late', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });
    const boundary = await h.repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.inbox.getReadBoundary({ recipientId: 'user-1', channelId: 'channel-1', threadId: null }));
    expect(boundary?.readSeq).toBe(0); // 仍 0：首条消息未被当成已读
  });

  test('response.commandName 正确（非误报 send-message）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const checked = await h.checkInbox({
      envelope: checkEnvelope('c-name'),
      payload: { recipientId: 'user-1', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, limit: 10 },
      requesterId: 'user-1', teamId: 'team-1',
    });
    expect(checked.commandName).toBe('check-inbox');
  });
});

describe('ack-read-candidate command handler', () => {
  test('推进 read boundary（applied）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    await h.send({ envelope: sendEnvelope('s-1'), payload: { channelId: 'channel-1', senderKind: 'human', body: 'a', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });

    const res = await h.ack({
      envelope: ackEnvelope('a-1'),
      payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 1 }) }, // exclusive：读过 seq 0
      requesterId: 'user-1',
      teamId: 'team-1',
    });
    expect(res.outcome).toBe('applied');
    expect(res.stableCode).toBe('READ_BOUNDARY_ADVANCED');
    expect(res.result?.advancedToSeq).toBe(1);
    expect(res.receipt?.outcome).toBe('applied');

    const boundary = await h.repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.inbox.getReadBoundary({ recipientId: 'user-1', channelId: 'channel-1', threadId: null }));
    expect(boundary?.readSeq).toBe(1);
  });

  test('已到位/回退 → no_op，boundary 不变（单调）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    // 先推进到 5
    await h.ack({ envelope: ackEnvelope('a-up'), payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 5 }) }, requesterId: 'user-1', teamId: 'team-1' });
    // 再 ack 更小的 seq → no_op
    const res = await h.ack({ envelope: ackEnvelope('a-down'), payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 3 }) }, requesterId: 'user-1', teamId: 'team-1' });
    expect(res.outcome).toBe('no_op');
    expect(res.stableCode).toBe('READ_BOUNDARY_NOOP');
    expect(res.result?.advancedToSeq).toBe(5); // 仍是 5
    const boundary = await h.repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.inbox.getReadBoundary({ recipientId: 'user-1', channelId: 'channel-1', threadId: null }));
    expect(boundary?.readSeq).toBe(5);
  });

  test('replay：同 key+hash 返回首次 receipt', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const rc = candidate({ recipientId: 'user-1', targetSeq: 2 });
    const first = await h.ack({ envelope: ackEnvelope('a-rep'), payload: { readCandidate: rc }, requesterId: 'user-1', teamId: 'team-1' });
    const second = await h.ack({ envelope: ackEnvelope('a-rep'), payload: { readCandidate: rc }, requesterId: 'user-1', teamId: 'team-1' });
    expect(second.outcome).toBe('replayed');
    expect(second.receipt?.receiptId).toBe(first.receipt?.receiptId);
  });

  test('rejected：篡改 proof 的 candidate（新 key 到达校验）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const tampered: ReadCandidateTokenV1 = { ...candidate({ recipientId: 'user-1', targetSeq: 0 }), proof: 'tampered' };
    const res = await h.ack({ envelope: ackEnvelope('a-tamper'), payload: { readCandidate: tampered }, requesterId: 'user-1', teamId: 'team-1' });
    expect(res.outcome).toBe('rejected');
    expect(res.stableCode).toBe('READ_CANDIDATE_REJECTED');
  });

  test('rejected：跨 recipient 的 candidate（token 不得挪用）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const res = await h.ack({
      envelope: ackEnvelope('a-cross'),
      payload: { readCandidate: candidate({ recipientId: 'user-2', targetSeq: 0 }) }, // 绑定 user-2
      requesterId: 'user-1', // 但 requester 是 user-1
      teamId: 'team-1',
    });
    expect(res.outcome).toBe('rejected');
  });

  test('端到端：send → check-inbox → ack 推进到 candidate 水位', async () => {
    const h = setup();
    await seedChannel(h.repos);
    await h.send({ envelope: sendEnvelope('e-1'), payload: { channelId: 'channel-1', senderKind: 'human', body: 'hi', freshnessBasis: { schemaVersion: 1, target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' } } }, senderId: 'user-2', teamId: 'team-1' });

    const checked = await h.checkInbox({
      envelope: checkEnvelope('e-c'),
      payload: { recipientId: 'user-1', target: { schemaVersion: 1, kind: 'channel-mainline', channelId: 'channel-1' }, limit: 10 },
      requesterId: 'user-1', teamId: 'team-1',
    });
    // 用 check-inbox 签发的真 candidate 去 ack
    const acked = await h.ack({
      envelope: ackEnvelope('e-a'),
      payload: { readCandidate: checked.result!.readCandidate },
      requesterId: 'user-1', teamId: 'team-1',
    });
    expect(acked.outcome).toBe('applied');
    expect(acked.result?.advancedToSeq).toBe(checked.result!.readCandidate.targetSeq);
  });

  test('过期 token 被拒（issuedAt 超过 maxAge）', async () => {
    const repos = createInMemoryRepositories();
    let counter = 0;
    // clock 返回「未来」时间，使签发于 NOW 的 candidate 看起来过期
    const ack = createAckReadCandidateCommandHandler({
      unitOfWork: repos.channelCoordinationUnitOfWork,
      ids: { nextId: () => `id-${++counter}` },
      clock: { now: () => NOW + 2 * 60 * 60 * 1000 }, // +2h（超过默认 1h maxAge）
      sessionSecret: SESSION_SECRET,
    });
    await seedChannel(repos);
    const res = await ack({
      envelope: ackEnvelope('a-expired'),
      payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 1 }) }, // issuedAt=NOW
      requesterId: 'user-1', teamId: 'team-1',
    });
    expect(res.outcome).toBe('rejected');
    expect(res.stableCode).toBe('READ_CANDIDATE_REJECTED');
    const boundary = await repos.channelCoordinationUnitOfWork.run((tx) =>
      tx.inbox.getReadBoundary({ recipientId: 'user-1', channelId: 'channel-1', threadId: null }));
    expect(boundary).toBeNull(); // 无副作用
  });

  test('response.commandName 正确（applied/no_op/rejected 均 ack-read-candidate）', async () => {
    const h = setup();
    await seedChannel(h.repos);
    const applied = await h.ack({ envelope: ackEnvelope('n-1'), payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 1 }) }, requesterId: 'user-1', teamId: 'team-1' });
    expect(applied.commandName).toBe('ack-read-candidate');
    const noop = await h.ack({ envelope: ackEnvelope('n-2'), payload: { readCandidate: candidate({ recipientId: 'user-1', targetSeq: 0 }) }, requesterId: 'user-1', teamId: 'team-1' });
    expect(noop.commandName).toBe('ack-read-candidate');
  });
});
