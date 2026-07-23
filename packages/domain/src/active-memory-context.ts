import { createHash } from 'node:crypto';

import type {
  ActiveMemoryAttributionDto,
  ActiveMemoryAttributionEntryDto,
  ActiveMemoryContextDto,
  ActiveMemoryContextItemDto,
  ActiveMemoryProvenanceDto,
  ActiveMemorySelectionReason,
  ActiveMemorySourceCode,
  MemoryKind,
  MemoryScopeType,
  MemoryStatus,
} from '@agentbean/contracts';

import { evaluateMemoryInjection } from './memory-policy.js';
import type { MemoryInjectionDenialReason } from './memory-policy.js';

/**
 * Active Memory Context 组装（issue #720，ADR 0008）。
 *
 * 这是 Coordinator 与 ManagementRun 共享的「同一权限过滤接缝」的 domain 侧（AC#8）。
 * server 侧 `ActiveMemoryContextResolver` 已完成权限预判并把结果注入候选；本模块只做
 * 最终硬门禁复验（AC#2 每次校验）+ 相关度排序 + 截断（AC#1「少量」）+ 幂等哈希（AC#7）。
 * 全程无 I/O，可独立单测；runtime 包不 import 本模块（boundary 合规）。
 */

/**
 * 组装输入的单条候选。server 已注入权限预判结果（scopeVisible / allSourcesAvailable）
 * 与相关度分数（relevanceScore）；domain 只复验硬门禁，不重新查询。
 */
export interface ActiveMemoryCandidate {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scopeType: MemoryScopeType;
  readonly content: string;
  readonly status: MemoryStatus;
  readonly validUntil?: number;
  readonly provenance: ActiveMemoryProvenanceDto;
  readonly selectionReason: ActiveMemorySelectionReason;
  /** server 预判：scope 对当前消费者可见（canReadMemoryScope 结果）。 */
  readonly scopeVisible: boolean;
  /** server 预判：所有来源仍可用（isServerMemorySourceAvailable 结果）。 */
  readonly allSourcesAvailable: boolean;
  /** 相关度分数（rankMemories 计算）；server 注入，domain 不重算。 */
  readonly relevanceScore: number;
}

export interface AssembleActiveMemoryContextInput {
  readonly candidates: readonly ActiveMemoryCandidate[];
  readonly now: number;
  /** 最小 context 上限（AC#1「少量」），由 server 传入。 */
  readonly limit: number;
}

/** 被硬门禁拒绝的候选（AC#3 默认不可见的可观测记录）。 */
export interface ExcludedActiveMemory {
  readonly id: string;
  readonly source: ActiveMemorySourceCode;
  readonly reason: MemoryInjectionDenialReason;
}

export interface AssembleActiveMemoryContextResult {
  readonly context: ActiveMemoryContextDto;
  readonly attribution: ActiveMemoryAttributionDto;
  readonly excluded: readonly ExcludedActiveMemory[];
}

/** 候选 → context item 的机械投影。 */
export function candidateToContextItem(candidate: ActiveMemoryCandidate): ActiveMemoryContextItemDto {
  return {
    schemaVersion: 1,
    id: candidate.id,
    kind: candidate.kind,
    scopeType: candidate.scopeType,
    content: candidate.content,
    selectionReason: candidate.selectionReason,
    provenance: candidate.provenance,
  };
}

/** items → attribution（只取 id+source+selectionReason，不存正文，AC#5）。 */
export function buildAttribution(
  items: readonly ActiveMemoryContextItemDto[],
  contextHash: string,
): ActiveMemoryAttributionDto {
  const entries: readonly ActiveMemoryAttributionEntryDto[] = items.map((item) => ({
    id: item.id,
    source: item.provenance.source,
    selectionReason: item.selectionReason,
  }));
  return { schemaVersion: 1, entries, contextHash };
}

/**
 * Active Memory Context 的幂等哈希（AC#7）。按 `source:id` 升序 join `|` 后 sha256，
 * 与 items 顺序无关——相同可见集合产生相同 hash，重放可重复。空集合退化为固定常量。
 */
export function computeActiveMemoryContextHash(items: readonly ActiveMemoryContextItemDto[]): string {
  const canonical = items
    .map((item) => `${item.provenance.source}:${item.id}`)
    .sort()
    .join('|');
  return `sha256:${createHash('sha256').update(canonical).digest('hex')}`;
}

/**
 * 来源配额截断（保多样性，learning 决策）：allowed 已按（分数降序, id 升序）稳定排序；
 * 保底每来源 floor(limit/来源数) 条（至少 1），余量按分数补满到 limit。来源顺序取 allowed
 * 首次出现顺序（稳定），保证幂等（AC#7：相同输入→相同 selected→相同 hash）。
 */
function selectBySourceQuota(
  allowed: readonly ActiveMemoryCandidate[],
  limit: number,
): ActiveMemoryCandidate[] {
  if (allowed.length === 0 || limit <= 0) return [];
  const sourceOrder: ActiveMemorySourceCode[] = [];
  for (const candidate of allowed) {
    if (!sourceOrder.includes(candidate.provenance.source)) {
      sourceOrder.push(candidate.provenance.source);
    }
  }
  const quota = Math.max(1, Math.floor(limit / sourceOrder.length));
  const selected: ActiveMemoryCandidate[] = [];
  const seen = new Set<string>();
  const takeFromSource = (source: ActiveMemorySourceCode, max: number): void => {
    let count = 0;
    for (const candidate of allowed) {
      if (count >= max) break;
      if (candidate.provenance.source === source && !seen.has(candidate.id)) {
        selected.push(candidate);
        seen.add(candidate.id);
        count += 1;
      }
    }
  };
  for (const source of sourceOrder) takeFromSource(source, quota);
  for (const candidate of allowed) {
    if (selected.length >= limit) break;
    if (!seen.has(candidate.id)) {
      selected.push(candidate);
      seen.add(candidate.id);
    }
  }
  return selected.slice(0, limit);
}

/**
 * 组装最小 Active Memory Context（AC#1/2/3/7/8 的 domain 核心接缝）。
 *
 * 流程：逐条复验 `evaluateMemoryInjection` 硬门禁（AC#2 每次校验）→ 拒绝项进 `excluded`
 * 并带 source+reason（AC#3 可观测）→ 通过项稳定排序后按来源配额截断到 `limit`
 * （AC#1「少量」+ 保多样性）→ 产出 context + attribution + contextHash（AC#7 幂等）。
 */
export function assembleActiveMemoryContext(
  input: AssembleActiveMemoryContextInput,
): AssembleActiveMemoryContextResult {
  // 硬门禁过滤（AC#2 每次校验）：逐条复验 evaluateMemoryInjection；denied → excluded。
  const excluded: ExcludedActiveMemory[] = [];
  const allowed: ActiveMemoryCandidate[] = [];
  for (const candidate of input.candidates) {
    const decision = evaluateMemoryInjection({
      status: candidate.status,
      validUntil: candidate.validUntil,
      now: input.now,
      scopeVisible: candidate.scopeVisible,
      allSourcesAvailable: candidate.allSourcesAvailable,
    });
    if (decision.allowed) {
      allowed.push(candidate);
    } else {
      excluded.push({
        id: candidate.id,
        source: candidate.provenance.source,
        reason: decision.reason,
      });
    }
  }

  // 稳定全序排序（分数降序, 平局 id 升序）+ 来源配额截断。稳定排序与固定来源顺序
  // 共同保证：相同输入必然产生相同 selected → 相同 contextHash（AC#7 幂等）。
  allowed.sort(
    (a, b) =>
      b.relevanceScore - a.relevanceScore || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  const selected = selectBySourceQuota(allowed, input.limit);

  const items = selected.map(candidateToContextItem);
  const contextHash = computeActiveMemoryContextHash(items);
  const context: ActiveMemoryContextDto = {
    schemaVersion: 1,
    items,
    contextHash,
    assembledAt: input.now,
  };
  return {
    context,
    attribution: buildAttribution(items, contextHash),
    excluded,
  };
}
