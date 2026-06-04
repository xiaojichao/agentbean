export interface ChannelVisibilityInput {
  visibility: 'public' | 'private';
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}

export interface ChannelCreateMembershipInput {
  visibility: 'public' | 'private';
  createdBy: string;
  humanMemberIds?: string[];
}

export interface ChannelControlInput {
  name: string;
  visibility: 'public' | 'private';
  createdBy?: string;
}

export interface ChannelUpdateIntent {
  name?: string;
  title?: string;
  visibility?: 'public' | 'private';
  humanMemberIds?: string[];
  agentMemberIds?: string[];
}

export type ChannelViewer =
  | { kind: 'human'; memberId: string }
  | { kind: 'agent'; memberId: string };

export function canViewChannel(channel: ChannelVisibilityInput, viewer: ChannelViewer): boolean {
  if (channel.visibility === 'public') {
    return true;
  }

  if (viewer.kind === 'human') {
    return Boolean(channel.humanMemberIds?.includes(viewer.memberId));
  }

  return Boolean(channel.agentMemberIds?.includes(viewer.memberId));
}

export function channelHumanMembersForCreate(input: ChannelCreateMembershipInput): string[] {
  return uniqueMembers([
    ...(input.humanMemberIds ?? []),
    ...(input.visibility === 'private' ? [input.createdBy] : []),
  ]);
}

export function canApplyChannelUpdate(
  channel: ChannelControlInput,
  actorUserId: string,
  update: ChannelUpdateIntent,
): boolean {
  if (!channel.createdBy || channel.createdBy !== actorUserId) {
    return false;
  }

  if (!isDefaultChannel(channel)) {
    return true;
  }

  const changedFields = Object.keys(update);
  return changedFields.length > 0 && changedFields.every((field) => field === 'title');
}

export function isDefaultChannel(channel: Pick<ChannelControlInput, 'name'>): boolean {
  return channel.name === 'all';
}

function uniqueMembers(memberIds: string[]): string[] {
  return Array.from(new Set(memberIds.filter(Boolean)));
}
