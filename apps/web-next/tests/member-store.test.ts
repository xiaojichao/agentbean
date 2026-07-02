import { beforeEach, describe, expect, test } from 'vitest';
import { useAgentBeanStore } from '../lib/store';
import type { HumanMember } from '../lib/schema';

const HUMANS: HumanMember[] = [
  { userId: 'u1', role: 'owner', username: 'alice' },
  { userId: 'u2', role: 'member', username: 'bob' },
];

function resetStore() {
  useAgentBeanStore.setState({ humans: [], agents: {}, currentTeamId: 'default' });
}

// 人类成员列表闪烁根因：humanMembers 原本是组件本地 useState，每次 MembersPage 卸载重挂
// （在 /members ↔ /human/[id] ↔ /agent/[id] 间导航，三者都渲染独立 <MembersPage /> 实例）
// 都从 [] 重新开始，fetch 回填前显示"暂无用户"空态 → 闪烁。agents 不闪是因为它在全局 store。
// 修复：把 humans 提升进全局 store，跨重挂持久可读。下面测试锁定该持久化能力。
describe('human members store — flicker fix', () => {
  beforeEach(resetStore);

  test('humans loaded into the store persist for a subsequent mount without re-fetching', () => {
    // 模拟第一个 MembersPage 实例 fetch 后写入 store
    useAgentBeanStore.getState().applyHumansSnapshot(HUMANS);

    // 模拟导航后【新的】MembersPage 实例挂载：它应直接读到已填充的 humans，
    // 而不必等自己的 fetch 解析——这正是消除"消失→出现"空窗的关键。
    const humansVisibleToNewMount = useAgentBeanStore.getState().humans;

    expect(humansVisibleToNewMount).toEqual(HUMANS);
  });

  test('switching teams clears humans so a stale list from another team never leaks', () => {
    useAgentBeanStore.getState().applyHumansSnapshot(HUMANS);
    useAgentBeanStore.getState().setCurrentTeamId('other-team');

    expect(useAgentBeanStore.getState().humans).toEqual([]);
  });

  test('late snapshots from a previous team are ignored after switching teams', () => {
    useAgentBeanStore.getState().setCurrentTeamId('team-a');
    useAgentBeanStore.getState().setCurrentTeamId('team-b');

    useAgentBeanStore.getState().applyHumansSnapshot(HUMANS, 'team-a');

    expect(useAgentBeanStore.getState().humans).toEqual([]);
  });

  test('removeHuman drops by userId; upsertHuman updates in place or inserts', () => {
    useAgentBeanStore.getState().applyHumansSnapshot(HUMANS);

    useAgentBeanStore.getState().removeHuman('u2');
    expect(useAgentBeanStore.getState().humans.map((h) => h.userId)).toEqual(['u1']);

    // onUpdated 路径：已存在成员原地更新
    useAgentBeanStore.getState().upsertHuman({ userId: 'u1', role: 'admin', username: 'alice' });
    expect(useAgentBeanStore.getState().humans.find((h) => h.userId === 'u1')?.role).toBe('admin');

    // upsert 语义：不存在则插入
    useAgentBeanStore.getState().upsertHuman({ userId: 'u3', role: 'member', username: 'carol' });
    expect(useAgentBeanStore.getState().humans.map((h) => h.userId)).toEqual(['u1', 'u3']);
  });
});
