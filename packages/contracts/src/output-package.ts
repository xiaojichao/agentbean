import type { ID, UnixMs } from './common.js';
import { COMMAND_PROVENANCE_KINDS, type CommandProvenanceKind, type CommandProvenanceRefV1 } from './message-tracer.js';
import type { ConsistencyTokenV1 } from './system-activity.js';
import { PACKAGE_REVIEW_ACTIONS, type PackageReviewAction } from './package-review.js';
import type { ProjectArtifactVersionReviewState } from './project.js';

/**
 * OutputPackage 命令/查询合同(issue #1060,父规格 #1059 §3/§4/§9/§10;ADR-0067 Command registry)。
 *
 * 一次已成功 commit 的 Agent 多文件交付,经 Server 对 Workspace revision、Invocation、execution
 * claim、Task revision/attempt 与 delivery contract 复验后,原子形成可审核的 OutputPackage。
 * Package 不是目录、Workspace revision、publish batch 或 ProjectArtifactCollection 的别名:
 * 它是"一次成功交付"的协作分组,创建后成员身份、顺序、短标识、交付时 artifactVersionId、
 * 协作角色、final 必需性与 provenance 全部冻结;后续新文件/新 delivery 形成新 package。
 *
 * `record-agent-output-package` 的 initiator 是 Server system(由 Device publish commit 成功路径
 * 与 commit 幂等重入路径内部触发),不对任何 client transport 暴露 command 绑定;authority 一律由
 * Server 从已持久化的 staging/revision/claim/invocation 事实推导,envelope 严禁 authority/teamId
 * 字段(#900 §1 / ADR-0067)。同一 delivery 的幂等 replay 只能返回既有 package;`outcome_unknown`
 * 必须用原 key 查询或 replay 收敛,严禁换 key。
 *
 * 本文件只提供 runtime schemas、discriminated unions、canonical serialization 与跨端 conformance
 * 基础;具体 handler、存储与接线属于 server-next 切片。
 */

// ---------------------------------------------------------------------------
// Contract capabilities —— OutputPackage family
// ---------------------------------------------------------------------------

/**
 * 冻结的具名 command 集合。未登记 command 必须被 Server 拒绝(ADR-0067)。
 * 顺序即 registry 公开顺序,测试钉死长度防止误增删。
 */
export const OUTPUT_PACKAGE_COMMAND_NAMES = ['record-agent-output-package'] as const;
export type OutputPackageCommandName = (typeof OUTPUT_PACKAGE_COMMAND_NAMES)[number];

/** 冻结的具名 query 集合(#1059 §10)。 */
export const OUTPUT_PACKAGE_QUERY_NAMES = ['get-output-package', 'list-channel-output-packages'] as const;
export type OutputPackageQueryName = (typeof OUTPUT_PACKAGE_QUERY_NAMES)[number];

/** envelope 的当前 schema 版本(ADR-0067:envelope 分别版本化)。 */
export const OUTPUT_PACKAGE_ENVELOPE_SCHEMA_VERSION = 1;
/** command payload 的当前 schema 版本。 */
export const OUTPUT_PACKAGE_COMMAND_SCHEMA_VERSION = 1;
/** canonical command hash 规范版本;hash 算法升级时递增,使旧 hash 不被误判相等。 */
export const OUTPUT_PACKAGE_COMMAND_HASH_VERSION = 1;
/** query request/response 的当前 schema 版本。 */
export const OUTPUT_PACKAGE_QUERY_SCHEMA_VERSION = 1;

/** Command receipt 的终态 outcome(ADR-0067:嵌套 receipt 终态始终 applied 或 no_op)。 */
export const OUTPUT_PACKAGE_RECEIPT_OUTCOMES = ['applied', 'no_op'] as const;
export type OutputPackageReceiptOutcome = (typeof OUTPUT_PACKAGE_RECEIPT_OUTCOMES)[number];

/**
 * Command response outcome 固定八态(#900 §16 / ADR-0067)。
 * `replayed` 表示本次请求命中既有 receipt;嵌套 receipt 终态保留首次 applied/no_op。
 */
export const OUTPUT_PACKAGE_OUTCOMES = [
  'applied', 'no_op', 'replayed', 'freshness_hold',
  'conflict', 'rejected', 'temporarily_unavailable', 'outcome_unknown',
] as const;
export type OutputPackageOutcome = (typeof OUTPUT_PACKAGE_OUTCOMES)[number];

/** 重试指令四态(ADR-0067)。outcome_unknown 必须用原 key 查 receipt 或 replay,严禁换 key。 */
export const OUTPUT_PACKAGE_RETRY_DIRECTIVES = [
  'none', 'same_key', 'reread_then_new_command', 'user_action',
] as const;
export type OutputPackageRetryDirective = (typeof OUTPUT_PACKAGE_RETRY_DIRECTIVES)[number];

/**
 * 结构化拒绝码(#1059 §4/§11):任一拒绝都不得留下部分 version/delivery/package 事实;
 * 已 committed 的 Workspace revision 保持可恢复事实,Server reconciliation 用原幂等身份收敛。
 */
export const OUTPUT_PACKAGE_REJECTION_REASONS = [
  /** staging 未 commit / commit 失败 / revision 与 staging 对不上(Device seam:未 commit 不进本流程)。 */
  'workspace-revision-not-committed',
  /** revision 文件集为空或缺 artifact 引用(文件集合不完整)。 */
  'incomplete-delivery',
  /** 交付 Agent 被删除/移出频道/换绑 Device/失去 Team 可见性。 */
  'agent-authority-revoked',
  /** 真实 Task 的 Team/Channel 归属与交付频道不一致。 */
  'task-authority-mismatch',
  /** Task revision/attempt 已漂移,本次交付属于已被取代的 attempt。 */
  'task-attempt-superseded',
  /** Invocation intent 与 Task/attempt/claim 对不上,或 WorkspaceRun 与 Invocation 对不上。 */
  'invocation-mismatch',
  /** execution claim 已失效(被取代/relinquish),本次交付不再持有有效执行权。 */
  'claim-inactive',
  /** 同一 delivery 中同一逻辑 collection(相对路径)出现重复 manifest entry(#1059 §4)。 */
  'duplicate-manifest-entry',
  /** 频道已归档,归档后所有写 command fail closed(#1059 §11)。 */
  'channel-archived',
  /** 频道不存在。 */
  'channel-not-found',
] as const;
export type OutputPackageRejectionReason = (typeof OUTPUT_PACKAGE_REJECTION_REASONS)[number];

/** Query outcome(#1059 §10:ready / not_ready / conflict / rejected)。 */
export const OUTPUT_PACKAGE_QUERY_OUTCOMES = [
  'ready', 'projection_not_ready', 'conflict', 'rejected',
] as const;
export type OutputPackageQueryOutcome = (typeof OUTPUT_PACKAGE_QUERY_OUTCOMES)[number];

// ---------------------------------------------------------------------------
// OutputPackage DTO(创建后不可变;#1059 §3)
// ---------------------------------------------------------------------------

/**
 * 成员的协作角色。v1 恒为 `deliverable`(与 commit 物化的 artifact role 一致);
 * 角色不从相对路径推导(ADR-0052)。enum 预留扩展,创建后冻结。
 */
export const OUTPUT_PACKAGE_MEMBER_ROLES = ['deliverable'] as const;
export type OutputPackageMemberRole = (typeof OUTPUT_PACKAGE_MEMBER_ROLES)[number];

/**
 * Package 成员——创建时冻结:展示顺序、短标识、交付时 artifactVersionId、协作角色、
 * final 必需性与来源摘要;成员列表永不增删或重排(#1059 §3)。后续修改形成 collection 的
 * 新 version,由后续切片的 current projection 读取;package 永远保留 delivered 事实。
 */
export interface OutputPackageMemberDto {
  readonly packageId: ID;
  /** 展示顺序(从 1 递增,按交付 manifest 顺序冻结)。 */
  readonly sequence: number;
  /** 包内唯一短标识(F1、F2……),只在 package/Thread 焦点内唯一,不是长期引用身份。 */
  readonly shortLabel: string;
  /** 成员所属逻辑产物集合(跨版本身份)。 */
  readonly collectionId: ID;
  /** 交付时的具体版本(delivered projection 的锚,创建后冻结)。 */
  readonly artifactVersionId: ID;
  readonly role: OutputPackageMemberRole;
  /** 是否为 final projection 的必需成员(v1 恒 true;final 解析属后续切片)。 */
  readonly requiredForFinal: boolean;
  /** 来源相对路径摘要(交付时的 workspace 相对路径;不作为角色/权限依据)。 */
  readonly sourcePath: string;
  readonly filename: string;
  readonly sha256?: string;
  readonly sizeBytes: number;
}

/** Task 绑定形态:managed=命中真实 Task 且经 revision/attempt/claim/invocation 复验;unmanaged=合成 taskId 只记 provenance。 */
export const OUTPUT_PACKAGE_TASK_BINDINGS = ['managed', 'unmanaged'] as const;
export type OutputPackageTaskBinding = (typeof OUTPUT_PACKAGE_TASK_BINDINGS)[number];

/**
 * OutputPackage——一次成功 Agent 交付的协作分组(#1059 §3)。
 * 绑定唯一 delivery lineage:来源 Agent、Task revision/attempt、可选 Invocation/WorkspaceRun/
 * claim/Device、committed Workspace revision 与 publish identity。publish identity 仅作
 * provenance 与幂等收敛键,不是 package identity。`revision` 恒为 1(聚合不可变),保留字段
 * 供 consistency token / 未来治理演进使用。
 */
export interface OutputPackageDto {
  readonly schemaVersion: 1;
  readonly packageId: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  /** 聚合 revision;package 创建后不可变,恒 1。 */
  readonly revision: number;
  /** 本次交付的唯一 delivery identity(Server 生成,与 package 1:1)。 */
  readonly deliveryId: ID;
  /** provenance:形成本 package 的 Device publish identity(非 package identity)。 */
  readonly publishId: ID;
  /** provenance:本次交付 commit 出的 Workspace revision。 */
  readonly workspaceRevisionId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskBinding: OutputPackageTaskBinding;
  /** managed 绑定时冻结的 Task revision;unmanaged 缺省。 */
  readonly taskRevision?: number;
  readonly taskAttempt: number;
  readonly invocationId?: ID;
  readonly workspaceRunId?: ID;
  readonly claimLeaseId?: ID;
  readonly deviceId?: ID;
  /** 冻结成员(按 sequence 升序)。 */
  readonly members: readonly OutputPackageMemberDto[];
  readonly memberCount: number;
  readonly status: 'recorded';
  readonly createdAt: UnixMs;
}

/**
 * #1061 AC11：package 成员的可执行动作（Server 计算）。
 * `actions` 为空数组 = 当前用户无任何审核/验收/最终化权（客户端不显示任何按钮）。
 */
export interface PackageMemberAvailableActionsDto {
  readonly collectionId: ID;
  readonly versionId: ID;
  /** 成员版本的最新审核状态（Server 派生，客户端不推断）。 */
  readonly reviewState: ProjectArtifactVersionReviewState;
  /** 集合 final 指针是否为该版本（Server 事实）。 */
  readonly isFinalVersion: boolean;
  /** 集合当前 revision（AC9 组合命令的 fence，Server 事实，客户端不推断）。 */
  readonly collectionRevision: number;
  readonly actions: readonly PackageReviewAction[];
}

/** Files/Task 投影用的包摘要(与 OutputPackageDto 同源,不含成员明细)。 */
export interface OutputPackageSummaryDto {
  readonly schemaVersion: 1;
  readonly packageId: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly revision: number;
  readonly deliveryId: ID;
  readonly publishId: ID;
  readonly workspaceRevisionId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskBinding: OutputPackageTaskBinding;
  readonly taskRevision?: number;
  readonly taskAttempt: number;
  readonly memberCount: number;
  /**
   * #1061 AC11：全部成员 reviewState 的聚合(Server 计算)。
   * 任一 rejected → rejected;任一 changes_requested → changes_requested;
   * 全部 approved → approved;否则 pending。客户端不自行推断。
   */
  readonly reviewState: ProjectArtifactVersionReviewState;
  readonly status: 'recorded';
  readonly createdAt: UnixMs;
}

/**
 * 「交付处理中」投影项(#1059 §11 / #1060 AC8):Workspace revision 已 commit 且带 Agent
 * publish provenance,但 package 暂未形成(暂失败待 reconciliation)。UI 只显示处理中,
 * 不得伪造完整交付。
 */
export interface OutputPackagePendingDeliveryDto {
  readonly publishId: ID;
  readonly workspaceRevisionId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskAttempt: number;
  readonly committedAt: UnixMs;
}

// ---------------------------------------------------------------------------
// Command envelope + input/output maps(ADR-0067)
// ---------------------------------------------------------------------------

/**
 * 共享、transport-independent envelope(ADR-0067)。固定只含 command/schema identity、
 * idempotency key 与来源引用;严禁 authority、team/tenant 或 requester/scope 字段。
 * 本 command 由 Server system 内部触发,幂等键由 Server 从 delivery/publish identity 确定性
 * 派生(`record-agent-output-package:<channelId>:<publishId>`),scope 为 Team/Channel +
 * command + Task attempt + delivery/publish identity(#1059 §9)。
 */
export interface OutputPackageCommandEnvelopeV1 {
  readonly schemaVersion: 1;
  readonly commandName: 'record-agent-output-package';
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly causationRef?: CommandProvenanceRefV1;
  readonly sourceRefs?: readonly CommandProvenanceRefV1[];
}

export interface OutputPackageCommandInputMapV1 {
  /**
   * 目标身份三元组;provenance(Agent/Task/attempt/Invocation/Device)一律由 Server 从已持久化
   * staging/revision 事实读取并复验,调用方不得自报。
   */
  readonly 'record-agent-output-package': {
    readonly channelId: ID;
    readonly publishId: ID;
    readonly workspaceRevisionId: ID;
  };
}

export interface OutputPackageCommandOutputMapV1 {
  readonly 'record-agent-output-package': {
    readonly package: OutputPackageDto;
    /** `created`=本次新建;`existing`=同 publish identity 收敛到既有 package(自然幂等)。 */
    readonly disposition: 'created' | 'existing';
  };
}

export type OutputPackageCommandOutputUnionV1 =
  | ({ readonly commandName: 'record-agent-output-package' } & OutputPackageCommandOutputMapV1['record-agent-output-package']);

/** 已成立的过去式领域事实引用(#900 §9)。 */
export interface OutputPackageEventRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly sequence: number;
}

/** 已提交的专项 revision 引用(#900 §24)。 */
export interface OutputPackageRevisionRefV1 {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
}

/**
 * 一个 command 只有一个持久 Command receipt。`outcome` 是嵌套 receipt 的终态(始终 applied
 * 或 no_op),response 层的 `replayed` disposition 不改写它。
 */
export interface OutputPackageReceiptV1 {
  readonly schemaVersion: 1;
  readonly receiptId: ID;
  readonly commandName: 'record-agent-output-package';
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  /** canonical command hash(由 canonicalizeOutputPackageCommand 派生,server 计算 sha256)。 */
  readonly commandHash: string;
  readonly outcome: OutputPackageReceiptOutcome;
  readonly committedRevisions: readonly OutputPackageRevisionRefV1[];
  readonly eventRefs: readonly OutputPackageEventRefV1[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
}

/** Command 响应。携带稳定 code、retry directive 与安全裁剪的当前引用。 */
export interface OutputPackageCommandResponseV1 {
  readonly schemaVersion: 1;
  readonly commandName: 'record-agent-output-package';
  readonly outcome: OutputPackageOutcome;
  readonly retryDirective: OutputPackageRetryDirective;
  readonly stableCode: string;
  /** applied / no_op / replayed 时携带首次 receipt。 */
  readonly receipt?: OutputPackageReceiptV1;
  /** 成功(applied)时的 command 结果。 */
  readonly result?: OutputPackageCommandOutputUnionV1;
  /** conflict:同 idempotency key 但 canonical command hash 不同,无副作用。 */
  readonly conflictReason?: string;
  /** rejected:结构化拒绝码(OUTPUT_PACKAGE_REJECTION_REASONS)。 */
  readonly rejectedReason?: string;
}

// ---------------------------------------------------------------------------
// Query maps(#1059 §10:audience scope、asOf、consistency token、opaque cursor)
// ---------------------------------------------------------------------------

export interface OutputPackageQueryInputMapV1 {
  readonly 'get-output-package': {
    /** 目标频道(调用方声明;Server 复验 package 归属,防跨频道读取)。 */
    readonly channelId: ID;
    readonly packageId: ID;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
  readonly 'list-channel-output-packages': {
    readonly channelId: ID;
    /** 可选:只返回某 Task 的交付包(Task 详情投影)。 */
    readonly taskId?: ID;
    readonly cursor?: string;
    readonly limit?: number;
    readonly minimumConsistency?: ConsistencyTokenV1;
  };
}

export interface OutputPackageQueryOutputMapV1 {
  readonly 'get-output-package': {
    readonly package: OutputPackageDto;
    /**
     * #1061 AC11：Server 按当前用户计算的可执行动作（成员级）。
     * 客户端只渲染 Server 给出的动作，绝不依据按钮可见性或角色名称推断权限。
     */
    readonly availableActions: readonly PackageMemberAvailableActionsDto[];
  };
  readonly 'list-channel-output-packages': {
    readonly packages: readonly OutputPackageSummaryDto[];
    /** committed 但 package 未形成的交付(UI「交付处理中」)。 */
    readonly pendingDeliveries: readonly OutputPackagePendingDeliveryDto[];
    readonly nextCursor?: string;
  };
}

export type OutputPackageQueryOutputUnionV1 =
  | ({ readonly queryName: 'get-output-package' } & OutputPackageQueryOutputMapV1['get-output-package'])
  | ({ readonly queryName: 'list-channel-output-packages' } & OutputPackageQueryOutputMapV1['list-channel-output-packages']);

/** Query 响应:audience scope + asOf watermark;不签发 mutation authority。 */
export interface OutputPackageQueryResponseV1 {
  readonly schemaVersion: 1;
  readonly queryName: OutputPackageQueryName;
  readonly outcome: OutputPackageQueryOutcome;
  readonly stableCode: string;
  readonly audienceScope: string;
  readonly asOf: UnixMs;
  readonly result?: OutputPackageQueryOutputUnionV1;
  /** rejected:如 output-package-not-found / forbidden;conflict:游标/basis 失效。 */
  readonly rejectedReason?: string;
}

// ---------------------------------------------------------------------------
// Exact-key runtime schema 校验
// ---------------------------------------------------------------------------

const OUTPUT_PACKAGE_PAYLOAD_INVALID = 'OUTPUT_PACKAGE_PAYLOAD_INVALID';

function assertExactKeys(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
}

function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function assertId(value: unknown): void {
  if (!nonEmpty(value)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
}

function assertInteger(value: unknown, minimum: number): void {
  if (!Number.isSafeInteger(value) || Number(value) < minimum) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
}

function assertCommandProvenanceRef(value: unknown): void {
  assertExactKeys(value, ['kind', 'id', 'revision', 'sequence', 'scope', 'hash'], ['kind', 'id']);
  // 复用 #921 冻结的 COMMAND_PROVENANCE_KINDS,避免内联副本随源漂移。
  if (!COMMAND_PROVENANCE_KINDS.includes(value.kind as CommandProvenanceKind)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  assertId(value.id);
  if (value.revision !== undefined) assertInteger(value.revision, 0);
  if (value.sequence !== undefined) assertInteger(value.sequence, 0);
  if (value.scope !== undefined && !nonEmpty(value.scope)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.hash !== undefined && !nonEmpty(value.hash)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
}

function assertConsistencyToken(value: unknown): void {
  assertExactKeys(value, ['schemaVersion', 'entries'], ['schemaVersion', 'entries']);
  if (value.schemaVersion !== 1) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!Array.isArray(value.entries)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  for (const entry of value.entries) {
    assertExactKeys(entry, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
    const e = entry as Record<string, unknown>;
    if (!nonEmpty(e.streamKind) || !nonEmpty(e.streamId)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    assertInteger(e.revision, 0);
  }
}

function assertMember(value: unknown): void {
  assertExactKeys(value,
    ['packageId', 'sequence', 'shortLabel', 'collectionId', 'artifactVersionId', 'role',
      'requiredForFinal', 'sourcePath', 'filename', 'sha256', 'sizeBytes'],
    ['packageId', 'sequence', 'shortLabel', 'collectionId', 'artifactVersionId', 'role',
      'requiredForFinal', 'sourcePath', 'filename', 'sizeBytes']);
  assertId(value.packageId);
  assertInteger(value.sequence, 1);
  if (!nonEmpty(value.shortLabel)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertId(value.collectionId);
  assertId(value.artifactVersionId);
  if (!OUTPUT_PACKAGE_MEMBER_ROLES.includes(value.role as OutputPackageMemberRole)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (typeof value.requiredForFinal !== 'boolean') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!nonEmpty(value.sourcePath)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!nonEmpty(value.filename)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.sha256 !== undefined && !nonEmpty(value.sha256)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.sizeBytes, 0);
}

function assertPackageDto(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'packageId', 'teamId', 'channelId', 'revision', 'deliveryId', 'publishId',
      'workspaceRevisionId', 'agentId', 'taskId', 'taskBinding', 'taskRevision', 'taskAttempt',
      'invocationId', 'workspaceRunId', 'claimLeaseId', 'deviceId', 'members', 'memberCount',
      'status', 'createdAt'],
    ['schemaVersion', 'packageId', 'teamId', 'channelId', 'revision', 'deliveryId', 'publishId',
      'workspaceRevisionId', 'agentId', 'taskId', 'taskBinding', 'taskAttempt',
      'members', 'memberCount', 'status', 'createdAt']);
  if (value.schemaVersion !== 1) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertId(value.packageId);
  assertId(value.teamId);
  assertId(value.channelId);
  assertInteger(value.revision, 1);
  assertId(value.deliveryId);
  assertId(value.publishId);
  assertId(value.workspaceRevisionId);
  assertId(value.agentId);
  assertId(value.taskId);
  if (!OUTPUT_PACKAGE_TASK_BINDINGS.includes(value.taskBinding as OutputPackageTaskBinding)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 1);
  assertInteger(value.taskAttempt, 1);
  for (const opt of ['invocationId', 'workspaceRunId', 'claimLeaseId', 'deviceId'] as const) {
    if (value[opt] !== undefined) assertId(value[opt]);
  }
  if (!Array.isArray(value.members)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  value.members.forEach(assertMember);
  assertInteger(value.memberCount, 0);
  if (value.memberCount !== value.members.length) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.status !== 'recorded') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.createdAt, 0);
}

function assertSummaryDto(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'packageId', 'teamId', 'channelId', 'revision', 'deliveryId', 'publishId',
      'workspaceRevisionId', 'agentId', 'taskId', 'taskBinding', 'taskRevision', 'taskAttempt',
      'memberCount', 'reviewState', 'status', 'createdAt'],
    ['schemaVersion', 'packageId', 'teamId', 'channelId', 'revision', 'deliveryId', 'publishId',
      'workspaceRevisionId', 'agentId', 'taskId', 'taskBinding', 'taskAttempt',
      'memberCount', 'reviewState', 'status', 'createdAt']);
  if (value.reviewState !== 'pending' && value.reviewState !== 'approved'
    && value.reviewState !== 'rejected' && value.reviewState !== 'changes_requested') {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (value.schemaVersion !== 1) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertId(value.packageId);
  assertId(value.teamId);
  assertId(value.channelId);
  assertInteger(value.revision, 1);
  assertId(value.deliveryId);
  assertId(value.publishId);
  assertId(value.workspaceRevisionId);
  assertId(value.agentId);
  assertId(value.taskId);
  if (!OUTPUT_PACKAGE_TASK_BINDINGS.includes(value.taskBinding as OutputPackageTaskBinding)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (value.taskRevision !== undefined) assertInteger(value.taskRevision, 1);
  assertInteger(value.taskAttempt, 1);
  assertInteger(value.memberCount, 0);
  if (value.status !== 'recorded') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.createdAt, 0);
}

function assertMemberAvailableActions(value: unknown): void {
  assertExactKeys(value,
    ['collectionId', 'versionId', 'reviewState', 'isFinalVersion', 'collectionRevision', 'actions'],
    ['collectionId', 'versionId', 'reviewState', 'isFinalVersion', 'collectionRevision', 'actions']);
  assertId(value.collectionId);
  assertId(value.versionId);
  if (value.reviewState !== 'pending' && value.reviewState !== 'approved'
    && value.reviewState !== 'rejected' && value.reviewState !== 'changes_requested') {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (typeof value.isFinalVersion !== 'boolean') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.collectionRevision, 1);
  if (!Array.isArray(value.actions)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  for (const action of value.actions) {
    if (!PACKAGE_REVIEW_ACTIONS.includes(action as PackageReviewAction)) {
      throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    }
  }
}

function assertPendingDeliveryDto(value: unknown): void {
  assertExactKeys(value,
    ['publishId', 'workspaceRevisionId', 'agentId', 'taskId', 'taskAttempt', 'committedAt'],
    ['publishId', 'workspaceRevisionId', 'agentId', 'taskId', 'taskAttempt', 'committedAt']);
  assertId(value.publishId);
  assertId(value.workspaceRevisionId);
  assertId(value.agentId);
  assertId(value.taskId);
  assertInteger(value.taskAttempt, 1);
  assertInteger(value.committedAt, 0);
}

function assertRecordInput(value: unknown): void {
  assertExactKeys(value, ['channelId', 'publishId', 'workspaceRevisionId'],
    ['channelId', 'publishId', 'workspaceRevisionId']);
  assertId(value.channelId);
  assertId(value.publishId);
  assertId(value.workspaceRevisionId);
}

function assertRevisionRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'revision'], ['streamKind', 'streamId', 'revision']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.revision, 0);
}

function assertEventRef(value: unknown): void {
  assertExactKeys(value, ['streamKind', 'streamId', 'sequence'], ['streamKind', 'streamId', 'sequence']);
  if (!nonEmpty(value.streamKind) || !nonEmpty(value.streamId)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.sequence, 0);
}

function assertReceipt(value: unknown): void {
  assertExactKeys(value,
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable'],
    ['schemaVersion', 'receiptId', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'commandHash',
      'outcome', 'committedRevisions', 'eventRefs', 'commitTime', 'resultAvailable']);
  if (value.schemaVersion !== 1) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertId(value.receiptId);
  if (!OUTPUT_PACKAGE_COMMAND_NAMES.includes(value.commandName as OutputPackageCommandName)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  assertInteger(value.commandSchemaVersion, 1);
  assertId(value.idempotencyKey);
  assertId(value.commandHash);
  if (!OUTPUT_PACKAGE_RECEIPT_OUTCOMES.includes(value.outcome as OutputPackageReceiptOutcome)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (!Array.isArray(value.committedRevisions)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  value.committedRevisions.forEach(assertRevisionRef);
  if (!Array.isArray(value.eventRefs)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  value.eventRefs.forEach(assertEventRef);
  assertInteger(value.commitTime, 0);
  if (typeof value.resultAvailable !== 'boolean') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
}

function assertCommandOutput(value: unknown): void {
  assertExactKeys(value, ['commandName', 'package', 'disposition'],
    ['commandName', 'package', 'disposition']);
  if (value.commandName !== 'record-agent-output-package') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertPackageDto(value.package);
  if (value.disposition !== 'created' && value.disposition !== 'existing') {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
}

// ---------------------------------------------------------------------------
// Parsers(exact-key + structuredClone,防外部可变引用外泄)
// ---------------------------------------------------------------------------

export function parseOutputPackageCommandEnvelopeV1(value: unknown): OutputPackageCommandEnvelopeV1 {
  // 拒绝任何 authority/scope 自报告字段(teamId、authoritySubject、requesterId、actor 等)。
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey', 'causationRef', 'sourceRefs'],
    ['schemaVersion', 'commandName', 'commandSchemaVersion', 'idempotencyKey']);
  if (value.schemaVersion !== OUTPUT_PACKAGE_ENVELOPE_SCHEMA_VERSION) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.commandName !== 'record-agent-output-package') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  // 本切片只实现 V1:未知/未来 commandSchemaVersion 必须拒绝,禁止按 V1 静默执行。
  if (value.commandSchemaVersion !== OUTPUT_PACKAGE_COMMAND_SCHEMA_VERSION) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  assertId(value.idempotencyKey);
  if (value.causationRef !== undefined) assertCommandProvenanceRef(value.causationRef);
  if (value.sourceRefs !== undefined) {
    if (!Array.isArray(value.sourceRefs)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    value.sourceRefs.forEach(assertCommandProvenanceRef);
  }
  return structuredClone(value) as unknown as OutputPackageCommandEnvelopeV1;
}

export function parseRecordAgentOutputPackageInputV1(
  value: unknown,
): OutputPackageCommandInputMapV1['record-agent-output-package'] {
  assertRecordInput(value);
  return structuredClone(value) as unknown as OutputPackageCommandInputMapV1['record-agent-output-package'];
}

export function parseOutputPackageDto(value: unknown): OutputPackageDto {
  assertPackageDto(value);
  return structuredClone(value) as unknown as OutputPackageDto;
}

export function parseOutputPackageSummaryDto(value: unknown): OutputPackageSummaryDto {
  assertSummaryDto(value);
  return structuredClone(value) as unknown as OutputPackageSummaryDto;
}

export function parseOutputPackageReceiptV1(value: unknown): OutputPackageReceiptV1 {
  assertReceipt(value);
  return structuredClone(value) as unknown as OutputPackageReceiptV1;
}

export function parseOutputPackageCommandResponseV1(value: unknown): OutputPackageCommandResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode', 'receipt', 'result',
      'conflictReason', 'rejectedReason'],
    ['schemaVersion', 'commandName', 'outcome', 'retryDirective', 'stableCode']);
  if (value.schemaVersion !== 1) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.commandName !== 'record-agent-output-package') throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!OUTPUT_PACKAGE_OUTCOMES.includes(value.outcome as OutputPackageOutcome)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (!OUTPUT_PACKAGE_RETRY_DIRECTIVES.includes(value.retryDirective as OutputPackageRetryDirective)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (value.receipt !== undefined) assertReceipt(value.receipt);
  if (value.result !== undefined) {
    // result 必须与 response 描述同一 command(防跨 command 串型)。
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).commandName !== value.commandName) {
      throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    }
    assertCommandOutput(value.result);
  }
  if (value.conflictReason !== undefined && !nonEmpty(value.conflictReason)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (value.rejectedReason !== undefined && !nonEmpty(value.rejectedReason)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as OutputPackageCommandResponseV1;
}

export function parseOutputPackageQueryInputV1(
  queryName: OutputPackageQueryName,
  value: unknown,
): OutputPackageQueryInputMapV1[OutputPackageQueryName] {
  if (queryName === 'get-output-package') {
    assertExactKeys(value, ['channelId', 'packageId', 'minimumConsistency'], ['channelId', 'packageId']);
    assertId(value.channelId);
    assertId(value.packageId);
    if (value.minimumConsistency !== undefined) assertConsistencyToken(value.minimumConsistency);
  } else if (queryName === 'list-channel-output-packages') {
    assertExactKeys(value, ['channelId', 'taskId', 'cursor', 'limit', 'minimumConsistency'], ['channelId']);
    assertId(value.channelId);
    if (value.taskId !== undefined) assertId(value.taskId);
    if (value.cursor !== undefined && !nonEmpty(value.cursor)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    if (value.limit !== undefined) assertInteger(value.limit, 1);
    if (value.minimumConsistency !== undefined) assertConsistencyToken(value.minimumConsistency);
  } else {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as OutputPackageQueryInputMapV1[OutputPackageQueryName];
}

export function parseOutputPackageQueryResponseV1(value: unknown): OutputPackageQueryResponseV1 {
  assertExactKeys(value,
    ['schemaVersion', 'queryName', 'outcome', 'stableCode', 'audienceScope', 'asOf', 'result', 'rejectedReason'],
    ['schemaVersion', 'queryName', 'outcome', 'stableCode', 'audienceScope', 'asOf']);
  if (value.schemaVersion !== OUTPUT_PACKAGE_QUERY_SCHEMA_VERSION) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!OUTPUT_PACKAGE_QUERY_NAMES.includes(value.queryName as OutputPackageQueryName)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (!OUTPUT_PACKAGE_QUERY_OUTCOMES.includes(value.outcome as OutputPackageQueryOutcome)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  if (!nonEmpty(value.stableCode)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  if (!nonEmpty(value.audienceScope)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  assertInteger(value.asOf, 0);
  if (value.result !== undefined) {
    if (value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
      || (value.result as Record<string, unknown>).queryName !== value.queryName) {
      throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
    }
    const result = value.result as Record<string, unknown>;
    if (value.queryName === 'get-output-package') {
      assertExactKeys(result, ['queryName', 'package', 'availableActions'], ['queryName', 'package']);
      assertPackageDto(result.package);
      if (result.availableActions !== undefined) {
        if (!Array.isArray(result.availableActions)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
        result.availableActions.forEach(assertMemberAvailableActions);
      }
    } else {
      assertExactKeys(result, ['queryName', 'packages', 'pendingDeliveries', 'nextCursor'],
        ['queryName', 'packages', 'pendingDeliveries']);
      if (!Array.isArray(result.packages)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
      result.packages.forEach(assertSummaryDto);
      if (!Array.isArray(result.pendingDeliveries)) throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
      result.pendingDeliveries.forEach(assertPendingDeliveryDto);
      if (result.nextCursor !== undefined && !nonEmpty(result.nextCursor)) {
        throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
      }
    }
  }
  if (value.rejectedReason !== undefined && !nonEmpty(value.rejectedReason)) {
    throw new Error(OUTPUT_PACKAGE_PAYLOAD_INVALID);
  }
  return structuredClone(value) as unknown as OutputPackageQueryResponseV1;
}

// ---------------------------------------------------------------------------
// Canonical serialization —— 幂等 conflict 判定的语义核心(#900 §3 / ADR-0067)
// ---------------------------------------------------------------------------

function canonicalizeValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => canonicalizeValue(entry));
  if (value && typeof value === 'object') {
    const sorted: Record<string, unknown> = {};
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      const entry = (value as Record<string, unknown>)[key];
      if (entry !== undefined) sorted[key] = canonicalizeValue(entry);
    }
    return sorted;
  }
  return value;
}

/**
 * 计算 command 的 canonical 串。hash 包含 command/schema 与语义 payload(channelId/publishId/
 * workspaceRevisionId),**排除** transport headers、trace ID 与 idempotency key(key 是查重键,
 * 不是内容指纹)。同 idempotency key 下:canonical 相等 = replay(返回首次 receipt);
 * canonical 不等 = idempotency_conflict。server 用此串派生 sha256 指纹(commandHash)。
 */
export function canonicalizeOutputPackageCommand(
  commandName: OutputPackageCommandName,
  commandSchemaVersion: number,
  input: unknown,
): string {
  return JSON.stringify(canonicalizeValue({
    v: OUTPUT_PACKAGE_COMMAND_HASH_VERSION,
    commandName,
    commandSchemaVersion,
    input,
  }));
}
