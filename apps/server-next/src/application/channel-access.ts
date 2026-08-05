// server-next 惯例:workspace 包用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import { makeFailure, makeSuccess, type Ack, type ChannelDto } from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';

/**
 * 频道可见性鉴权深模块(候选 01/02 深化 slice 2)。
 *
 * 从 god-factory(usecases.ts)中提出的最广用共享 helper(原 45 调用点):校验用户对某
 * 频道的读取可见性。只依赖 repositories.channels/teams,不调任何 god-factory 本地 helper,
 * 也不读任何闭包状态——因此可独立成模块,作为后续所有"搬方法"切片的共享基建。
 *
 * 返回的 channel 带 humanMemberIds/agentMemberIds,供调用方做进一步成员判定;
 * 私有频道要求调用方在 humanMemberIds 中。
 *
 * _Avoid_: 入口鉴权(只校验可见,不授予权限)、Inbox membership、写授权、跨频道判定。
 */
export async function ensureUserCanViewChannel(
  repositories: ServerNextRepositories,
  input: { userId: string; teamId: string; channelId: string },
): Promise<Ack<{ channel: ChannelDto & { humanMemberIds: string[]; agentMemberIds: string[] } }>> {
  const channel = await repositories.channels.getById(input.channelId);
  if (!channel || channel.teamId !== input.teamId) {
    return makeFailure('NOT_FOUND', 'Channel not found');
  }
  if (channel.visibility === 'private' && !channel.humanMemberIds.includes(input.userId)) {
    return makeFailure('FORBIDDEN', 'User cannot view channel');
  }
  return makeSuccess({ channel });
}
