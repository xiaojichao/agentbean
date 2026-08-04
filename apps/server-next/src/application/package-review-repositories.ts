// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import type { ID, UnixMs } from '../../../../packages/contracts/src/index.js';
import type {
  PackageReviewAuthorityBasisKind,
  PackageReviewCommandName,
  PackageReviewReceiptOutcome,
} from '../../../../packages/contracts/src/index.js';
import type { ProjectArtifactFinalizationRecord, ProjectArtifactReviewRecord } from './project-repositories.js';

/**
 * #1061 PackageReview 仓储合同(父规格 #1059 §5;ADR-0067)。
 *
 * 三个命令(review / review-and-finalize / review-and-reject-delivery)共用:
 * - receipt/tombstone 幂等查重(同 scope/key/hash replay,不同 hash conflict);
 * - `recordPackageReview` 单事务写入 review 记录 + 幂等 mutation(组合命令在 handler 侧
 *   同一事务内再写 finalization / Task transition,本接口只负责 review 自身事实)。
 *
 * 关键不变量:
 * - review 记录 append-only,永不 UPDATE/DELETE(写入后不可改写);
 * - 审核绑定的 package/collection/version/delivery/Task revision/attempt 全部由 handler
 *   从已持久化事实加载并复验,本接口只做落库与幂等。
 */

/** Command receipt(ADR-0067):replayed 命中时返回首次 receipt,终态不被改写。 */
export interface PackageReviewReceiptRecord {
  readonly receiptId: ID;
  readonly teamId: ID;
  readonly commandName: PackageReviewCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: PackageReviewReceiptOutcome;
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  /** 成功结果快照(replay 时原样返回);治理压缩后为 undefined。 */
  readonly resultJson?: string;
  readonly createdAt: UnixMs;
}

/** 幂等 tombstone:result 治理压缩后仍可判 replay/conflict 的最小投影(#900 §1.5)。 */
export interface PackageReviewTombstoneRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly commandName: PackageReviewCommandName;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly outcome: PackageReviewReceiptOutcome;
  readonly resultAvailable: boolean;
  readonly createdAt: UnixMs;
}

/**
 * 落库的审核记录(ProjectArtifactReviewRecord 的 package 必填变体,AC1)。
 * 继承 #824 记录结构(stageId 可选/basis/authorityBasis),package 上下文在 package review
 * 命令中恒有,故收窄为必填;结构化上仍是 ProjectArtifactReviewRecord 的子类型。
 */
export interface PackageReviewRecord extends Omit<
  ProjectArtifactReviewRecord,
  'packageId' | 'deliveryId' | 'taskId' | 'taskRevision' | 'taskAttempt'
> {
  readonly packageId: ID;
  readonly deliveryId: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
}

export interface RecordPackageReviewInput {
  readonly review: PackageReviewRecord;
  /** #824 同款幂等 mutation 记录(kind='review')。 */
  readonly mutation: {
    readonly teamId: ID;
    readonly channelId: ID;
    readonly idempotencyKey: string;
    readonly requestFingerprint: string;
    readonly createdAt: UnixMs;
  };
  readonly receipt: PackageReviewReceiptRecord;
  readonly tombstone: PackageReviewTombstoneRecord;
  /**
   * AC9 组合:同一持久事务内写 finalization 审计并移动 collection.finalVersionId。
   * 落库时复核 collection revision fence(domain 已判,持久层再复核)。
   */
  readonly finalization?: {
    readonly finalization: ProjectArtifactFinalizationRecord;
    readonly collectionId: ID;
    readonly expectedCollectionRevision: number;
    readonly nextRevision: number;
    readonly updatedAt: UnixMs;
  };
}

export type RecordPackageReviewResult =
  | { readonly kind: 'created'; readonly review: PackageReviewRecord }
  | { readonly kind: 'replayed'; readonly review: PackageReviewRecord }
  | { readonly kind: 'idempotency_conflict' }
  | { readonly kind: 'version_scope_conflict' }
  /** AC9:并发 finalization/append 已推进集合 revision。 */
  | { readonly kind: 'finalization_conflict' };

export interface PackageReviewRepository {
  /**
   * 单事务写入 review 记录 + 幂等 mutation + command receipt/tombstone。
   * 组合命令的 finalization / Task transition 由 handler 在同一持久事务内完成
   * (repository 侧通过同一 UoW 或事务回调拼接,见实现)。
   */
  recordPackageReview(input: RecordPackageReviewInput): Promise<RecordPackageReviewResult>;
  receipts: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<PackageReviewReceiptRecord | null>;
  };
  tombstones: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<PackageReviewTombstoneRecord | null>;
  };
}
