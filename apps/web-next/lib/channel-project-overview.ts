import type { ChannelProjectOverviewDto } from '@agentbean/contracts';

/**
 * #1179：按 profile.revision 接受 ChannelProjectOverview，防止旧 Socket/HTTP 响应覆盖新配置。
 * 同 revision 时取 updatedAt 较新的快照。
 *
 * 入站 null 仅在本地尚无已建立画像时采纳（例如首次查询、频道切换后已置 undefined）。
 * 已有 overview 时忽略 stale null，避免刚创建阶段后被并发旧响应清空。
 */
export function acceptChannelProjectOverview(
  current: ChannelProjectOverviewDto | null | undefined,
  incoming: ChannelProjectOverviewDto | null,
): ChannelProjectOverviewDto | null {
  if (incoming == null) {
    return current == null ? null : current;
  }
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
