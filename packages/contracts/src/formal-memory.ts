import type { ID, UnixMs } from './common.js';
import type {
  MemoryKind,
  MemorySourceRefDto,
  MemoryStatus,
} from './management-memory.js';

/**
 * Formal Memory 产品投影层（issue #716）。
 *
 * 底层 Phase 3 的 `memory_items` 用 6 类 `MemoryKind` 存储协作记忆；Formal Memory
 * 是面向 Team Owner/Admin 的产品入口，只暴露 4 类 `FormalMemoryKind`，并通过存储
 * 适配层映射到底层 kind（设计文档 §6.5）。历史 `episodic/artifact-summary` 不进入
 * Formal 入口（AC#7），由 `storageKindToFormalKind` 返回 null 自然排除。
 */
export const FORMAL_MEMORY_KINDS = ['fact', 'decision', 'rule', 'preference'] as const;
export type FormalMemoryKind = (typeof FORMAL_MEMORY_KINDS)[number];

/** Formal Memory 只允许 Team 与 Channel 两种作用域（AC#5）。 */
export const FORMAL_MEMORY_SCOPE_TYPES = ['team', 'channel'] as const;
export type FormalMemoryScopeType = (typeof FORMAL_MEMORY_SCOPE_TYPES)[number];

export type FormalCorrectionType = 'revise' | 'delete';

/**
 * 产品 formal kind → 底层存储 MemoryKind（§6.5 适配层）。
 * fact→semantic、rule→procedural、decision/preference 原样。
 */
export function formalKindToStorageKind(kind: FormalMemoryKind): MemoryKind {
  switch (kind) {
    case 'fact':
      return 'semantic';
    case 'decision':
      return 'decision';
    case 'rule':
      return 'procedural';
    case 'preference':
      return 'preference';
  }
}

/**
 * 底层存储 MemoryKind → 产品 formal kind。仅 formal 记录返回值；
 * `episodic/artifact-summary` 返回 null（AC#7：不进入 Formal 入口）。
 */
export function storageKindToFormalKind(kind: MemoryKind): FormalMemoryKind | null {
  switch (kind) {
    case 'semantic':
      return 'fact';
    case 'procedural':
      return 'rule';
    case 'decision':
      return 'decision';
    case 'preference':
      return 'preference';
    case 'episodic':
    case 'artifact-summary':
      return null;
  }
}

export interface FormalMemoryDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly kind: FormalMemoryKind;
  readonly status: MemoryStatus;
  readonly scopeType: FormalMemoryScopeType;
  readonly scopeRef: ID;
  /** channel scope 时的频道 id，便于前端按频道过滤（AC#5）。 */
  readonly channelId?: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags: readonly string[];
  readonly sourceRefs: readonly MemorySourceRefDto[];
  /** 最近一次人工变更原因（AC#4）。 */
  readonly changeReason?: string;
  readonly validFrom?: UnixMs;
  readonly validUntil?: UnixMs;
  readonly supersededById?: ID;
  /** 版本族 id（初版=自身 id，supersede 时继承）；版本历史按此聚合（AC#4）。 */
  readonly versionFamilyId: ID;
  readonly createdByUserId?: ID;
  readonly createdByAgentId?: ID;
  readonly approvedByUserId?: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/** 版本历史单条（从同 versionFamilyId 的 memory_items 行投影，AC#4）。 */
export interface FormalMemoryVersionDto {
  readonly versionId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly status: MemoryStatus;
  readonly actorUserId?: ID;
  readonly actorAgentId?: ID;
  readonly createdAt: UnixMs;
  readonly sourceRefs: readonly MemorySourceRefDto[];
}

export interface FormalMemoryDetailDto extends FormalMemoryDto {
  /** 版本历史，按创建时间升序（最早在前）。 */
  readonly versions: readonly FormalMemoryVersionDto[];
}

export interface FormalMemoryListDto {
  readonly schemaVersion: 1;
  readonly teamId: ID;
  readonly scopeType: FormalMemoryScopeType;
  readonly scopeRef: ID;
  readonly channelId?: ID;
  /** 当前用户能否管理（Owner/Admin）。 */
  readonly canManage: boolean;
  /** 当前用户能否提交纠错（Team/Channel 成员）。 */
  readonly canProposeCorrection: boolean;
  readonly items: readonly FormalMemoryDto[];
}

// ---- 命令输入 ----

export interface CreateFormalMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly kind: FormalMemoryKind;
  readonly scopeType: FormalMemoryScopeType;
  readonly scopeRef: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  readonly changeReason?: string;
  readonly sourceRefs?: readonly MemorySourceRefDto[];
  readonly validUntil?: UnixMs;
}

export interface ReviseFormalMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly content: string;
  readonly summary?: string;
  readonly tags?: readonly string[];
  /** 修订原因（AC#4，必填）。 */
  readonly changeReason: string;
  readonly sourceRefs?: readonly MemorySourceRefDto[];
}

export interface DeactivateFormalMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
  /** 停用原因（AC#4，必填；与「时间过期」区分）。 */
  readonly changeReason: string;
}

export interface DeleteFormalMemoryInput {
  readonly teamId: ID;
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly changeReason?: string;
}

/**
 * 频道/Team 成员提交纠错或删除申请（AC#6）。不直接改写 Formal Memory，
 * 而是写入 candidate 状态待 Owner/Admin 审批。
 */
export interface ProposeFormalCorrectionInput {
  readonly teamId: ID;
  /** 提交者（成员 userId）。 */
  readonly actorId: ID;
  readonly scopeType: FormalMemoryScopeType;
  readonly scopeRef: ID;
  /** revise 时被纠错的目标 Formal Memory；delete 时必填。 */
  readonly targetMemoryId?: ID;
  readonly correctionType: FormalCorrectionType;
  /** revise 时提议的 kind（delete 时可省）。 */
  readonly kind?: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly reason: string;
}
