export interface ChannelVisibilityInput {
  visibility: 'public' | 'private';
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
