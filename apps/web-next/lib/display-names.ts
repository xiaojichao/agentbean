export interface DisplayAgent {
  name?: string | null;
}

export interface DisplayHuman {
  id: string;
  username?: string | null;
  name?: string | null;
  kind?: 'human' | 'agent';
}

export interface CurrentDisplayUser {
  id: string;
  username: string;
}

export interface SpeakerMessage {
  senderKind: string;
  senderId?: string | null;
  metaJson?: string | null;
}

export interface SpeakerSources {
  currentUser?: CurrentDisplayUser | null;
  humanProfiles?: DisplayHuman[];
  channelMembers?: DisplayHuman[];
  mentionMembers?: DisplayHuman[];
}

export function cleanHumanName(name: string): string {
  return name.replace(/（你）$/, '').trim();
}

export function humanDisplayName(senderId: string | null | undefined, sources: SpeakerSources = {}, fallback = '成员'): string {
  if (!senderId) return fallback;
  if (sources.currentUser?.id === senderId) return sources.currentUser.username;

  const profile = sources.humanProfiles?.find((human) => human.id === senderId);
  const profileName = cleanHumanName(profile?.username ?? profile?.name ?? '');
  if (profileName) return profileName;

  const channelMember = sources.channelMembers?.find((member) => member.id === senderId && (!member.kind || member.kind === 'human'));
  const channelName = cleanHumanName(channelMember?.username ?? channelMember?.name ?? '');
  if (channelName) return channelName;

  const mentionMember = sources.mentionMembers?.find((member) => member.id === senderId && (!member.kind || member.kind === 'human'));
  const mentionName = cleanHumanName(mentionMember?.username ?? mentionMember?.name ?? '');
  if (mentionName) return mentionName;

  return fallback;
}

function cleanAgentName(name: string | null | undefined): string {
  return (name ?? '').trim();
}

function agentNameFromMeta(metaJson: string | null | undefined): string {
  if (!metaJson) return '';
  try {
    const meta = JSON.parse(metaJson) as { senderName?: unknown; agentName?: unknown };
    const senderName = typeof meta.senderName === 'string' ? meta.senderName : '';
    const agentName = typeof meta.agentName === 'string' ? meta.agentName : '';
    return cleanAgentName(senderName || agentName);
  } catch {
    return '';
  }
}

export function agentDisplayName(
  senderId: string | null | undefined,
  agents: Record<string, DisplayAgent>,
  sources: SpeakerSources = {},
  metaJson?: string | null,
  fallback = 'Agent',
): string {
  if (!senderId) return fallback;

  const agentName = cleanAgentName(agents[senderId]?.name);
  if (agentName) return agentName;

  const channelMember = sources.channelMembers?.find((member) => member.id === senderId && member.kind === 'agent');
  const channelName = cleanAgentName(channelMember?.name ?? channelMember?.username);
  if (channelName) return channelName;

  const mentionMember = sources.mentionMembers?.find((member) => member.id === senderId && member.kind === 'agent');
  const mentionName = cleanAgentName(mentionMember?.name ?? mentionMember?.username);
  if (mentionName) return mentionName;

  const metaName = agentNameFromMeta(metaJson);
  if (metaName) return metaName;

  return fallback;
}

export function messageSpeakerName(
  msg: SpeakerMessage,
  agents: Record<string, DisplayAgent>,
  sources: SpeakerSources = {},
): string {
  if (msg.senderKind === 'human') return humanDisplayName(msg.senderId, sources);
  if (msg.senderKind === 'agent') return agentDisplayName(msg.senderId, agents, sources, msg.metaJson);
  return '系统';
}
