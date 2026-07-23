import type { ID, UnixMs } from './common.js';
import type { MemoryKind, MemoryScopeType } from './management-memory.js';
import type { FormalMemoryKind } from './formal-memory.js';

/**
 * PI 最小 Active Memory Context（issue #720，ADR 0008）。
 *
 * Coordinator 与 ManagementRun 不再各自拼装 memory，而是通过 server 侧同一个
 * `ActiveMemoryContextResolver` 产出本 DTO。Resolver 已完成全部权限过滤（ADR 0044：
 * 来源作用域决定可见性，可追溯性不越过原始权限），消费者只做渲染/透传。
 *
 * 与 `DispatchMemoryContextItemDto`（Agent 执行路径）的区别：
 * - provenance 按 PI 来源（team/channel/task/agent projection/pack）判别，不经 Invocation Capsule；
 * - scopeType 只含 server-hosted scope（无 Device-local）；
 * - selectionReason 为有限枚举（AC#6：面向用户的来源解释天然不携带身份信息）。
 */

/**
 * Active Memory 来源码。4 个已实现来源 + 1 个 reserved（experience_pack）。
 * `experience_pack` 为切片 E（频道归档/经验传递）预留：DTO/组装器/门禁现在就能处理它，
 * 只是 resolver 暂不产出——切片 E 建 Pack 数据模型时只需在 resolver 增一条查询路径。
 */
export const ACTIVE_MEMORY_SOURCE_CODES = [
  'team_formal_memory',
  'channel_formal_memory',
  'task_fact',
  'agent_projection',
  'experience_pack', // RESERVED — 切片 E
] as const;
export type ActiveMemorySourceCode = (typeof ACTIVE_MEMORY_SOURCE_CODES)[number];

/**
 * 来源选择理由（AC#6）。有限枚举，不携带具体来源身份：暴露给用户时不会泄漏
 * 「是哪条 Team/Channel Memory」「ranking 分数」等不可见信息。
 */
export const ACTIVE_MEMORY_SELECTION_REASONS = [
  'current_team_policy',
  'current_channel_context',
  'current_task_scope',
  'enabled_agent_projection',
  'linked_experience_pack', // reserved
  'prompt_relevance',
] as const;
export type ActiveMemorySelectionReason = (typeof ACTIVE_MEMORY_SELECTION_REASONS)[number];

/**
 * 来源判别联合（`source` 为判别字段）。forward-compatible：新来源加分支即可。
 * `id` 的语义随 source 变化：formal/task = memory_items id；projection = projection id；pack = pack id。
 */
export type ActiveMemoryProvenanceDto =
  | {
      readonly source: 'team_formal_memory';
      readonly memoryId: ID;
      readonly formalKind: FormalMemoryKind;
    }
  | {
      readonly source: 'channel_formal_memory';
      readonly memoryId: ID;
      readonly formalKind: FormalMemoryKind;
    }
  | {
      readonly source: 'task_fact';
      readonly memoryId: ID;
      readonly taskId: ID;
    }
  | {
      readonly source: 'agent_projection';
      readonly projectionId: ID;
      readonly agentId: ID;
      readonly agentName: string;
    }
  | {
      readonly source: 'experience_pack'; // RESERVED — 切片 E
      readonly packId: ID;
    };

/** 单条 Active Memory。content 已由 resolver 过滤+脱敏。 */
export interface ActiveMemoryContextItemDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly kind: MemoryKind;
  readonly scopeType: MemoryScopeType;
  readonly content: string;
  readonly selectionReason: ActiveMemorySelectionReason;
  readonly provenance: ActiveMemoryProvenanceDto;
}

/**
 * 组装完成的 Active Memory Context。
 * `contextHash` 由 domain `computeActiveMemoryContextHash` 产出（按 source:id 升序 sha256），
 * 保证相同可见集合产生相同 hash（AC#7 幂等）；`assembledAt` 为组装时刻，AC#2 每次重校验依据。
 */
export interface ActiveMemoryContextDto {
  readonly schemaVersion: 1;
  readonly items: readonly ActiveMemoryContextItemDto[];
  readonly contextHash: string;
  readonly assembledAt: UnixMs;
}

/**
 * 单条归因记录。`id` 语义随 `source`：formal/task = memoryId，projection = projectionId，pack = packId。
 * 只存 ID + 来源码 + 理由码，**绝不存正文/prompt**（AC#5，遵守 ChannelCoordinationDecisionRecord:77 约束）。
 */
export interface ActiveMemoryAttributionEntryDto {
  readonly id: ID;
  readonly source: ActiveMemorySourceCode;
  readonly selectionReason: ActiveMemorySelectionReason;
}

/**
 * 实际影响决策的来源归因（AC#5 审计载体）。Coordinator 写入 Decision.memoryAttribution，
 * ManagementRun 写入 checkpoint.contextHints。`contextHash` 与 ActiveMemoryContextDto 对齐。
 */
export interface ActiveMemoryAttributionDto {
  readonly schemaVersion: 1;
  readonly entries: readonly ActiveMemoryAttributionEntryDto[];
  readonly contextHash: string;
}
