/**
 * #1060 讨论串文件包卡片的 meta 解析。
 *
 * Server 在 package 成形后追加 system 消息,meta 快照与冻结的 package 成员一一对应
 * (交付后成员/版本不可变),故卡片展示不会与 Server 事实漂移。卡片只是展示投影,
 * 不承载任何业务事实;Files/Task 的完整事实经 listOutputPackages/getOutputPackage 读取。
 */

export const OUTPUT_PACKAGE_META_KIND = 'output-package';

export interface OutputPackageMemberMeta {
  readonly shortLabel: string;
  readonly filename: string;
  readonly artifactVersionId: string;
  readonly collectionId: string;
}

export interface OutputPackageMeta {
  readonly kind: 'output-package';
  readonly packageId: string;
  /** Server 从 delivery provenance 解析出的原讨论串 root；审核退回时优先使用。 */
  readonly threadRootMessageId?: string;
  readonly taskId?: string;
  readonly taskTitle?: string;
  readonly agentId?: string;
  readonly agentName?: string;
  readonly memberCount: number;
  readonly members: readonly OutputPackageMemberMeta[];
  readonly workspaceRevisionId: string;
  readonly publishId: string;
  readonly createdAt?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 从 system 消息 meta 解析文件包卡片(meta.kind !== 'output-package' 时返回 null)。 */
export function outputPackageFromMeta(meta: Record<string, unknown> | null | undefined): OutputPackageMeta | null {
  if (!meta || meta.kind !== OUTPUT_PACKAGE_META_KIND) return null;
  const packageId = asString(meta.packageId);
  if (!packageId) return null;
  const rawMembers = Array.isArray(meta.members) ? meta.members : [];
  const members: OutputPackageMemberMeta[] = rawMembers
    .filter((entry): entry is Record<string, unknown> => Boolean(entry) && typeof entry === 'object')
    .map((entry) => ({
      shortLabel: asString(entry.shortLabel) ?? '',
      filename: asString(entry.filename) ?? '',
      artifactVersionId: asString(entry.artifactVersionId) ?? '',
      collectionId: asString(entry.collectionId) ?? '',
    }))
    .filter((entry) => entry.filename);
  const memberCount = typeof meta.memberCount === 'number' && Number.isSafeInteger(meta.memberCount)
    ? meta.memberCount
    : members.length;
  return {
    kind: 'output-package',
    packageId,
    ...(asString(meta.threadRootMessageId) ? { threadRootMessageId: asString(meta.threadRootMessageId) } : {}),
    ...(asString(meta.taskId) ? { taskId: asString(meta.taskId) } : {}),
    ...(asString(meta.taskTitle) ? { taskTitle: asString(meta.taskTitle) } : {}),
    ...(asString(meta.agentId) ? { agentId: asString(meta.agentId) } : {}),
    ...(asString(meta.agentName) ? { agentName: asString(meta.agentName) } : {}),
    memberCount,
    members,
    workspaceRevisionId: asString(meta.workspaceRevisionId) ?? '',
    publishId: asString(meta.publishId) ?? '',
    ...(typeof meta.createdAt === 'number' ? { createdAt: meta.createdAt } : {}),
  };
}

/**
 * #1111 内嵌形态:agent 回复消息的 meta.outputPackageCard(server 在 receiveDispatchResult
 * 挂入,daemon ≥0.3.43 回报 publishId 时)。卡片随回复气泡内嵌渲染,不再以独立
 * system 消息占位——返回 null 表示该消息不内嵌卡片。
 */
export function inlineOutputPackageFromMeta(
  meta: Record<string, unknown> | null | undefined,
): OutputPackageMeta | null {
  const nested = meta?.outputPackageCard;
  if (!nested || typeof nested !== 'object') return null;
  return outputPackageFromMeta(nested as Record<string, unknown>);
}
