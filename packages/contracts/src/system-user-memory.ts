import type { ID, UnixMs } from './common.js';
import type { FormalMemoryKind } from './formal-memory.js';

/**
 * System Knowledge 与 User Memory（issue #717，PI MVP 切片 D）。
 *
 * 这两类 Memory 与 Team/Channel/Agent Memory（Team DB `memory_items`）**物理隔离**：
 * 它们位于 Global DB，不绑 `team_id`。
 * - System Knowledge：全局产品知识，仅系统管理员维护（ADR 0045）。
 * - User Memory：跨 Team 的个人偏好与工作习惯，仅用户本人维护（ADR 0044/0045）。
 *
 * 两者都不接受频道消息/Agent 结果/PI 推断等自动来源写入（AC#2）：写路径只有人工
 * 直接 CRUD，无 candidate 流程。状态机简化为 active/expired/superseded。
 *
 * 复用 FormalMemoryKind（ADR 0047 四类：fact/decision/rule/preference），直接以这
 * 4 类存储，不做 6→4 适配——这是新产品层，与 #716 复用 memory_items 的投影层不同。
 */

/** System/User Memory 允许的状态（纯人工维护，无 candidate/rejected/deleted）。 */
export const SYSTEM_USER_MEMORY_STATUSES = ['active', 'expired', 'superseded'] as const;
export type SystemUserMemoryStatus = (typeof SYSTEM_USER_MEMORY_STATUSES)[number];

/** 作用域标识（AC#7：UI 与 Socket payload 明确区分系统/个人/Team 作用域）。 */
export const SYSTEM_USER_MEMORY_SCOPES = ['system', 'user'] as const;
export type SystemUserMemoryScope = (typeof SYSTEM_USER_MEMORY_SCOPES)[number];

/** System/User Memory 共享基础字段。 */
export interface SystemUserMemoryItemDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  /** 作用域：system=全局产品知识，user=个人偏好（AC#7）。 */
  readonly scope: SystemUserMemoryScope;
  readonly kind: FormalMemoryKind;
  readonly status: SystemUserMemoryStatus;
  readonly content: string;
  readonly summary?: string;
  /** 最近一次人工变更原因（ADR 0046：记录操作者/时间/来源/变更原因）。 */
  readonly changeReason?: string;
  readonly validFrom?: UnixMs;
  readonly validUntil?: UnixMs;
  readonly supersededById?: ID;
  /** 版本族 id（初版=自身 id，supersede 时继承）；版本历史按此聚合。 */
  readonly versionFamilyId: ID;
  /** 创建/维护者 userId（system=系统管理员；user=用户本人）。 */
  readonly createdByUserId: ID;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/** System Knowledge DTO：全局产品知识，无 owner。 */
export type SystemKnowledgeDto = SystemUserMemoryItemDto;

/** User Memory DTO：个人偏好，带 ownerUserId 隔离键。 */
export interface UserMemoryDto extends SystemUserMemoryItemDto {
  /** 隔离键：仅 owner_user_id 本人可读写（AC#3/AC#6）。 */
  readonly ownerUserId: ID;
}

/** 版本历史单条（从同 versionFamilyId 的行投影）。 */
export interface SystemUserMemoryVersionDto {
  readonly versionId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly status: SystemUserMemoryStatus;
  readonly actorUserId: ID;
  readonly createdAt: UnixMs;
}

export interface SystemKnowledgeDetailDto extends SystemKnowledgeDto {
  /** 版本历史，按创建时间升序（最早在前）。 */
  readonly versions: readonly SystemUserMemoryVersionDto[];
}

export interface UserMemoryDetailDto extends UserMemoryDto {
  readonly versions: readonly SystemUserMemoryVersionDto[];
}

export interface SystemKnowledgeListDto {
  readonly schemaVersion: 1;
  readonly scope: 'system';
  readonly items: readonly SystemKnowledgeDto[];
}

export interface UserMemoryListDto {
  readonly schemaVersion: 1;
  readonly scope: 'user';
  readonly ownerUserId: ID;
  readonly items: readonly UserMemoryDto[];
}

// ---- System Knowledge 命令输入（actorId=系统管理员 userId）----

export interface CreateSystemKnowledgeInput {
  readonly actorId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly validUntil?: UnixMs;
}

export interface ReviseSystemKnowledgeInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly content: string;
  readonly summary?: string;
  /** 修订原因（ADR 0046，必填）。 */
  readonly changeReason: string;
  readonly validUntil?: UnixMs;
}

export interface DeactivateSystemKnowledgeInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  /** 停用原因（ADR 0046，必填）。 */
  readonly changeReason: string;
}

export interface DeleteSystemKnowledgeInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly changeReason?: string;
}

// ---- User Memory 命令输入（actorId=用户本人 userId）----

export interface CreateUserMemoryInput {
  readonly actorId: ID;
  readonly kind: FormalMemoryKind;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly validUntil?: UnixMs;
}

export interface ReviseUserMemoryInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason: string;
  readonly validUntil?: UnixMs;
}

export interface DeactivateUserMemoryInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly changeReason: string;
}

export interface DeleteUserMemoryInput {
  readonly actorId: ID;
  readonly memoryId: ID;
  readonly changeReason?: string;
}
