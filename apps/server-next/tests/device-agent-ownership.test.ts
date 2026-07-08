import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';
import { createServerNextUseCases } from '../src/application/usecases';

// 设备/Agent 修改授权收紧为「仅设备拥有者 + 系统管理员」。
// 业务规则：用户只能修改自己设备及其上的 Agent。团队 owner/admin、custom Agent
// 创建者，只要不是设备拥有者，就无权改别人的设备。
//
// 红测试的 actor 选用「team admin」（团队角色 admin）：当前实现因 agentForManagement /
// agentForConfigUpdate / renameDevice 等基于「团队角色」放行，team admin 能改别人设备
// （即 bug）；收紧后应一律 FORBIDDEN。

function createApp() {
  const repositories = createInMemoryRepositories();
  let n = 0;
  let jc = 0;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 1000 },
    ids: { nextId: () => { n += 1; return `id-${n}`; } },
    joinCodes: { nextCode: () => { jc += 1; return `code-${jc}`; } },
  });
  return { app, repositories };
}

interface TeamScenario {
  app: ReturnType<typeof createServerNextUseCases>;
  repositories: ReturnType<typeof createInMemoryRepositories>;
  ownerId: string;   // team-1 owner，拥有 device-A
  adminId: string;   // team admin（团队角色 admin，非系统 admin），拥有 device-B
  memberId: string;  // team member
  teamId: string;
  deviceAId: string; // 属 owner
  deviceBId: string; // 属 admin
  agentA1Id: string; // device-A 上 agentos-hosted agent
  customAId: string; // device-A 上 custom agent（由 owner 创建）
}

async function setupTeam(): Promise<TeamScenario> {
  const { app, repositories } = createApp();
  const owner = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team1' });
  if (!owner.ok) throw new Error('owner register failed');
  const ownerId = owner.user.id;
  const teamId = owner.user.primaryTeamId!;
  await app.createJoinLink({ userId: ownerId, teamId }); // -> code-1
  const admin = await app.registerUser({ username: 'admin', password: 'secret', teamName: 'X', joinCode: 'code-1' });
  if (!admin.ok) throw new Error('admin register failed');
  const adminId = admin.user.id;
  await app.createJoinLink({ userId: ownerId, teamId }); // -> code-2
  const member = await app.registerUser({ username: 'member', password: 'secret', teamName: 'Y', joinCode: 'code-2' });
  if (!member.ok) throw new Error('member register failed');
  const memberId = member.user.id;
  // 提升 admin 为团队 admin（团队角色，区别于系统 role='admin'）
  await app.updateMemberRole({ userId: ownerId, teamId, targetUserId: adminId, role: 'admin' });

  const helloA = await app.deviceHello({ teamId, ownerId, hostname: 'mac-A' });
  const helloB = await app.deviceHello({ teamId, ownerId: adminId, hostname: 'mac-B' });
  if (!helloA.ok || !helloB.ok) throw new Error('device hello failed');
  const deviceAId = helloA.device.id;
  const deviceBId = helloB.device.id;

  const disc = await app.registerDiscoveredAgents({
    teamId,
    deviceId: deviceAId,
    agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!disc.ok || !disc.agents.length) throw new Error('discovered agents failed');
  const agentA1Id = disc.agents[0].id;

  // owner 在自己 device-A 上创建 custom agent（owner 是设备拥有者，始终允许）
  const custom = await app.createCustomAgent({
    teamId, userId: ownerId, deviceId: deviceAId, name: 'owner-bot', adapterKind: 'codex',
  });
  if (!custom.ok) throw new Error('custom agent create failed');
  const customAId = custom.agent.id;

  return { app, repositories, ownerId, adminId, memberId, teamId, deviceAId, deviceBId, agentA1Id, customAId };
}

function expectForbidden(res: { ok: boolean; error?: string }) {
  expect(res.ok).toBe(false);
  if (!res.ok) expect(res.error).toBe('FORBIDDEN');
}
function expectOk(res: { ok: boolean }) {
  expect(res.ok).toBe(true);
}

describe('device / agent modification ownership (仅设备拥有者 + 系统管理员)', () => {
  // ===== A. 收紧新行为：team admin 不能改别人设备（当前 bug 放行 → 红）=====

  test('team admin cannot rename another member device', async () => {
    const { app, adminId, teamId, deviceAId } = await setupTeam();
    const res = await app.renameDevice({ userId: adminId, teamId, deviceId: deviceAId, name: 'hacked' });
    expectForbidden(res);
  });

  test('team admin cannot delete another member device', async () => {
    const { app, adminId, teamId, deviceAId } = await setupTeam();
    const res = await app.deleteDevice({ userId: adminId, teamId, deviceId: deviceAId });
    expectForbidden(res);
  });

  test('team admin cannot scan another member device', async () => {
    const { app, adminId, teamId, deviceAId } = await setupTeam();
    const res = await app.requestDeviceScan({ userId: adminId, teamId, deviceId: deviceAId });
    expectForbidden(res);
  });

  test('team admin cannot create custom agent on another member device', async () => {
    const { app, adminId, teamId, deviceAId } = await setupTeam();
    const res = await app.createCustomAgent({
      teamId, userId: adminId, deviceId: deviceAId, name: 'injected-bot', adapterKind: 'codex',
    });
    expectForbidden(res);
  });

  test('team admin cannot toggle visibility of agent on another member device', async () => {
    const { app, adminId, teamId, agentA1Id } = await setupTeam();
    const res = await app.setAgentTeamVisibility({ userId: adminId, teamId, agentId: agentA1Id, visible: false });
    expectForbidden(res);
  });

  test('team admin cannot update config of agentos agent on another member device', async () => {
    const { app, adminId, teamId, agentA1Id } = await setupTeam();
    const res = await app.updateAgentConfig({ userId: adminId, teamId, agentId: agentA1Id, name: 'renamed' });
    expectForbidden(res);
  });

  // ===== Regression: 清空"功能介绍"不应 INTERNAL_ERROR =====
  // 前端 devices/page.tsx AgentConfigDialog 在"功能介绍"为空时下发 description: null。
  // usecase 曾对 null 调 .trim() 抛 TypeError，被 socket 兜底吞成 INTERNAL_ERROR。
  test('clearing an agent description via null does not throw (frontend sends null when the field is empty)', async () => {
    const { app, ownerId, teamId, agentA1Id, repositories } = await setupTeam();
    const res = await app.updateAgentConfig({
      userId: ownerId,
      teamId,
      agentId: agentA1Id,
      name: 'Hermes-Renamed',
      description: null,
    });
    expectOk(res);
    const agent = await repositories.agents.getById(agentA1Id);
    expect(agent?.description).toBeNull();
  });

  test('team admin cannot delete custom agent on another member device', async () => {
    const { app, adminId, teamId, customAId } = await setupTeam();
    const res = await app.deleteAgent({ userId: adminId, teamId, agentId: customAId });
    expectForbidden(res);
  });

  // ===== A'. custom 创建者也不能跨设备（ownerId 放行移除）=====

  test('custom agent creator cannot delete own agent hosted on another member device', async () => {
    const { app, repositories, memberId, teamId, deviceAId } = await setupTeam();
    // 直接造一个 custom agent：ownerId=member，但挂在 owner 的 device-A 上
    await repositories.agents.upsert({
      id: 'agent-foreign', primaryTeamId: teamId, visibleTeamIds: [teamId],
      name: 'member-bot', source: 'custom', category: 'executor-hosted',
      adapterKind: 'codex', ownerId: memberId, deviceId: deviceAId,
      status: 'online', lastSeenAt: 1000,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    const res = await app.deleteAgent({ userId: memberId, teamId, agentId: 'agent-foreign' });
    expectForbidden(res);
  });

  // ===== B. 防过度收紧：系统管理员（user.role='admin'）仍可改任意设备 =====

  test('system admin can rename another member device', async () => {
    const { app, repositories, teamId, deviceAId } = await setupTeam();
    await repositories.users.create({
      id: 'sysadmin', username: 'sysadmin', email: null, role: 'admin',
      passwordHash: 'x', currentTeamId: teamId, createdAt: 0, updatedAt: 0,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    } as any);
    await repositories.teams.addMember({ teamId, userId: 'sysadmin', username: 'sysadmin', role: 'member', joinedAt: 0 });
    const res = await app.renameDevice({ userId: 'sysadmin', teamId, deviceId: deviceAId, name: 'by-admin' });
    expectOk(res);
  });

  // ===== D. 守卫：设备拥有者可改自己设备；普通成员被拒（不应回归）=====

  test('device owner can rename own device', async () => {
    const { app, ownerId, teamId, deviceAId } = await setupTeam();
    const res = await app.renameDevice({ userId: ownerId, teamId, deviceId: deviceAId, name: 'renamed' });
    expectOk(res);
  });

  test('device owner can scan own device', async () => {
    const { app, ownerId, teamId, deviceAId } = await setupTeam();
    const res = await app.requestDeviceScan({ userId: ownerId, teamId, deviceId: deviceAId });
    expectOk(res);
  });

  test('device owner can toggle visibility of agent on own device', async () => {
    const { app, ownerId, teamId, agentA1Id } = await setupTeam();
    const res = await app.setAgentTeamVisibility({ userId: ownerId, teamId, agentId: agentA1Id, visible: false });
    expectOk(res);
  });

  test('device owner can update config of agentos agent on own device', async () => {
    const { app, ownerId, teamId, agentA1Id } = await setupTeam();
    const res = await app.updateAgentConfig({ userId: ownerId, teamId, agentId: agentA1Id, name: 'renamed' });
    expectOk(res);
  });

  test('plain member cannot rename another member device (守卫)', async () => {
    const { app, memberId, teamId, deviceAId } = await setupTeam();
    const res = await app.renameDevice({ userId: memberId, teamId, deviceId: deviceAId, name: 'x' });
    expectForbidden(res);
  });
});
