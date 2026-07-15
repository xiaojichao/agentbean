import { createHash } from 'node:crypto';

import type { MemoryCapsuleItemDto, MemorySourceRefDto } from '@agentbean/contracts';

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

/**
 * Capsule 级聚合哈希:把一个 Capsule 全部 item 的内容+来源指纹聚合成单一 `contentHash`,
 * 供 `MemoryCapsuleRefDto.contentHash`(Task 6 固化进 immutable Invocation intent)。
 *
 * 聚合每项 `authorization.contentHash` + `authorization.sourceRefsHash`,升序排序后 join,
 * 与 item 顺序无关——同一组 item 无论排列都产生同一 capsule 级哈希。任一 item 的内容或来源
 * 变化 → 该项 authorization 哈希变 → capsule 级哈希变 → intentHash 变 → 重放/恢复检出漂移。
 */
export function hashCapsuleItems(items: readonly MemoryCapsuleItemDto[]): string {
  const canonical = items
    .map((item) => `${item.authorization.contentHash}:${item.authorization.sourceRefsHash}`)
    .sort()
    .join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}
