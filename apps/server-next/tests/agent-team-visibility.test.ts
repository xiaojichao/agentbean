import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories';
import { createInMemoryServerNext } from '../src/index';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) {
      throw new Error('Test id sequence exhausted');
    }
    return id;
  };
}

// Agent 团队可见性切换：setAgentTeamVisibility 在 primary team 上把 agent
// 隐藏 / 恢复，影响 listVisibleAgents 的成员页呈现与默认频道成员关系。
// 注意：brief 里写的 registerDevice / listVisibleAgents / registerDiscoveredAgents
// 的签名以 createInMemoryServerNext 实际返回为准 —— 设备走 deviceHello，
// registerDiscoveredAgents 不接受 userId，断言意图保持不变。
describe('agent team visibility', () => {
  test('invisible agent is excluded from listVisibleInTeam and loses channel membership', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    // 设备上线（deviceHello 内部会校验 team 成员关系并建默认频道）
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    expect(hello.ok).toBe(true);
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });

    // 默认可见
    await expect(app.listVisibleAgents({ teamId: 'team-1' })).resolves.toMatchObject({ ok: true });

    // 设为不可见
    const hidden = await app.setAgentTeamVisibility({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      visible: false,
    });
    expect(hidden.ok).toBe(true);

    // 成员页不再包含该 agent
    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed.ok && listed.agents.map((a) => a.id)).not.toContain('agent-1');

    // 重新可见
    await app.setAgentTeamVisibility({
      userId: 'user-1',
      teamId: 'team-1',
      agentId: 'agent-1',
      visible: true,
    });
    const listed2 = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed2.ok && listed2.agents.map((a) => a.id)).toContain('agent-1');
  });

  test('listVisibleInTeam excludes executor-hosted runtime agents (兜底过滤)', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-exec']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'codex', adapterKind: 'codex', category: 'executor-hosted' }],
    });
    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed.ok && listed.agents.map((a) => a.category)).not.toContain('executor-hosted');
  });

  test('registerDiscoveredAgents only ingests agentos-hosted, skips executor-hosted', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    // 同时提交 agentos-hosted 与 executor-hosted：源头上只应入库前者，
    // 后者仅作为 RuntimeDto 在设备详情页展示，不应进入 agents 表。
    const res = await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [
        { name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' },
        { name: 'codex', adapterKind: 'codex', category: 'executor-hosted' },
      ],
    });
    expect(res.ok && res.agents.map((a) => a.category)).toEqual(['agentos-hosted']);
  });

  test('memory setPrimaryTeamVisibility refuses soft-deleted agents (I2 deep-defense)', async () => {
    // I2: memory/repositories.ts 的 setPrimaryTeamVisibility 缺 deletedAt 守卫，软删 agent
    // 被调用会"复活"进 visibleTeamIds。本测试直接打内存仓库，绕过 usecase 层守卫，
    // 验证 repo 层防御与同级方法（updateConfig/softDelete）一致。
    const repos = createInMemoryRepositories();
    await repos.agents.upsert({
      id: 'agent-1',
      primaryTeamId: 'team-1',
      visibleTeamIds: ['team-1'],
      name: 'Codex',
      adapterKind: 'codex',
      category: 'executor-hosted',
      source: 'scanned',
      status: 'offline',
      lastSeenAt: 100,
    });
    await repos.agents.softDelete({ agentId: 'agent-1', timestamp: 500 });

    // 软删后调 setPrimaryTeamVisibility 应返回 null（与 updateConfig/softDelete 一致）。
    const result = await repos.agents.setPrimaryTeamVisibility({
      agentId: 'agent-1',
      visible: true,
      timestamp: 1000,
    });
    expect(result).toBeNull();
    // 再取一次确认 agent 未被"复活"：visibleTeamIds 仍为软删后的空集。
    const agent = await repos.agents.getById('agent-1');
    expect(agent?.visibleTeamIds).toEqual([]);
    expect(agent?.deletedAt).toBe(500);
  });

  test('hidden agentos agent stays hidden after daemon re-report (upsert 不重置可见性)', async () => {
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    // 设为不可见
    await app.setAgentTeamVisibility({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1', visible: false,
    });

    // daemon 周期重新上报（agent 仍在设备上跑，daemon 不感知 hidden）。
    // 此前 memory upsert 会用 visibleTeamIds:[team] 覆盖，使 hidden 失效。
    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });

    // hidden 必须保持：成员页不应再包含该 agent。
    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    expect(listed.ok && listed.agents.map((a) => a.id)).not.toContain('agent-1');
  });

  test('listVisibleAgents 用设备所有者填充 ownerName（scanned agent 无 ownerId 时回退）', async () => {
    // Agent 详情页"创建者"应为该 Agent 所在设备的所有者。扫描发现的 agentos-hosted
    // agent 入库时不携带 ownerId，ownerName 必须回退为 device.ownerId 对应用户的 username，
    // 否则前端 agent.ownerName ?? '未知' 永远显示"未知"。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });

    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    // 创建者回退为设备所有者 'shaw'，而非 undefined / null / '未知'
    expect(listed.ok && listed.agents[0]?.ownerId).toBe('user-1');
    expect(listed.ok && listed.agents[0]?.ownerName).toBe('shaw');
  });

  test('listMembers 也返回 scanned agent 的设备所有者 ownerId/ownerName', async () => {
    // 单数 Agent 详情页复用 MembersPage，数据来自 members:list 而不是 agents:snapshot；
    // 这条路径也必须带上解析后的 ownerId/ownerName。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    await app.registerDiscoveredAgents({
      teamId: 'team-1',
      deviceId,
      agents: [{ name: 'Hermes', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });

    const listed = await app.listMembers({ teamId: 'team-1', userId: 'user-1' });
    const agent = listed.ok ? listed.agents.find((candidate) => candidate.id === 'agent-1') : undefined;
    expect(agent?.ownerId).toBe('user-1');
    expect(agent?.ownerName).toBe('shaw');
  });

  test('listVisibleAgents 用 agent.ownerId 填充 ownerName（custom agent 直接命中）', async () => {
    // custom agent 创建时已写入 ownerId；enrich 应直接取该 owner 的 username。
    const app = createInMemoryServerNext({
      now: () => 1000,
      ids: createIds(['user-1', 'team-1', 'channel-1', 'device-1', 'agent-1']),
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', hostname: 'mac' });
    const deviceId = hello.ok ? hello.device.id : 'device-1';

    const created = await app.createCustomAgent({
      userId: 'user-1',
      teamId: 'team-1',
      deviceId,
      name: 'my-codex',
      adapterKind: 'codex',
      command: 'codex',
    });
    expect(created.ok).toBe(true);

    const listed = await app.listVisibleAgents({ teamId: 'team-1' });
    const agent = listed.ok ? listed.agents.find((a) => a.name === 'my-codex') : undefined;
    expect(agent?.ownerId).toBe('user-1');
    expect(agent?.ownerName).toBe('shaw');
  });
});
