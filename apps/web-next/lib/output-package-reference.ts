/**
 * #1063/#1065 文件包引用构建层(从 OutputPackageCard 抽取,纯移动,不改语义)。
 *
 * 把「整包投影预览 → 选择构建」与「成员显式选择构建」抽成可复用件:
 * 讨论串卡片(OutputPackageCard)与文件库(ProjectFilesBoard 工具栏)共用同一实现,
 * 选择落点与 Server 事实保持一致。
 *
 * 契约(与卡片原行为一致):
 * - 投影预览:经 getOutputPackage(projection policy delivered/current/final)向 Server
 *   询问解析结果;不可用(网络失败/上下文缺失)时返回 null,调用方不产生选择。
 * - status=ready → 产生 package_projection 选择;current/final 携带逐成员
 *   collectionRevision 的 expectedMemberRevisions fence,delivered 是冻结事实无 fence。
 * - status=not_ready → 返回 blockers 清单(final 缺失/被拒 current 等),不产生选择;
 *   shortLabel/filename 为可选字段,缺省时回落空串。
 * - 成员单选/多选/「基于此修改」→ package_members 显式选择(顺序由发送方给定,
 *   Server 不重排);空列表不产生选择。
 */

import { projectEvents } from '@/lib/socket';
import type {
  OutputPackageProjectionResultV1,
  ProjectReferencePackageMemberVersionDto,
  ProjectReferenceSelectionRequestDto,
} from '@agentbean/contracts';

/** 整包引用三入口(与 OUTPUT_PACKAGE_PROJECTION_POLICIES 的 delivered/current/final 一致)。 */
export type PackageProjectionPolicy = 'delivered' | 'current' | 'final';

/** UI 展示用的阻断项(shortLabel/filename 可缺省)。 */
export interface PackageProjectionBlocker {
  shortLabel: string;
  filename: string;
  code: string;
}

/** 整包投影预览结果:ready → selection;not_ready → blockers。 */
export interface PackageProjectionPreviewResult {
  /** ready 时产出带 expectedMemberRevisions fence 的 package_projection 选择。 */
  selection?: ProjectReferenceSelectionRequestDto;
  /** not_ready 时逐项阻断清单(final 缺失/被拒 current 等)。 */
  blockers: PackageProjectionBlocker[];
}

/** 整包投影预览:请求 Server 解析;不可用(!ok/缺 projection)时返回 null。 */
export async function loadPackageProjection(
  channelId: string,
  packageId: string,
  policy: PackageProjectionPolicy,
): Promise<OutputPackageProjectionResultV1 | null> {
  const result = await projectEvents().getOutputPackage({
    channelId,
    packageId,
    projection: { policy },
  });
  if (!result.ok || !result.projection) return null;
  return result.projection;
}

/**
 * 由投影解析结果构建选择或阻断清单。
 * ready → package_projection 选择;not_ready → blockers(shortLabel/filename 缺省回落空串)。
 */
export function buildPackageProjectionSelection(
  packageId: string,
  policy: PackageProjectionPolicy,
  projection: OutputPackageProjectionResultV1,
): PackageProjectionPreviewResult {
  if (projection.status !== 'ready') {
    return {
      blockers: projection.blockers.map((blocker) => ({
        shortLabel: blocker.shortLabel ?? '',
        filename: blocker.filename ?? '',
        code: blocker.code,
      })),
    };
  }
  const expectedMemberRevisions = policy === 'delivered'
    ? undefined
    : projection.members.map((member) => ({
      collectionId: member.collectionId,
      revision: member.collectionRevision,
    }));
  return {
    selection: {
      kind: 'package_projection',
      packageId,
      policy,
      ...(expectedMemberRevisions ? { expectedMemberRevisions } : {}),
    },
    blockers: [],
  };
}

/**
 * 成员显式选择(单选=单成员;多选=多成员;「基于此修改」=显式选择被拒版本)。
 * members 为空时返回 null,调用方不产生选择。
 */
export function buildPackageMembersSelection(
  packageId: string,
  members: readonly ProjectReferencePackageMemberVersionDto[],
): ProjectReferenceSelectionRequestDto | null {
  if (members.length === 0) return null;
  return { kind: 'package_members', packageId, members: [...members] };
}
