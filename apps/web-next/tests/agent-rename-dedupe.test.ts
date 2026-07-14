import { describe, expect, beforeEach, test } from 'vitest';
import { useAgentBeanStore } from '../lib/store';
import { agentDisplayName } from '../lib/display-names';
import type { AgentSnapshot } from '../lib/schema';

// 回归：Agent 改名后，频道消息里该 Agent 的名称仍显示旧名。
// 根因：dedupeAgents 把同一物理 agent（同 deviceId/adapterKind/runtime）的多条记录合并，
// 丢弃非赢家 id；而消息 senderId 恰是被丢弃的输家 id，agents[senderId] 命中失败，
// agentDisplayName 回退到改名后未刷新的 channelMembers 缓存（旧名）。
// 修复：agents 改为别名 map（每个 id → 其去重组赢家），输家 id 也指向赢家；
// 另维护 visibleAgents（去重赢家数组）供成员列表遍历。

function mk(over: Partial<AgentSnapshot> & { id: string }): AgentSnapshot {
  return {
    primaryTeamId: 't1',
    visibleTeamIds: ['t1'],
    name: 'old',
    role: 'agent',
    adapterKind: 'claude-code' as AgentSnapshot['adapterKind'],
    status: 'online',
    lastSeenAt: 1,
    connectCommand: '',
    ...over,
  } as AgentSnapshot;
}

// 同一物理 agent 的两条记录（扫描发现 + daemon 自注册），共享 deviceId/adapterKind/cwd
function physicalAgent(id: string, over: Partial<AgentSnapshot>): AgentSnapshot {
  return mk({
    id,
    category: 'agentos-hosted',
    deviceId: 'dev1',
    adapterKind: 'claude-code' as AgentSnapshot['adapterKind'],
    cwd: '/x',
    command: '/bin/claude',
    ...over,
  });
}

function reset() {
  useAgentBeanStore.setState({
    agentRecords: {},
    agents: {},
    visibleAgents: [],
    currentTeamId: 't1',
  } as Partial<ReturnType<typeof useAgentBeanStore.getState>>);
}

describe('agent rename across dedupe-merged records', () => {
  beforeEach(reset);

  test('regression: message senderId of dedupe-loser resolves to renamed winner', () => {
    const s = useAgentBeanStore.getState();
    s.applyAgentsSnapshot([
      physicalAgent('a-scan', { name: 'old', source: 'scanned' }),
      physicalAgent('a-self', { name: 'selfname', source: 'self-register' }),
    ]);
    // 用户在 UI 改名（UI 显示的是去重赢家 a-self）→ server 广播改名后的赢家 status
    s.applyAgentStatus(physicalAgent('a-self', { name: 'NEW', source: 'self-register' }));

    const agents = useAgentBeanStore.getState().agents;
    // 消息 senderId 是被去重丢弃的输家 a-scan → 应解析到赢家新名（同一物理 agent）
    expect(agents['a-scan']?.name).toBe('NEW');
    expect(agentDisplayName('a-scan', agents)).toBe('NEW');
  });

  test('regression: full snapshot rename also reaches dedupe-loser senderId', () => {
    const s = useAgentBeanStore.getState();
    s.applyAgentsSnapshot([
      physicalAgent('a-scan', { name: 'old', source: 'scanned' }),
      physicalAgent('a-self', { name: 'selfname', source: 'self-register' }),
    ]);
    // server 广播全量 snapshot（改名后，赢家新名 + 输家旧名）
    s.applyAgentsSnapshot([
      physicalAgent('a-scan', { name: 'old', source: 'scanned' }),
      physicalAgent('a-self', { name: 'NEW', source: 'self-register' }),
    ]);

    const agents = useAgentBeanStore.getState().agents;
    expect(agentDisplayName('a-scan', agents)).toBe('NEW');
  });

  test('visibleAgents dedupes merged records (member list has no duplicates)', () => {
    const s = useAgentBeanStore.getState();
    s.applyAgentsSnapshot([
      physicalAgent('a-scan', { name: 'old', source: 'scanned' }),
      physicalAgent('a-self', { name: 'selfname', source: 'self-register' }),
    ]);
    const visible = useAgentBeanStore.getState().visibleAgents;
    expect(visible).toHaveLength(1);
    expect(visible[0]?.id).toBe('a-self'); // self-register rank 高，是赢家
  });

  test('no regression: single record rename still works', () => {
    const s = useAgentBeanStore.getState();
    s.applyAgentsSnapshot([mk({ id: 'a1', name: 'old' })]);
    s.applyAgentStatus(mk({ id: 'a1', name: 'NEW' }));
    expect(useAgentBeanStore.getState().agents['a1']?.name).toBe('NEW');
  });

  test('no regression: hidden agent removed from views', () => {
    const s = useAgentBeanStore.getState();
    s.applyAgentsSnapshot([mk({ id: 'a1', name: 'old' })]);
    // primaryTeamId=t1 但 visibleTeamIds 不含 t1 → 不可见 → 删除
    s.applyAgentStatus(mk({ id: 'a1', name: 'NEW', primaryTeamId: 't1', visibleTeamIds: [] }));
    const state = useAgentBeanStore.getState();
    expect(state.agents['a1']).toBeUndefined();
    expect(state.visibleAgents.find((a) => a.id === 'a1')).toBeUndefined();
  });
});
