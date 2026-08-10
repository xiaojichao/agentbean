import type { ChannelProjectOverviewDto } from '@agentbean/contracts';

/**
 * #1179：按 profile.revision 接受 ChannelProjectOverview，防止旧 Socket/HTTP 响应覆盖新配置。
 * 同 revision 时取 updatedAt 较新的快照；null 表示频道尚无项目画像。
 */
export function acceptChannelProjectOverview(
  current: ChannelProjectOverviewDto | null | undefined,
  incoming: ChannelProjectOverviewDto | null,
): ChannelProjectOverviewDto | null {
  if (incoming == null) return null;
  if (current == null) return incoming;
  if (current.profile.channelId !== incoming.profile.channelId
    || current.profile.teamId !== incoming.profile.teamId) {
    return incoming;
  }
  if (incoming.profile.revision < current.profile.revision) return current;
  if (incoming.profile.revision > current.profile.revision) return incoming;
  if (incoming.profile.updatedAt < current.profile.updatedAt) return current;
  return incoming;
}
