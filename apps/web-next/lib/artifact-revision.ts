/**
 * #1062 讨论串「新版本已保存」活动卡的 meta 解析。
 *
 * Server 在 save-artifact-version-revision 成功后 best-effort 追加 system 消息,
 * meta 快照只携带身份与 provenance(不复制 Markdown 全文)。卡片只是展示投影,
 * 不承载业务事实;Files/Task 的完整事实经 ProjectArtifactLibrary 读取。
 */

export const ARTIFACT_VERSION_REVISION_META_KIND = 'artifact-version-revision';

export interface ArtifactVersionRevisionMeta {
  readonly kind: 'artifact-version-revision';
  readonly collectionId: string;
  readonly collectionName?: string;
  readonly versionId: string;
  readonly versionNumber: number;
  readonly baseVersionId: string;
  readonly sourceVersionId: string;
  readonly basisReviewId?: string;
  readonly packageId?: string;
  readonly deliveryId?: string;
  readonly revisedBy?: string;
  readonly revisedByName?: string;
  readonly createdAt?: number;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value : undefined;
}

/** 从 system 消息 meta 解析活动卡(meta.kind !== 'artifact-version-revision' 时返回 null)。 */
export function artifactVersionRevisionFromMeta(
  meta: Record<string, unknown> | null | undefined,
): ArtifactVersionRevisionMeta | null {
  if (!meta || meta.kind !== ARTIFACT_VERSION_REVISION_META_KIND) return null;
  const collectionId = asString(meta.collectionId);
  const versionId = asString(meta.versionId);
  const baseVersionId = asString(meta.baseVersionId);
  const sourceVersionId = asString(meta.sourceVersionId);
  if (!collectionId || !versionId || !baseVersionId || !sourceVersionId) return null;
  const versionNumber = typeof meta.versionNumber === 'number' && Number.isSafeInteger(meta.versionNumber)
    ? meta.versionNumber
    : 0;
  return {
    kind: 'artifact-version-revision',
    collectionId,
    ...(asString(meta.collectionName) ? { collectionName: asString(meta.collectionName) } : {}),
    versionId,
    versionNumber,
    baseVersionId,
    sourceVersionId,
    ...(asString(meta.basisReviewId) ? { basisReviewId: asString(meta.basisReviewId) } : {}),
    ...(asString(meta.packageId) ? { packageId: asString(meta.packageId) } : {}),
    ...(asString(meta.deliveryId) ? { deliveryId: asString(meta.deliveryId) } : {}),
    ...(asString(meta.revisedBy) ? { revisedBy: asString(meta.revisedBy) } : {}),
    ...(asString(meta.revisedByName) ? { revisedByName: asString(meta.revisedByName) } : {}),
    ...(typeof meta.createdAt === 'number' ? { createdAt: meta.createdAt } : {}),
  };
}
