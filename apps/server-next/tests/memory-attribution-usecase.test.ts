import { describe, expect, test } from 'vitest';

import { createServerNextUseCases } from '../src/application/usecases';
import { createInMemoryRepositories } from '../src/index';
import type {
  ChannelCoordinationDecisionRecord,
  ActiveMemoryAttributionDto,
} from '../../../packages/contracts/src/index.js';

/**
 * #965 AC#4：Active Memory 来源归因的读取授权。
 *
 * 归因（memoryAttribution）由 Coordinator 在解析时计算并持久化到 coordination decision
 * （migration 0041）。本测试覆盖把它向「有权用户」暴露的 usecase 接缝：
 * - 授权成员可读到归因；
 * - 非成员 / 跨 Team / 私有频道非成员 / 不存在的 decision 一律 fail-closed 返回 null
 *   （不泄露归因的存在，也不泄露其他 scope 的正文）。
 */

const ATTRIBUTION: ActiveMemoryAttributionDto = {
  schemaVersion: 1,
  contextHash: 'sha256:abc',
  entries: [
    { id: 'mem-1', source: 'team_formal_memory', selectionReason: 'current_team_policy' },
    { id: 'mem-2', source: 'channel_formal_memory', selectionReason: 'current_channel_context' },
  ],
};

function makeDecision(overrides: Partial<ChannelCoordinationDecisionRecord>): ChannelCoordinationDecisionRecord {
  return {
    id: 'decision-1',
    jobId: 'job-1',
    teamId: 'team-1',
    channelId: 'channel-1',
    messageId: 'message-1',
    outcome: 'resolved',
    intent: 'no_action',
    reasonCode: 'no_action',
    replyText: null,
    usage: { inputTokens: 10, outputTokens: 5 },
    pinnedModel: { cardId: 'card-1', revisionId: 'rev-1', availability: 'available' },
    responseModel: 'pi-test-model',
    diagnosticCode: null,
    attempt: 1,
    systemMessageId: null,
    gateStatus: 'applied',
    riskLevel: null,
    objective: null,
    targetAgentId: null,
    linkedTaskId: null,
    blockingReason: null,
    supersededByDecisionId: null,
    memoryAttribution: ATTRIBUTION,
    idempotencyKey: 'idem-1',
    createdAt: 1,
    updatedAt: 1,
    ...overrides,
  };
}

async function setup() {
  const repos = createInMemoryRepositories();
  const clock = { now: () => 1000 };
  const ids = { nextId: (() => { let n = 0; return () => `id-${++n}`; })() };
  const app = createServerNextUseCases({ repositories: repos, clock, ids });

  // team-1 + 成员 user-1 + 公共频道 channel-1。
  await repos.users.create({
    id: 'user-1', username: 'alice', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1,
  });
  await repos.teams.create({
    id: 'team-1', name: 'Team 1', path: 'team-1', visibility: 'private', ownerId: 'user-1', createdAt: 1,
  });
  await repos.teams.addMember({
    teamId: 'team-1', userId: 'user-1', username: 'alice', role: 'owner', joinedAt: 1,
  });
  await repos.channels.create({
    id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'general', visibility: 'public',
    createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: [],
  });

  // team-2 + 成员 user-2（跨 Team，不应看到 team-1 的归因）。
  await repos.users.create({
    id: 'user-2', username: 'bob', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1,
  });
  await repos.teams.create({
    id: 'team-2', name: 'Team 2', path: 'team-2', visibility: 'private', ownerId: 'user-2', createdAt: 1,
  });
  await repos.teams.addMember({
    teamId: 'team-2', userId: 'user-2', username: 'bob', role: 'owner', joinedAt: 1,
  });

  // 一条带归因的 decision。
  await repos.channelCoordination.decisions.create(makeDecision({}));

  // 一条无归因（未注入 Active Memory）的 decision。
  await repos.channelCoordination.decisions.create(
    makeDecision({ id: 'decision-2', jobId: 'job-2', messageId: 'message-2', memoryAttribution: null }),
  );

  // team-1 的私有频道 + 一条归因 decision（user-1 是成员；user-3 不是）。
  await repos.channels.create({
    id: 'channel-private', teamId: 'team-1', kind: 'channel', name: 'secret', visibility: 'private',
    createdBy: 'user-1', createdAt: 1, humanMemberIds: ['user-1'], agentMemberIds: [],
  });
  await repos.users.create({
    id: 'user-3', username: 'carol', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1,
  });
  await repos.teams.addMember({
    teamId: 'team-1', userId: 'user-3', username: 'carol', role: 'member', joinedAt: 1,
  });
  await repos.channelCoordination.decisions.create(
    makeDecision({
      id: 'decision-3', jobId: 'job-3', messageId: 'message-3', channelId: 'channel-private',
    }),
  );

  return { app, repos };
}

describe('getMemoryAttribution (#965 AC#4)', () => {
  test('授权成员按 jobId 读到归因', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({ teamId: 'team-1', jobId: 'job-1', userId: 'user-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toEqual(ATTRIBUTION);
  });

  test('授权成员按 messageId 读到归因', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({
      teamId: 'team-1', messageId: 'message-1', userId: 'user-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toEqual(ATTRIBUTION);
  });

  test('跨 Team 用户 fail-closed 返回 null（不泄露归因存在）', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({ teamId: 'team-1', jobId: 'job-1', userId: 'user-2' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toBeNull();
  });

  test('请求的 teamId 与 decision 不符返回 null', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({ teamId: 'team-2', jobId: 'job-1', userId: 'user-2' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toBeNull();
  });

  test('私有频道非成员返回 null，成员可读', async () => {
    const { app } = await setup();
    const denied = await app.getMemoryAttribution({
      teamId: 'team-1', jobId: 'job-3', userId: 'user-3',
    });
    expect(denied.ok && denied.attribution).toBeNull();

    const allowed = await app.getMemoryAttribution({
      teamId: 'team-1', jobId: 'job-3', userId: 'user-1',
    });
    expect(allowed.ok && allowed.attribution).toEqual(ATTRIBUTION);
  });

  test('不存在的 decision 返回 null', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({
      teamId: 'team-1', jobId: 'no-such-job', userId: 'user-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toBeNull();
  });

  test('未注入 Active Memory 的 decision 返回 null 归因', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({
      teamId: 'team-1', jobId: 'job-2', userId: 'user-1',
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.attribution).toBeNull();
  });

  test('缺 jobId 与 messageId 时拒绝请求', async () => {
    const { app } = await setup();
    const result = await app.getMemoryAttribution({ teamId: 'team-1', userId: 'user-1' });
    expect(result.ok).toBe(false);
  });
});
