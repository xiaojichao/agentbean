// server-next 惯例:workspace 包一律用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。
import type { ID, UnixMs } from '../../../../packages/contracts/src/index.js';
import type {
  OutputPackageMemberRole,
  OutputPackageReceiptOutcome,
  OutputPackageTaskBinding,
} from '../../../../packages/contracts/src/index.js';

/**
 * #1060 OutputPackage 仓储合同(父规格 #1059 §3/§4;ADR-0067)。
 *
 * OutputPackage 创建后不可变:本接口刻意只暴露 create/读取,没有 update/delete 路径
 * (与 #824 审核记录同一取舍)。成员列表永不增删重排;同一 (teamId, publishId) 至多一个
 * package,重复 commit 回调/outbox 重放/同 key replay 经自然唯一键与 receipt 双重收敛。
 *
 * `recordPackageFormation` 是唯一的写入入口:collection 创建/追加、version 落库、package +
 * 冻结成员、receipt + tombstone 在同一个持久事务内完成,任一步失败整体回滚,不留部分
 * version/delivery/package 事实(#1060 AC1/AC7)。
 */

export interface OutputPackageRecord {
  readonly teamId: ID;
  readonly packageId: ID;
  readonly channelId: ID;
  readonly deliveryId: ID;
  readonly publishId: ID;
  readonly workspaceRevisionId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskBinding: OutputPackageTaskBinding;
  readonly taskRevision?: number;
  readonly taskAttempt: number;
  readonly invocationId?: ID;
  readonly workspaceRunId?: ID;
  readonly claimLeaseId?: ID;
  readonly deviceId?: ID;
  readonly memberCount: number;
  readonly status: 'recorded';
  readonly createdAt: UnixMs;
}

/** 冻结成员:交付时版本/顺序/短标识/角色/final 必需性/来源摘要,落库后不可变。 */
export interface OutputPackageMemberRecord {
  readonly teamId: ID;
  readonly packageId: ID;
  readonly channelId: ID;
  readonly sequence: number;
  readonly shortLabel: string;
  readonly collectionId: ID;
  readonly artifactVersionId: ID;
  readonly role: OutputPackageMemberRole;
  readonly requiredForFinal: boolean;
  readonly sourcePath: string;
  readonly filename: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
}

/** Command receipt(ADR-0067):replayed 命中时返回首次 receipt,终态不被改写。 */
export interface OutputPackageReceiptRecord {
  readonly receiptId: ID;
  readonly teamId: ID;
  readonly commandName: 'record-agent-output-package';
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: OutputPackageReceiptOutcome;
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  /** 成功结果快照(replay 时原样返回);治理压缩后为 undefined。 */
  readonly resultJson?: string;
  readonly createdAt: UnixMs;
}

/** 幂等 tombstone:result 治理压缩后仍可判 replay/conflict 的最小投影(#900 §1.5)。 */
export interface OutputPackageTombstoneRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly commandName: 'record-agent-output-package';
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly outcome: OutputPackageReceiptOutcome;
  readonly resultAvailable: boolean;
  readonly createdAt: UnixMs;
}

/** 成员携带的 collection 写入指令:create=新建逻辑集合;append=追加到既有集合(带 revision fence);
 *  reuse=该 artifact 已有版本(人工 promote 或先前交付),复用既有 version,不写 collection/version。 */
export type OutputPackageCollectionWrite =
  | {
    readonly mode: 'create';
    readonly collectionId: ID;
    readonly name: string;
    readonly kind: string;
  }
  | {
    readonly mode: 'append';
    readonly collectionId: ID;
    readonly expectedRevision: number;
    readonly expectedVersionCount: number;
  }
  | {
    readonly mode: 'reuse';
    readonly collectionId: ID;
    /** 既有 version id(必须与 artifact 自然键匹配,否则 conflict)。 */
    readonly expectedVersionId: ID;
  };

export interface OutputPackageMemberWrite {
  readonly sequence: number;
  readonly shortLabel: string;
  readonly role: OutputPackageMemberRole;
  readonly requiredForFinal: boolean;
  readonly sourcePath: string;
  readonly filename: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
  readonly collection: OutputPackageCollectionWrite;
  readonly version: {
    readonly id: ID;
    readonly artifactId: ID;
    /** 交付来源 Stage(Task 未绑定 Stage / 合成 taskId 时缺省;#1060 起 versions.stage_id 可空)。 */
    readonly stageId?: ID;
    readonly taskId: ID;
    readonly taskRevision: number;
    readonly sourceWorkspaceRunId?: ID;
    readonly sourceInvocationId?: ID;
  };
}

export interface RecordOutputPackageFormationInput {
  readonly record: OutputPackageRecord;
  readonly members: readonly OutputPackageMemberWrite[];
  readonly receipt: OutputPackageReceiptRecord;
  readonly tombstone: OutputPackageTombstoneRecord;
}

/**
 * 成形结果:
 * - created:整组事实(collection/version/package/members/receipt/tombstone)原子提交;
 * - replayed:同 (teamId, publishId) 既有 package,返回既有事实,无副作用;
 * - conflict:事务内复核失败(并发 collection 漂移 / artifact 自然键冲突),调用方重读后再判。
 */
export type RecordOutputPackageFormationResult =
  | {
    readonly kind: 'created' | 'replayed';
    readonly package: OutputPackageRecord;
    readonly members: readonly OutputPackageMemberRecord[];
  }
  | { readonly kind: 'conflict'; readonly reason: 'collection-revision-stale' | 'artifact-version-conflict' };

export interface OutputPackageRepository {
  recordPackageFormation(
    input: RecordOutputPackageFormationInput,
  ): Promise<RecordOutputPackageFormationResult>;
  getPackageById(input: {
    teamId: ID;
    packageId: ID;
  }): Promise<{ package: OutputPackageRecord; members: OutputPackageMemberRecord[] } | null>;
  getPackageByPublishId(input: {
    teamId: ID;
    publishId: ID;
  }): Promise<{ package: OutputPackageRecord; members: OutputPackageMemberRecord[] } | null>;
  /** Files/Task 投影:按频道(可选 taskId)倒序列包;cursor 为不透明 (createdAt, packageId) 游标。 */
  listPackagesByChannel(input: {
    teamId: ID;
    channelId: ID;
    taskId?: ID;
    limit: number;
    cursor?: { createdAt: UnixMs; packageId: ID };
  }): Promise<OutputPackageRecord[]>;
  /** #1060 pendingDeliveries 差集:频道(可选 taskId)内**全部**已形成 package 的 publishId(不分页)。 */
  listPackagePublishIdsByChannel(input: {
    teamId: ID;
    channelId: ID;
    taskId?: ID;
  }): Promise<ID[]>;
  receipts: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<OutputPackageReceiptRecord | null>;
  };
  tombstones: {
    getByIdempotencyKey(input: {
      teamId: ID;
      idempotencyKey: string;
    }): Promise<OutputPackageTombstoneRecord | null>;
  };
}
