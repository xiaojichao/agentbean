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

export function messageSpeakerName(
  msg: SpeakerMessage,
  agents: Record<string, DisplayAgent>,
  sources: SpeakerSources = {},
): string {
  if (msg.senderKind === 'human') return humanDisplayName(msg.senderId, sources);
  if (msg.senderKind === 'agent') return msg.senderId ? (agents[msg.senderId]?.name ?? 'Agent') : 'Agent';
  return '系统';
}
