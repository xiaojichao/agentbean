import { createHash } from 'node:crypto';

import type { MemorySourceRefDto } from '@agentbean/contracts';

/**
 * Capsule 内容与来源指纹的**单一哈希源**。
 *
 * Capsule 创建（P3-06）冻结这两个哈希进 `MemoryCapsuleAuthorizationDto`，注入复验（P3-07）
 * 用当前 memory 内容/来源重算并逐字段比对，发现漂移即 fail-closed。两边（以及测试）必须
 * import 同一份实现，跨包复制必然漂移导致误判。来源指纹按 `sourceKind:sourceId:snapshotHash`
 * 升序 join `|`，与来源顺序无关。
 */

export function hashMemoryContent(content: string): string {
  return `sha256:${createHash('sha256').update(content).digest('hex')}`;
}

export function hashSourceRefs(refs: readonly MemorySourceRefDto[]): string {
  const canonical = [...refs]
    .map((ref) => `${ref.sourceKind}:${ref.sourceId}:${ref.snapshotHash}`)
    .sort()
    .join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
