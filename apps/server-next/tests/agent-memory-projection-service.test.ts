import { describe, expect, test } from 'vitest';

import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';
import type { ServerNextRepositories } from '../src/application/repositories.js';

function createIds() {
  const fixed = ['user-1', 'team-1', 'channel-1'];
  let index = 0;
  let auto = 0;
  return () => {
    if (index < fixed.length) return fixed[index++];
    return `auto-${++auto}`;
  };
}

async function createHarness() {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 100 },
    ids: { nextId: createIds() },
  });
  await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  await seedDeviceAndAgent(repositories, 'user-1', 'device-1', 'agent-1', 'team-1');
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-admin', username: 'admin', role: 'admin', joinedAt: 50,
  });
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-member', username: 'member', role: 'member', joinedAt: 51,
  });
  return { repositories, app };
}

async function seedDeviceAndAgent(
  repositories: ServerNextRepositories,
  ownerId: string,
  deviceId: string,
  agentId: string,
  teamId: string,
) {
  await repositories.devices.upsertHello({
    id: deviceId, teamId, ownerId, status: 'online', machineId: `m-${deviceId}`,
    profileId: `p-${deviceId}`, createdAt: 1, updatedAt: 1,
  });
  await repositories.agents.upsert({
    id: agentId, primaryTeamId: teamId, visibleTeamIds: [teamId], name: agentId,
    adapterKind: 'codex', category: 'executor-hosted', source: 'custom', status: 'online', deviceId,
  });
}

type App = Awaited<ReturnType<typeof createHarness>>['app'];

/** Owner 创建并发布一个投影，返回 active projection id。 */
async function publishProjection(app: App, content = 'Agent prefers concise replies.', kind: 'fact' | 'decision' | 'rule' | 'preference' = 'preference'): Promise<string> {
  const draft = await app.createAgentMemoryProjectionDraft({
    userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', kind, content, summary: 's',
  });
  if (!draft.ok) throw new Error('createDraft failed');
  const published = await app.publishAgentMemoryProjection({
    userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id,
  });
  if (!published.ok) throw new Error('publish failed');
  return published.projection.id;
}

/** 可变 clock harness：用于验证 validUntil 过期后 refreshExpiry 懒过期（AC#7）。 */
async function createHarnessWithMutableClock() {
  const repositories = createInMemoryRepositories();
  let currentNow = 100;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => currentNow },
    ids: { nextId: createIds() },
  });
  await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  await seedDeviceAndAgent(repositories, 'user-1', 'device-1', 'agent-1', 'team-1');
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-admin', username: 'admin', role: 'admin', joinedAt: 50,
  });
  await repositories.teams.addMember({
    teamId: 'team-1', userId: 'user-member', username: 'member', role: 'member', joinedAt: 51,
  });
  return { repositories, app, advance: (ms: number) => { currentNow += ms; } };
}

describe('Team-scoped Agent Memory Projection (#718)', () => {
  test('owner 创建 draft 并发布；revision 单调递增（AC#1/AC#2）', async () => {
    const { app } = await createHarness();
    const draft = await app.createAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', kind: 'preference', content: 'c',
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.projection.status).toBe('draft');
    expect(draft.projection.publishedAt).toBeNull();

    const published = await app.publishAgentMemoryProjection({
      userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.projection.status).toBe('active');
    expect(published.projection.revision).toBe(1);
    expect(published.projection.publishedBy).toBe('user-1');
    expect(published.supersededProjectionId).toBeNull();
  });

  test('非 owner 不能创建/发布投影（AC#2 授权 fail-closed）', async () => {
    const { app } = await createHarness();
    // admin 是 Team admin 但非 agent owner（device-1 属 user-1）。
    const draftByAdmin = await app.createAgentMemoryProjectionDraft({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', kind: 'fact', content: 'c',
    });
    expect(draftByAdmin.ok).toBe(false);
    if (!draftByAdmin.ok) expect(draftByAdmin.error).toBe('FORBIDDEN');

    const draftByMember = await app.createAgentMemoryProjectionDraft({
      userId: 'user-member', teamId: 'team-1', agentId: 'agent-1', kind: 'fact', content: 'c',
    });
    expect(draftByMember.ok).toBe(false);
  });

  test('默认 opted-out：未 opt-in 时 getConsumable 返回空（AC#5 明确授权）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toEqual([]);
  });

  test('Team Owner/Admin opt-in 后 getConsumable 返回公开字段（AC#3/AC#6）', async () => {
    const { app } = await createHarness();
    await publishProjection(app, 'Agent handles refunds under $50.');

    const optIn = await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });
    expect(optIn.ok).toBe(true);
    if (optIn.ok) expect(optIn.optIn.enabled).toBe(true);

    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toHaveLength(1);
    const consumed = result.projections[0]!;
    expect(consumed.content).toBe('Agent handles refunds under $50.');
    expect(consumed.agentName).toBe('agent-1');
    expect(consumed.revision).toBe(1);
    // AC#6/AC#4：消费视图只含公开字段，不含 sourceRefs 原文 / owner 审计。
    expect(consumed).not.toHaveProperty('publishedBy');
    expect(consumed).not.toHaveProperty('sourceRefs');
    expect(consumed).not.toHaveProperty('createdBy');
  });

  test('普通成员不能 opt-in（AC#3 仅 Owner/Admin）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    const optIn = await app.upsertTeamAgentMemoryOptIn({ userId: 'user-member', teamId: 'team-1', agentId: 'agent-1', enabled: true });
    expect(optIn.ok).toBe(false);
    if (!optIn.ok) expect(optIn.error).toBe('FORBIDDEN');
  });

  test('opt-out 后立即退出消费（AC#3/AC#7）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: false });

    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toEqual([]);
  });

  test('owner withdraw 后立即退出消费（AC#2/AC#7）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });

    const withdraw = await app.withdrawAgentMemoryProjection({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    expect(withdraw.ok).toBe(true);
    if (withdraw.ok) expect(withdraw.withdrawn).toBe(true);

    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toEqual([]);
  });

  test('owner publish 新 revision 后旧 opt-in 失效（revision fence，AC#7）', async () => {
    const { app } = await createHarness();
    await publishProjection(app, 'v1');
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });

    // owner 发布新 revision（supersede 旧 active）。
    await publishProjection(app, 'v2');

    // opt-in 仍锁定旧 projection id → revision fence 不符 → fail-closed 不消费。
    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toEqual([]);
  });

  test('非 Team 成员不能消费（AC#4 隔离 fail-closed）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });

    const result = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-outsider' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.projections).toEqual([]);
  });

  test('agentId 过滤：只消费指定 agent 的投影（AC#1 Team+Agent 联合 scope）', async () => {
    const { repositories, app } = await createHarness();
    // 第二个 agent（同 team）。
    await seedDeviceAndAgent(repositories, 'user-1', 'device-2', 'agent-2', 'team-1');
    await publishProjection(app, 'agent-1 content');
    // 发布 agent-2 的投影。
    const d2 = await app.createAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-2', kind: 'fact', content: 'agent-2 content',
    });
    if (!d2.ok) throw new Error('draft agent-2 failed');
    const p2 = await app.publishAgentMemoryProjection({ userId: 'user-1', teamId: 'team-1', projectionId: d2.projection.id });
    if (!p2.ok) throw new Error('publish agent-2 failed');

    // 两个 agent 都 opt-in。
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-2', enabled: true });

    // 仅查 agent-2。
    const onlyAgent2 = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member', agentId: 'agent-2' });
    expect(onlyAgent2.ok).toBe(true);
    if (!onlyAgent2.ok) return;
    expect(onlyAgent2.projections).toHaveLength(1);
    expect(onlyAgent2.projections[0]!.agentId).toBe('agent-2');
  });

  test('listRevisions 返回 owner 视图（含审计）+ activeOptIn（AC#2/AC#3）', async () => {
    const { app } = await createHarness();
    await publishProjection(app);
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });

    const result = await app.listAgentMemoryProjectionRevisions({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.revisions).toHaveLength(1);
    expect(result.revisions[0]!.status).toBe('active');
    expect(result.activeOptIn).not.toBeNull();
    expect(result.activeOptIn!.enabled).toBe(true);
  });

  test('updateDraft 修订 draft 内容；非 draft 不能改（AC#2）', async () => {
    const { app } = await createHarness();
    const draft = await app.createAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', kind: 'fact', content: 'original',
    });
    if (!draft.ok) throw new Error('draft failed');
    const updated = await app.updateAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id, kind: 'fact', content: 'revised',
    });
    expect(updated.ok).toBe(true);
    if (updated.ok) expect(updated.projection.content).toBe('revised');

    // 发布后再 update 应失败（非 draft）。
    await app.publishAgentMemoryProjection({ userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id });
    const afterPublish = await app.updateAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id, kind: 'fact', content: 'nope',
    });
    expect(afterPublish.ok).toBe(false);
  });

  test('已过 validUntil 的 projection 不被消费（team-wide refreshExpiry 懒过期，AC#7）', async () => {
    const { app, advance } = await createHarnessWithMutableClock();
    // clock=100，创建 validUntil=200 的投影并发布、opt-in。
    const draft = await app.createAgentMemoryProjectionDraft({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', kind: 'fact', content: 'c', validUntil: 200,
    });
    if (!draft.ok) throw new Error('draft failed');
    await app.publishAgentMemoryProjection({ userId: 'user-1', teamId: 'team-1', projectionId: draft.projection.id });
    await app.upsertTeamAgentMemoryOptIn({ userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1', enabled: true });

    // clock=100 < 200：team-wide 消费返回该投影。
    const before = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(before.ok).toBe(true);
    if (before.ok) expect(before.projections).toHaveLength(1);

    // 推进 clock 到 300 > 200：refreshExpiry 应把投影标记 expired，team-wide 消费不再返回。
    advance(200);
    const after = await app.getConsumableAgentMemoryProjections({ teamId: 'team-1', userId: 'user-member' });
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.projections).toEqual([]);
  });
});
