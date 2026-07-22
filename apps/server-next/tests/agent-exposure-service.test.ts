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

/** 发布一个含给定 capability 的 manifest，返回 active manifest id。 */
async function publishManifest(
  app: Awaited<ReturnType<typeof createHarness>>['app'],
  capabilities: ReadonlyArray<{ name: string; description: string }>,
  skills: ReadonlyArray<{ name: string; description: string }> = [],
): Promise<string> {
  const draft = await app.createAgentExposureDraft({
    userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', capabilities, skills,
  });
  if (!draft.ok) throw new Error('createDraft failed');
  const published = await app.publishAgentExposure({
    userId: 'user-1', teamId: 'team-1', manifestId: draft.manifest.id,
  });
  if (!published.ok) throw new Error('publish failed');
  return published.manifest.id;
}

describe('Team Agent Exposure (#710)', () => {
  test('owner 创建 draft 并发布；active 投影暴露公开 capability 且不含 sourcePath（AC#1/AC#3/AC#6）', async () => {
    const { app } = await createHarness();
    const draft = await app.createAgentExposureDraft({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1',
      capabilities: [{ name: 'code-review', description: '审查代码' }],
      skills: [{ name: 'typescript', description: 'TS' }],
    });
    expect(draft.ok).toBe(true);
    if (!draft.ok) return;
    expect(draft.manifest.status).toBe('draft');
    expect(draft.manifest.publishedAt).toBeNull();

    const published = await app.publishAgentExposure({
      userId: 'user-1', teamId: 'team-1', manifestId: draft.manifest.id,
    });
    expect(published.ok).toBe(true);
    if (!published.ok) return;
    expect(published.manifest.status).toBe('active');
    expect(published.manifest.publishedBy).toBe('user-1');
    expect(published.supersededManifestId).toBeNull();

    const active = await app.getAgentExposureActive({ teamId: 'team-1', agentId: 'agent-1' });
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.projection?.revision).toBe(1);
    expect(active.projection?.capabilities.map((capability) => capability.name)).toEqual(['code-review']);
    // AC#6：投影绝不含 sourcePath/adapterKind/scope。
    expect(JSON.stringify(active.projection)).not.toContain('sourcePath');
    expect(JSON.stringify(active.projection)).not.toContain('adapterKind');
  });

  test('再次发布使旧 active superseded；同 team+agent 仅一个 active（AC#2）', async () => {
    const { app } = await createHarness();
    const firstId = await publishManifest(app, [{ name: 'code-review', description: 'v1' }]);
    const secondId = await publishManifest(app, [{ name: 'code-review', description: 'v2' }]);

    const list = await app.listAgentExposureRevisions({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    expect(list.ok).toBe(true);
    if (!list.ok) return;
    const actives = list.revisions.filter((revision) => revision.status === 'active');
    expect(actives).toHaveLength(1);
    expect(actives[0]?.id).toBe(secondId);
    expect(actives[0]?.revision).toBe(2);
    const old = list.revisions.find((revision) => revision.id === firstId);
    expect(old?.status).toBe('superseded');
    expect(old?.supersededById).toBe(secondId);
  });

  test('owner 可撤回 active manifest；撤回后无 active 投影且历史可见 revoked（AC#2）', async () => {
    const { app } = await createHarness();
    await publishManifest(app, [{ name: 'code-review', description: '审查' }]);

    const revoked = await app.revokeAgentExposure({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    expect(revoked.ok).toBe(true);
    if (!revoked.ok) return;
    expect(revoked.revoked).toBe(true);

    const active = await app.getAgentExposureActive({ teamId: 'team-1', agentId: 'agent-1' });
    expect(active.ok).toBe(true);
    if (!active.ok) return;
    expect(active.projection).toBeNull();

    const list = await app.listAgentExposureRevisions({ userId: 'user-1', teamId: 'team-1', agentId: 'agent-1' });
    if (!list.ok) return;
    expect(list.revisions.some((revision) => revision.status === 'revoked')).toBe(true);
  });

  test('非 owner 成员/团队 admin 都不能发布；只有设备拥有者能（AC#1）', async () => {
    const { app } = await createHarness();
    const draftByMember = await app.createAgentExposureDraft({
      userId: 'user-member', teamId: 'team-1', agentId: 'agent-1',
      capabilities: [{ name: 'code-review', description: 'x' }], skills: [],
    });
    expect(draftByMember.ok).toBe(false);
    // team admin 非设备拥有者，也不能创建/发布
    const draftByAdmin = await app.createAgentExposureDraft({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      capabilities: [{ name: 'code-review', description: 'x' }], skills: [],
    });
    expect(draftByAdmin.ok).toBe(false);
  });

  test('Team Owner/Admin 只能禁用已公开 operation；未知 capability fail-closed；member 不能 restrict（AC#4）', async () => {
    const { app } = await createHarness();
    await publishManifest(app, [
      { name: 'code-review', description: '审查' },
      { name: 'lint', description: 'lint' },
    ], [{ name: 'typescript', description: 'TS' }]);

    // admin 禁用已公开 capability：允许
    const ok = await app.upsertAgentExposureRestriction({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: ['lint'], disabledSkills: [],
    });
    expect(ok.ok).toBe(true);

    // 禁用未公开 capability：fail-closed（禁止借 restriction 新增/越权）
    const blocked = await app.upsertAgentExposureRestriction({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: ['deploy-prod'], disabledSkills: [],
    });
    expect(blocked.ok).toBe(false);

    // 禁用未公开 skill：同样 fail-closed
    const blockedSkill = await app.upsertAgentExposureRestriction({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: [], disabledSkills: ['rust'],
    });
    expect(blockedSkill.ok).toBe(false);

    // member 不能 restrict
    const byMember = await app.upsertAgentExposureRestriction({
      userId: 'user-member', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: ['lint'], disabledSkills: [],
    });
    expect(byMember.ok).toBe(false);
  });

  test('PI Team coverage 只读展示公开 capability 与收紧；成员可读、非成员被拒（AC#3/AC#5）', async () => {
    const { app } = await createHarness();
    await publishManifest(app, [{ name: 'code-review', description: '审查' }]);
    await app.upsertAgentExposureRestriction({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: ['code-review'], disabledSkills: [],
    });

    const coverage = await app.getAgentTeamCoverage({ userId: 'user-member', teamId: 'team-1' });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    const entry = coverage.coverage.entries.find((item) => item.agentId === 'agent-1');
    expect(entry).toMatchObject({
      hasActive: true, available: true,
      exposedCapabilities: ['code-review'], disabledCapabilities: ['code-review'],
    });
    expect(JSON.stringify(coverage.coverage)).not.toContain('sourcePath');

    // 非成员连 coverage 都读不到
    const outsider = await app.getAgentTeamCoverage({ userId: 'user-outsider', teamId: 'team-1' });
    expect(outsider.ok).toBe(false);
  });

  test('restriction 仅在锁定到当前 active manifest 时生效（supersede 后旧 restriction 不再套用，AC#4 fence）', async () => {
    const { app } = await createHarness();
    await publishManifest(app, [{ name: 'code-review', description: 'v1' }]);
    await app.upsertAgentExposureRestriction({
      userId: 'user-admin', teamId: 'team-1', agentId: 'agent-1',
      disabledCapabilities: ['code-review'], disabledSkills: [],
    });
    // 发布新 revision：旧 restriction 锁定在旧 manifest，对新 active 不生效。
    await publishManifest(app, [{ name: 'code-review', description: 'v2' }]);

    const coverage = await app.getAgentTeamCoverage({ userId: 'user-1', teamId: 'team-1' });
    expect(coverage.ok).toBe(true);
    if (!coverage.ok) return;
    const entry = coverage.coverage.entries.find((item) => item.agentId === 'agent-1');
    expect(entry?.disabledCapabilities).toEqual([]);
  });
});
