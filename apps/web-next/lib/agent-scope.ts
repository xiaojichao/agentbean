import type { AgentSnapshot } from './schema';

export function agentVisibleInTeam(
  agent: Pick<AgentSnapshot, 'primaryTeamId' | 'visibleTeamIds' | 'visibility'>,
  teamId: string,
): boolean {
  // PR#368: visibleTeamIds 是权威可见性（由 hidden_from_primary_team 折算）。
  // 当 agent 的 primaryTeamId 即当前团队、却被显式隐藏（visibleTeamIds 不含该团队）时，
  // 判定不可见——覆盖下方 primaryTeamId === teamId 的兜底，避免 hidden agent
  // 仍被判可见、经 status 推送被 merge 回成员页 store（表现为「没消失变不在线」）。
  if (agent.primaryTeamId === teamId && !agent.visibleTeamIds.includes(teamId)) {
    return false;
  }
  return agent.visibleTeamIds.includes(teamId) ||
    agent.primaryTeamId === teamId ||
    agent.visibility === 'public';
}
