/**
 * #1065 AC7:output-package 投影一致性(watermark 对照)。
 *
 * Chat/Task/Files 三处投影消费同一组 output-package 查询。查询带
 * minimumConsistency 时对照 `system_activity_watermarks`(stream_kind='output-package',
 * stream_id=channelId,revision=该频道 package 写命令成功序列)判读投影是否已追上
 * 客户端声明的最低位置;未追上 → projection_not_ready,不以旧数据伪装成功。
 *
 * 写路径(review/finalize/reject-delivery/revision/formation 任一成功)由
 * `bumpOutputPackageWatermark` 推进水位,保证 read-your-writes 语义。
 * systemActivity 仓储未接线(纯 harness)时查询放行,不影响既有行为。
 */
import { checkMinimumConsistency, streamKey } from '../../../../packages/domain/src/index.js';
import { makeFailure, type ConsistencyTokenV1, type UnixMs, type FailureAck } from '../../../../packages/contracts/src/index.js';
import type { ServerNextRepositories } from './repositories.js';

/**
 * 查询级一致性检查。无 minimum token → null(直接放行)。
 * 投影未追到最低位置 → 结构化 failure(PROJECTION_NOT_READY + notReadyStreams)。
 */
export async function ensureOutputPackageConsistency(
  repositories: ServerNextRepositories,
  minimum: ConsistencyTokenV1 | undefined,
): Promise<FailureAck | null> {
  if (!minimum || minimum.entries.length === 0) return null;
  const watermarks = repositories.systemActivity?.watermarks;
  if (!watermarks) return null;
  const rows = await watermarks.listAll();
  const map = new Map<string, number>();
  for (const row of rows) {
    map.set(streamKey(row.streamKind, row.streamId), row.revision);
  }
  const check = checkMinimumConsistency({ minimum, currentWatermarks: map });
  if (check.kind === 'ready') return null;
  return makeFailure(
    'PROJECTION_NOT_READY',
    'Output package projection has not caught up to minimum consistency token',
    { notReadyStreams: check.notReadyStreams },
  );
}

/**
 * package 写命令(形成/review/finalize/reject-delivery/revision)成功后推进
 * 该频道 output-package stream 水位;查询带旧 token 时据此返回 projection_not_ready。
 */
export async function bumpOutputPackageWatermark(
  repositories: ServerNextRepositories,
  channelId: string,
  updatedAt: UnixMs,
): Promise<void> {
  const watermarks = repositories.systemActivity?.watermarks;
  if (!watermarks) return;
  const current = await watermarks.get('output-package', channelId);
  await watermarks.upsert({
    streamKind: 'output-package',
    streamId: channelId,
    revision: (current?.revision ?? 0) + 1,
    updatedAt,
  });
}
