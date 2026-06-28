import { describe, expect, test } from 'vitest';
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
});
