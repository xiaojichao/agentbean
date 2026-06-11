export type RouteAgentStatus = 'connecting' | 'online' | 'busy' | 'offline' | 'error' | 'unknown';

export interface RouteAgent {
  id: string;
  name: string;
  status: RouteAgentStatus;
  visibleTeamIds?: string[];
  channelIds?: string[];
}

export interface RouteHumanMember {
  id: string;
  username: string;
  displayName?: string;
}

export interface RouteMessageInput {
  body: string;
  agents: RouteAgent[];
  humanMembers: RouteHumanMember[];
  teamId?: string;
  channelId?: string;
}

export type RouteResult =
  | { kind: 'dispatch'; agentId: string; reason: 'mention' | 'fallback' | 'direct' }
  | { kind: 'no-dispatch'; reason: 'unknown-mention' | 'human-mention' | 'no-online-agent' };

export function normalizeMentionName(value: string): string {
  return value.trim().toLowerCase().replace(/[\s_]+/g, '-').replace(/-+/g, '-');
}

export function routeMessage(input: RouteMessageInput): RouteResult {
  const mention = parseLeadingMentionText(input.body);
  const eligibleAgents = input.agents.filter((agent) => isEligibleOnlineAgent(agent, input));

  if (mention) {
    const mentionedHuman = input.humanMembers.some((member) => {
      return [member.username, member.displayName]
        .filter((value): value is string => Boolean(value))
        .some((name) => mentionMatchesName(mention, name));
    });

    if (mentionedHuman) {
      return { kind: 'no-dispatch', reason: 'human-mention' };
    }

    const mentionedAgent = eligibleAgents.find(
      (agent) => mentionMatchesName(mention, agent.name),
    );

    if (mentionedAgent) {
      return { kind: 'dispatch', agentId: mentionedAgent.id, reason: 'mention' };
    }

    return { kind: 'no-dispatch', reason: 'unknown-mention' };
  }

  const fallbackAgent = eligibleAgents[0];
  if (fallbackAgent) {
    return { kind: 'dispatch', agentId: fallbackAgent.id, reason: 'fallback' };
  }

  return { kind: 'no-dispatch', reason: 'no-online-agent' };
}

function parseLeadingMentionText(body: string): string | undefined {
  const match = body.trimStart().match(/^@(.+)/);
  return match?.[1];
}

function mentionMatchesName(mentionText: string, name: string): boolean {
  const normalizedMention = normalizeMentionName(mentionText);
  const normalizedName = normalizeMentionName(name);
  return normalizedMention === normalizedName || normalizedMention.startsWith(`${normalizedName}-`);
}

function isEligibleOnlineAgent(agent: RouteAgent, input: RouteMessageInput): boolean {
  if (agent.status !== 'online') {
    return false;
  }
  if (input.teamId && agent.visibleTeamIds && !agent.visibleTeamIds.includes(input.teamId)) {
    return false;
  }
  if (input.channelId && agent.channelIds && !agent.channelIds.includes(input.channelId)) {
    return false;
  }
  return true;
}
