import type { ID, UnixMs } from './common.js';
import type { ArtifactRole } from './artifact.js';

/** A complete, immutable file manifest for one Project Channel Workspace revision. */
export interface ProjectChannelWorkspaceFileDto {
  path: string;
  artifactId: ID;
  /** #1043：稳定的 ProjectArtifactVersion 身份；旧 workspace revision 可缺省。 */
  artifactVersionId?: ID;
  collectionId?: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  sha256?: string;
}

/** #1043 执行前解析的稳定版本选择。current/final/file_package 只允许在 Server 端解析一次；file_package 使用包成员的 current projection。 */
export type DeviceWorkspaceSnapshotSelectionDto =
  | { readonly kind: 'current' | 'final'; readonly collectionId: ID }
  /**
   * File package selections carry the frozen package membership explicitly.
   * The Server resolves each member collection's current projection; it must
   * never infer package membership by scanning the whole channel library.
   */
  | { readonly kind: 'file_package'; readonly collectionId: ID; readonly memberCollectionIds: readonly ID[] }
  | { readonly kind: 'version'; readonly collectionId: ID; readonly versionId: ID };

export interface DeviceWorkspaceSnapshotInputSetItemDto {
  readonly collectionId: ID;
  readonly artifactVersionId: ID;
  readonly artifactId: ID;
  readonly path: string;
  readonly filename: string;
  readonly mimeType: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface DeviceWorkspaceSnapshotInputSetDto {
  readonly id: ID;
  readonly contractVersion: 1;
  readonly selections: readonly DeviceWorkspaceSnapshotSelectionDto[];
  readonly items: readonly DeviceWorkspaceSnapshotInputSetItemDto[];
}

export interface DeviceWorkspaceSnapshotProvenanceDto {
  readonly createdByDeviceId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskAttempt: number;
  readonly workspaceRunId: ID;
  readonly createdAt: UnixMs;
}

/** #1043 Server 创建、Device 物化并在 run 启动时只读使用的不可变 snapshot。 */
export interface DeviceWorkspaceSnapshotDto {
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly workspaceRevisionId: ID;
  readonly inputSet: DeviceWorkspaceSnapshotInputSetDto;
  readonly provenance: DeviceWorkspaceSnapshotProvenanceDto;
  readonly immutable: true;
}

export interface CreateDeviceWorkspaceSnapshotInput {
  readonly token: string;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly agentId: ID;
  readonly taskId: ID;
  readonly taskAttempt: number;
  readonly workspaceRunId: ID;
  readonly selections: readonly DeviceWorkspaceSnapshotSelectionDto[];
}

/** #1043 runtime boundary：Device/Server 不接受带漂移字段或未知 key 的 snapshot。 */
export function parseDeviceWorkspaceSnapshot(value: unknown): DeviceWorkspaceSnapshotDto {
  const snapshot = asRecord(value);
  exactKeys(snapshot, ['id', 'teamId', 'channelId', 'workspaceRevisionId', 'inputSet', 'provenance', 'immutable']);
  const inputSet = asRecord(snapshot.inputSet);
  exactKeys(inputSet, ['id', 'contractVersion', 'selections', 'items']);
  if (!isId(snapshot.id) || !isId(snapshot.teamId) || !isId(snapshot.channelId)
    || !isId(snapshot.workspaceRevisionId) || snapshot.immutable !== true
    || !isId(inputSet.id) || inputSet.contractVersion !== 1 || !Array.isArray(inputSet.selections) || !Array.isArray(inputSet.items)) invalidSnapshot();
  const provenance = asRecord(snapshot.provenance);
  exactKeys(provenance, ['createdByDeviceId', 'agentId', 'taskId', 'taskAttempt', 'workspaceRunId', 'createdAt']);
  if (!isId(provenance.createdByDeviceId) || !isId(provenance.agentId) || !isId(provenance.taskId)
    || !isId(provenance.workspaceRunId) || typeof provenance.taskAttempt !== 'number'
    || !Number.isSafeInteger(provenance.taskAttempt) || provenance.taskAttempt < 1
    || typeof provenance.createdAt !== 'number' || !Number.isSafeInteger(provenance.createdAt)) invalidSnapshot();
  const selections = inputSet.selections.map(parseDeviceWorkspaceSnapshotSelection);
  const items = inputSet.items.map((item) => {
    const record = asRecord(item);
    exactKeys(record, ['collectionId', 'artifactVersionId', 'artifactId', 'path', 'filename', 'mimeType', 'sizeBytes', 'sha256']);
    if (!isId(record.collectionId) || !isId(record.artifactVersionId) || !isId(record.artifactId)
      || !isText(record.path) || !isText(record.filename) || !isText(record.mimeType)
      || typeof record.sizeBytes !== 'number' || !Number.isSafeInteger(record.sizeBytes) || record.sizeBytes < 0
      || !/^[a-f0-9]{64}$/i.test(String(record.sha256))) invalidSnapshot();
    return record as unknown as DeviceWorkspaceSnapshotInputSetItemDto;
  });
  return structuredClone({
    id: snapshot.id as ID,
    teamId: snapshot.teamId as ID,
    channelId: snapshot.channelId as ID,
    workspaceRevisionId: snapshot.workspaceRevisionId as ID,
    inputSet: { id: inputSet.id as ID, contractVersion: 1 as const, selections, items },
    provenance: provenance as unknown as DeviceWorkspaceSnapshotDto['provenance'],
    immutable: true as const,
  });
}

export function parseDeviceWorkspaceSnapshotSelection(value: unknown): DeviceWorkspaceSnapshotSelectionDto {
  const selection = asRecord(value);
  if (selection.kind === 'version') {
    exactKeys(selection, ['kind', 'collectionId', 'versionId']);
    if (!isId(selection.collectionId) || !isId(selection.versionId)) invalidSnapshot();
    return selection as unknown as DeviceWorkspaceSnapshotSelectionDto;
  }
  if (selection.kind === 'current' || selection.kind === 'final') {
    exactKeys(selection, ['kind', 'collectionId']);
    if (!isId(selection.collectionId)) invalidSnapshot();
    return selection as unknown as DeviceWorkspaceSnapshotSelectionDto;
  }
  if (selection.kind === 'file_package') {
    exactKeys(selection, ['kind', 'collectionId', 'memberCollectionIds']);
    if (!isId(selection.collectionId) || !Array.isArray(selection.memberCollectionIds)
      || selection.memberCollectionIds.length === 0
      || selection.memberCollectionIds.some((id) => !isId(id))) invalidSnapshot();
    return selection as unknown as DeviceWorkspaceSnapshotSelectionDto;
  }
  invalidSnapshot();
}

function asRecord(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalidSnapshot();
  return value as Record<string, unknown>;
}

function exactKeys(value: Record<string, unknown>, required: readonly string[]): void {
  const actual = Object.keys(value).sort();
  const expected = [...required].sort();
  if (actual.length !== expected.length || actual.some((key, index) => key !== expected[index])) invalidSnapshot();
}

function isId(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function isText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}

function invalidSnapshot(): never {
  throw new Error('DEVICE_WORKSPACE_SNAPSHOT_INVALID');
}

/**
 * Provenance for a workspace revision created via device import.
 * Records which device initiated the import without exposing device absolute paths.
 */
export interface WorkspaceImportProvenanceDto {
  readonly kind: 'import';
  /** Device that performed the import. */
  readonly sourceDeviceId: ID;
  /** When the import happened (server-assigned timestamp). */
  readonly importedAt: UnixMs;
}

/**
 * #966 Provenance for a workspace revision created via atomic publish by an Agent.
 * Records the delivering Agent/Task attempt and the baseline revision it was based on,
 * so members can trace any published file back to its source Task/Agent.
 */
export interface WorkspacePublishProvenanceDto {
  readonly kind: 'publish';
  /** Agent that delivered this revision. */
  readonly agentId: ID;
  /** Task attempt that produced this delivery. */
  readonly taskId: ID;
  readonly taskAttempt: number;
  /** Workspace revision the Agent read as its fixed input (baseline). */
  readonly baselineRevisionId: ID;
  /** When the publish happened (server-assigned timestamp). */
  readonly publishedAt: UnixMs;
  /** #1044 交付本次 revision 的 Device(device publish 路径记录;旧 revision 可缺省)。 */
  readonly deviceId?: ID;
  /** #1044 产出本次交付的 WorkspaceRun(旧 revision 可缺省)。 */
  readonly workspaceRunId?: ID;
}

/** Discriminated provenance for a workspace revision. */
export type WorkspaceRevisionProvenanceDto = WorkspaceImportProvenanceDto | WorkspacePublishProvenanceDto;

export interface ProjectChannelWorkspaceRevisionDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  revision: number;
  files: ProjectChannelWorkspaceFileDto[];
  createdBy: ID;
  createdAt: UnixMs;
  /** Set when this revision was created via device import (#964) or atomic Agent publish (#966). */
  provenance?: WorkspaceRevisionProvenanceDto;
}

export interface ProjectChannelWorkspaceDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  currentRevisionId: ID;
  currentRevision: ProjectChannelWorkspaceRevisionDto;
}

/**
 * #969 归档导出中一项交付物的元数据与 provenance。
 *
 * 只含 artifact 元数据（不含 blob 字节）——客户端经既有 artifact 端点按 artifactId 取内容。
 * provenance 锚点：workspaceRunId（产出执行）+ sha256（内容校验）+ createdAt。
 */
export interface ArchiveExportDeliverableDto {
  artifactId: ID;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  role: ArtifactRole;
  sha256?: string;
  /** 产出该交付物的 workspace run。 */
  workspaceRunId?: ID;
  createdAt: UnixMs;
}

/**
 * #969 Project Channel Workspace 归档导出的封存清单（只读副本）。
 *
 * 由拥有频道治理权限的人类请求：冻结的最后 revision + 已发布交付物 + 必要 provenance。
 * 导出只装配既有授权可读数据——不恢复频道、不扩大权限、不改变任何状态。
 */
export interface ArchiveExportManifestDto {
  teamId: ID;
  channelId: ID;
  /** 导出时刻（server 赋值）。 */
  exportedAt: UnixMs;
  /** 发起导出的治理者。 */
  exportedByUserId: ID;
  /** 冻结的最后（当前）revision，含其 import provenance。 */
  revision: ProjectChannelWorkspaceRevisionDto;
  /** 已发布交付物（role=deliverable），按当前授权可读。 */
  deliverables: ArchiveExportDeliverableDto[];
}

/**
 * #968 One file a local user has chosen to apply back to a local directory.
 * Mirrors the relevant subset of ProjectChannelWorkspaceFileDto (no mimeType needed
 * for a disk write). The server never learns the target absolute path.
 */
export interface WorkspaceApplyFileEntryDto {
  path: string;
  artifactId: ID;
  filename: string;
  sizeBytes: number;
  sha256?: string;
}

/**
 * #967 Workspace 大文件暂存会话状态。
 * - open: 接受续传，内容对频道不可见
 * - committed: 已原子发布，可幂等查询最终 revision
 * - failed: 不可再提交（例如过期清理前标记）
 */
export type WorkspacePublishStagingStatusDto = 'open' | 'committed' | 'failed';

/** #967 暂存清单中的单个文件进度（上传中不出现在 revision / 频道文件索引）。 */
export interface WorkspacePublishStagingFileDto {
  path: string;
  filename: string;
  mimeType: string;
  expectedSizeBytes: number;
  expectedSha256: string;
  receivedBytes: number;
  complete: boolean;
}

/**
 * #967 以稳定 publish identity 标识的暂存会话。
 * 成员只能通过该 identity 查询进度或最终结果；上传中内容不进入 Workspace revision。
 */
export interface WorkspacePublishStagingDto {
  publishId: ID;
  teamId: ID;
  channelId: ID;
  baselineRevisionId: ID;
  status: WorkspacePublishStagingStatusDto;
  files: WorkspacePublishStagingFileDto[];
  createdBy: ID;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  /** 提交成功后写入；幂等查询最终 revision 用。 */
  committedRevisionId?: ID;
  committedWorkspaceId?: ID;
  /** 可选 Agent publish provenance（commit 时写入 revision）。 */
  provenance?: {
    agentId: ID;
    taskId: ID;
    taskAttempt: number;
    /** #1044 可选追溯：产出交付的 WorkspaceRun 与交付 Device。 */
    workspaceRunId?: ID;
    deviceId?: ID;
  };
}

/** #967 单文件 / 单次 publish 大小上限（Server 配置；超限明确拒绝）。 */
export const DEFAULT_WORKSPACE_STAGING_FILE_MAX_BYTES = 250 * 1024 * 1024;
export const DEFAULT_WORKSPACE_STAGING_PUBLISH_MAX_BYTES = 1024 * 1024 * 1024;
export const DEFAULT_WORKSPACE_STAGING_RETENTION_MS = 24 * 60 * 60 * 1000;

/** #968 Why a revision file cannot be applied at its path. */
export type WorkspaceApplyConflictReasonDto = 'LOCAL_FILE_EXISTS';

export interface WorkspaceApplyConflictDto {
  path: string;
  reason: WorkspaceApplyConflictReasonDto;
}

/**
 * #968 Preview of applying a published revision to a local directory.
 * Pure result of diffing a revision manifest against a local listing — no I/O,
 * no device provenance, so it is source-Device independent by construction.
 */
export interface WorkspaceApplyPlanDto {
  toWrite: WorkspaceApplyFileEntryDto[];
  conflicts: WorkspaceApplyConflictDto[];
}
