// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import type { ID, UnixMs } from '../../../../packages/contracts/src/index.js';
import type {
  ArtifactRevisionCommandName,
  ArtifactRevisionReceiptOutcome,
} from '../../../../packages/contracts/src/index.js';
import type { ArtifactRecord } from './repositories.js';
import type {
  ProjectArtifactCollectionRecord,
  ProjectArtifactVersionRecord,
} from './project-repositories.js';

/**
 * #1062 ArtifactRevision 仓储合同(父规格 #1059 §7/§11;ADR-0067)。
 *
 * `save-artifact-version-revision` 的唯一写入入口:新 Artifact 行 + 新
 * ProjectArtifactVersion + collection current 指针移动 + 幂等 receipt/tombstone
 * 在同一个持久事务内完成;任一步失败整体回滚,不留部分版本事实(AC6:不写部分版本)。
 *
 * 关键不变量:
 * - 不继承(AC4):本接口没有 review/finalization/Task 写入;finalVersionId 不被触碰;
 * - 不可变(AC5):原 Artifact/旧版本行永不 UPDATE;内容永远写入新 Artifact;
 * - 双 fence 持久层复核:collection revision 与 currentVersionId 在事务内条件更新
 *   (domain 已判,落库时再复核,并发安全)。
 */

/** Command receipt(ADR-0067):replayed 命中时返回首次 receipt,终态不被改写。 */
export interface ArtifactRevisionReceiptRecord {
  readonly receiptId: ID;
  readonly teamId: ID;
  readonly commandName: ArtifactRevisionCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: ArtifactRevisionReceiptOutcome;
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  /** 成功结果快照(replay 时原样返回);治理压缩后为 undefined。 */
  readonly resultJson?: string;
  readonly createdAt: UnixMs;
}

/** 幂等 tombstone:result 治理压缩后仍可判 replay/conflict 的最小投影(#900 §1.5)。 */
export interface ArtifactRevisionTombstoneRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly commandName: ArtifactRevisionCommandName;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly outcome: ArtifactRevisionReceiptOutcome;
  readonly resultAvailable: boolean;
  readonly createdAt: UnixMs;
}

export interface RecordArtifactVersionRevisionInput {
  readonly teamId: ID;
  readonly channelId: ID;
  /** 集合 revision fence(domain 判定后持久层复核)。 */
  readonly expectedCollectionRevision: number;
  /** current 指针 fence:baseVersionId 必须仍是 current(并发修订漂移 → conflict)。 */
  readonly expectedCurrentVersionId: ID;
  /** 推进后的 collection 快照(currentVersionId=新版本,revision/versionCount 已递增)。 */
  readonly collection: ProjectArtifactCollectionRecord;
  /** 新 Artifact 行(内容已由 content store 物化;同一事务落库)。 */
  readonly artifact: ArtifactRecord;
  /** 新版本行(lineage/source/修订 provenance 均由 handler 从 Server 事实推导)。 */
  readonly version: ProjectArtifactVersionRecord;
  readonly receipt: ArtifactRevisionReceiptRecord;
  readonly tombstone: ArtifactRevisionTombstoneRecord;
}

export type RecordArtifactVersionRevisionResult =
  | { readonly kind: 'created'; readonly version: ProjectArtifactVersionRecord }
  | { readonly kind: 'replayed'; readonly version: ProjectArtifactVersionRecord }
  | { readonly kind: 'idempotency_conflict' }
  /** 双 fence 或唯一键在事务内复核失败(并发漂移/主键冲突),整体回滚零部分行。 */
  | { readonly kind: 'conflict' };

export interface ArtifactRevisionRepository {
  /**
   * 单事务:receipt 预查 → 双 fence 条件更新 collection → INSERT artifact →
   * INSERT version → INSERT receipt/tombstone。fence 复核必须先于任何写入。
   */
  recordArtifactVersionRevision(
    input: RecordArtifactVersionRevisionInput,
  ): Promise<RecordArtifactVersionRevisionResult>;
  receipts: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<ArtifactRevisionReceiptRecord | null>;
  };
  tombstones: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<ArtifactRevisionTombstoneRecord | null>;
  };
}
