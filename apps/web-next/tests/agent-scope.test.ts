import { describe, expect, test } from 'vitest';
import { agentVisibleInNetwork } from '../lib/agent-scope';

// PR#368 后 visibleTeamIds 是权威可见性（hidden_from_primary_team 折算）。
// agentVisibleInNetwork 必须在 primaryTeamId===当前团队 但 visibleTeamIds 不含该团队时
// 判定不可见，否则 hidden agent 会经 status 推送被 merge 回成员页 store。
describe('agentVisibleInNetwork (hidden 语义)', () => {
  test('hidden agent（primaryTeamId=当前, visibleTeamIds=[]）对当前团队不可见', () => {
    expect(agentVisibleInNetwork({ primaryTeamId: 'team-1', visibleTeamIds: [] } as never, 'team-1')).toBe(false);
  });

  test('visible agent（primaryTeamId=当前, visibleTeamIds=[当前]）可见', () => {
    expect(agentVisibleInNetwork({ primaryTeamId: 'team-1', visibleTeamIds: ['team-1'] } as never, 'team-1')).toBe(true);
  });

  test('primaryTeamId 是别的团队、且无任何可见标记时不可见', () => {
    expect(agentVisibleInNetwork({ primaryTeamId: 'team-2', visibleTeamIds: [] } as never, 'team-1')).toBe(false);
  });
});
