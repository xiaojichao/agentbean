/**
 * #969 Project Channel Workspace 归档导出装配（纯函数）。
 *
 * 将已授权可读的最后 revision + 频道 artifact 装配为不可变的封存清单
 * （`ArchiveExportManifestDto`）。授权不在本函数——沿用 `archiveChannel` 模式：
 * usecases 用 `canApplyChannelUpdate` 判定治理者，通过后才调用本函数。
 *
 * 本函数零状态变更：只把已确认可读的数据塑形为只读副本。已发布交付物 =
 * `role: 'deliverable'` 的 artifact（domain 规则），其余 role 不进入清单。
 */
import type {
  ArchiveExportDeliverableDto,
  ArchiveExportManifestDto,
  ArtifactRole,
  ProjectChannelWorkspaceRevisionDto,
} from '@agentbean/contracts';

/** 频道 artifact 的最小投影；函数只挑 role='deliverable' 作为交付物。 */
export interface ArchiveExportArtifactInput {
  id: string;
  filename: string;
  mimeType: string;
  sizeBytes: number;
  role?: ArtifactRole;
  sha256?: string;
  /** 产出该 artifact 的 workspace run（provenance 锚点）。 */
  workspaceRunId?: string;
  createdAt: number;
}

export interface AssembleArchiveExportManifestInput {
  teamId: string;
  channelId: string;
  exportedByUserId: string;
  now: number;
  /** 已确认存在的最后（当前）revision，含其 import provenance。 */
  revision: ProjectChannelWorkspaceRevisionDto;
  /** 频道 artifact（任意 role）；函数过滤出 deliverable。 */
  artifacts: ReadonlyArray<ArchiveExportArtifactInput>;
}

/**
 * 装配归档导出封存清单。纯函数：相同输入恒等输出，不触碰任何外部状态。
 * deliverables 按 createdAt 升序稳定排列（便于审计追查）。
 */
export function assembleArchiveExportManifest(
  input: AssembleArchiveExportManifestInput,
): ArchiveExportManifestDto {
  const deliverables: ArchiveExportDeliverableDto[] = input.artifacts
    .filter((artifact) => artifact.role === 'deliverable')
    .map((artifact) => ({
      artifactId: artifact.id,
      filename: artifact.filename,
      mimeType: artifact.mimeType,
      sizeBytes: artifact.sizeBytes,
      role: 'deliverable' as const,
      ...(artifact.sha256 ? { sha256: artifact.sha256 } : {}),
      ...(artifact.workspaceRunId ? { workspaceRunId: artifact.workspaceRunId } : {}),
      createdAt: artifact.createdAt,
    }))
    .sort((a, b) => a.createdAt - b.createdAt);

  return {
    teamId: input.teamId,
    channelId: input.channelId,
    exportedAt: input.now,
    exportedByUserId: input.exportedByUserId,
    revision: input.revision,
    deliverables,
  };
}
