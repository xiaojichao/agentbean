import { createHash } from 'node:crypto';

import type { MemoryContentKind, MemoryScopeType, MemorySourceRefDto } from '@agentbean/contracts';

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

export interface ComputeProjectionHashInput {
  readonly proposedContent: string;
  readonly sourceRefs: readonly MemorySourceRefDto[];
  readonly scopeType: MemoryScopeType;
  readonly scopeRef: string;
  readonly contentKind: MemoryContentKind;
}

/**
 * Memory Candidate 的去重指纹（P3-10/11，issue #583，验收 #2）。
 *
 * 组合 proposedContent + sourceRefs + scope + contentKind，使"完全相同的候选提交"得到相同
 * projectionHash → 幂等返回已有 candidate，不产生重复 active Memory。复用 hashMemoryContent /
 * hashSourceRefs 单一源；故意不做 content normalize——candidate 去重靠严格字节相同，normalize
 * 的宽容去重留给 active Memory 的 assertNotDuplicate。
 */
export function computeProjectionHash(input: ComputeProjectionHashInput): string {
  const parts = [
    hashMemoryContent(input.proposedContent),
    hashSourceRefs(input.sourceRefs),
    input.scopeType,
    input.scopeRef,
    input.contentKind,
  ];
  return `sha256:${createHash('sha256').update(parts.join('|')).digest('hex')}`;
}
