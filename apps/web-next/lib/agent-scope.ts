import type { AgentSnapshot } from './schema';

export function agentVisibleInNetwork(
  agent: Pick<AgentSnapshot, 'networkId' | 'publishedNetworkIds' | 'unpublishedNetworkIds' | 'primaryTeamId' | 'visibleTeamIds' | 'visibility'>,
  networkId: string,
): boolean {
  if (agent.unpublishedNetworkIds?.includes(networkId)) return false;
  // PR#368: visibleTeamIds 是权威可见性（由 hidden_from_primary_team 折算）。
  // 当 agent 的 primaryTeamId 即当前团队、却被显式隐藏（visibleTeamIds 不含该团队）时，
  // 判定不可见——覆盖下方 primaryTeamId === networkId 的兜底，避免 hidden agent
  // 仍被判可见、经 status 推送被 merge 回成员页 store（表现为「没消失变不在线」）。
  if (agent.primaryTeamId === networkId && agent.visibleTeamIds && !agent.visibleTeamIds.includes(networkId)) {
    return false;
  }
  return Boolean(agent.publishedNetworkIds?.includes(networkId)) ||
    Boolean(agent.visibleTeamIds?.includes(networkId)) ||
    agent.networkId === networkId ||
    agent.primaryTeamId === networkId ||
    agent.visibility === 'public';
}
