import type {
  FormalMemoryKind,
  ID,
  SystemUserMemoryStatus,
  UnixMs,
} from '../../../../packages/contracts/src/index.js';

/**
 * System Knowledge 与 User Memory 持久化接口（issue #717）。
 *
 * 两表都在 **Global DB**（非 Team DB），不绑 team_id：
 * - `system_knowledge_items`：全局产品知识，无 owner。
 * - `user_memory_items`：个人偏好，`ownerUserId` 是隔离键。
 *
 * repository 是纯数据访问层，不懂业务安全规则。所有权/角色检查在 service 层用
 * `system-user-memory-policy`（domain）执行——避免安全控制散落到每个调用点。
 */

/** System Knowledge 行（Global DB，无 team_id、无 owner）。 */
export interface SystemKnowledgeRecord {
  readonly id: ID;
  readonly kind: FormalMemoryKind;
  readonly status: SystemUserMemoryStatus;
  readonly content: string;
  readonly summary?: string;
  readonly changeReason?: string;
  readonly versionFamilyId: ID;
  readonly supersededById?: ID;
  readonly createdByUserId: ID;
  readonly validFrom?: UnixMs;
  readonly validUntil?: UnixMs;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}

/** User Memory 行（Global DB，ownerUserId 是隔离键）。 */
export interface UserMemoryRecord extends SystemKnowledgeRecord {
  readonly ownerUserId: ID;
}

export interface SystemKnowledgeRepository {
  list(): Promise<SystemKnowledgeRecord[]>;
  getById(input: { id: ID }): Promise<SystemKnowledgeRecord | null>;
  /** 版本历史：同 versionFamilyId 的所有版本，按 createdAt 升序（ADR 0046）。 */
  listByVersionFamily(input: { versionFamilyId: ID }): Promise<SystemKnowledgeRecord[]>;
  create(record: SystemKnowledgeRecord): Promise<SystemKnowledgeRecord>;
  /** 标记旧行被新版本取代（supersede）：写 superseded_by_id + status=superseded。 */
  markSuperseded(input: { id: ID; supersededById: ID; updatedAt: UnixMs }): Promise<void>;
  /** 停用：status=expired + changeReason（ADR 0046）。 */
  markExpired(input: { id: ID; changeReason: string; updatedAt: UnixMs }): Promise<void>;
  delete(input: { id: ID }): Promise<void>;
}

export interface UserMemoryRepository {
  listByOwner(input: { ownerUserId: ID }): Promise<UserMemoryRecord[]>;
  getById(input: { id: ID }): Promise<UserMemoryRecord | null>;
  listByVersionFamily(input: { versionFamilyId: ID }): Promise<UserMemoryRecord[]>;
  create(record: UserMemoryRecord): Promise<UserMemoryRecord>;
  markSuperseded(input: { id: ID; supersededById: ID; updatedAt: UnixMs }): Promise<void>;
  markExpired(input: { id: ID; changeReason: string; updatedAt: UnixMs }): Promise<void>;
  delete(input: { id: ID }): Promise<void>;
}
