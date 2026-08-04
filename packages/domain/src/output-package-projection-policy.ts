import type {
  OutputPackageProjectionBlockerDto,
  OutputPackageProjectionMemberDto,
  OutputPackageProjectionOmittedDto,
  OutputPackageProjectionPolicy,
  ProjectArtifactVersionReviewState,
} from '@agentbean/contracts';

/**
 * #1063 OutputPackage projection 解析纯策略(父规格 #1059 §3/§6)。
 *
 * 输入全部由 Server 从已持久化事实读取(package 冻结成员、collections、versions、
 * 最新 review 状态),调用方不得自报。本模块只回答「按某策略,这一包现在解析成哪些
 * 具体版本」,四种策略的语义边界:
 *
 * - delivered:还原 package 创建时冻结的交付版本,不读取 collection 任何指针;
 * - current:同一读取快照逐成员解析 collection.currentVersionId;解析结果处于
 *   rejected/changes_requested 的成员构成 current_not_formal 阻断(整包默认正式输入
 *   不含被拒版本),用户可改用 specified 显式选择(“基于此修改”);
 * - final:必需成员(requiredForFinal)必须存在 finalVersionId,缺失即整体 not_ready
 *   并列出缺失项;非必需成员无 final 时进入 omitted 明确省略,绝不以 current 补齐;
 * - specified:逐项校验版本属于某成员的 collection,否则 version_not_in_package;
 *   显式版本不过 review 闸(用户显式意图优先)。
 *
 * status=not_ready 时 members 仍携带可解析部分(供 UI 展示缺失上下文),
 * 调用方必须先检查 status,不得把 not_ready 的 members 当作可冻结输入。
 */

/** package 冻结成员事实(创建后不可变)。 */
export interface OutputPackageProjectionMemberFact {
  readonly sequence: number;
  readonly shortLabel: string;
  readonly collectionId: string;
  readonly deliveredVersionId: string;
  readonly requiredForFinal: boolean;
  readonly filename: string;
}

export interface OutputPackageProjectionCollectionFact {
  readonly id: string;
  readonly revision: number;
  readonly currentVersionId: string;
  readonly finalVersionId?: string;
}

export interface OutputPackageProjectionVersionFact {
  readonly id: string;
  readonly collectionId: string;
  readonly versionNumber: number;
  readonly artifactId: string;
  readonly filename: string;
  /** Server 按当前请求者判定的可见性;不可见版本按 collection_unavailable 处理。 */
  readonly visible: boolean;
}

export interface OutputPackageProjectionResolution {
  readonly status: 'ready' | 'not_ready';
  readonly members: readonly OutputPackageProjectionMemberDto[];
  readonly blockers: readonly OutputPackageProjectionBlockerDto[];
  readonly omitted: readonly OutputPackageProjectionOmittedDto[];
}

/** 成员归属判定结果(projection 与 eligibility 共用,消除两处重复)。 */
export type ProjectPackageMemberVersionVerdict =
  | { readonly kind: 'hit'; readonly version: OutputPackageProjectionVersionFact }
  | { readonly kind: 'not_in_package' }
  | { readonly kind: 'not_visible' };

/**
 * 判定 (collectionId, versionId) 是否属于 package 成员且可见。
 * - not_in_package:collection 不是成员 / version 不存在 / version.collectionId 不匹配;
 * - not_visible:版本存在但当前请求者不可见。
 */
export function resolveProjectPackageMemberVersion(
  input: {
    readonly memberCollectionIds: ReadonlySet<string>;
    readonly versions: readonly OutputPackageProjectionVersionFact[];
  },
  collectionId: string,
  versionId: string,
): ProjectPackageMemberVersionVerdict {
  if (!input.memberCollectionIds.has(collectionId)) return { kind: 'not_in_package' };
  const version = input.versions.find((v) => v.id === versionId);
  if (!version || version.collectionId !== collectionId) return { kind: 'not_in_package' };
  if (!version.visible) return { kind: 'not_visible' };
  return { kind: 'hit', version };
}

export function resolveOutputPackageProjection(input: {
  readonly members: readonly OutputPackageProjectionMemberFact[];
  readonly collections: readonly OutputPackageProjectionCollectionFact[];
  readonly versions: readonly OutputPackageProjectionVersionFact[];
  readonly reviewStateByVersionId: ReadonlyMap<string, ProjectArtifactVersionReviewState>;
  readonly policy: OutputPackageProjectionPolicy;
  /** policy=specified 时必填:用户显式选择的版本清单(顺序由调用方给定,不重排)。 */
  readonly specifiedVersions?: readonly { readonly collectionId: string; readonly versionId: string }[];
}): OutputPackageProjectionResolution {
  const collectionById = new Map(input.collections.map((collection) => [collection.id, collection]));
  const versionById = new Map(input.versions.map((version) => [version.id, version]));
  const members: OutputPackageProjectionMemberDto[] = [];
  const blockers: OutputPackageProjectionBlockerDto[] = [];
  const omitted: OutputPackageProjectionOmittedDto[] = [];

  const pushMember = (
    member: OutputPackageProjectionMemberFact,
    version: OutputPackageProjectionVersionFact,
    collection: OutputPackageProjectionCollectionFact,
  ) => {
    members.push({
      sequence: member.sequence,
      shortLabel: member.shortLabel,
      collectionId: member.collectionId,
      versionId: version.id,
      versionNumber: version.versionNumber,
      artifactId: version.artifactId,
      filename: version.filename,
      reviewState: input.reviewStateByVersionId.get(version.id) ?? 'pending',
      isFinalVersion: collection.finalVersionId === version.id,
      collectionRevision: collection.revision,
    });
  };

  if (input.policy === 'specified') {
    const memberCollectionIds = new Set(input.members.map((member) => member.collectionId));
    for (const requested of input.specifiedVersions ?? []) {
      const verdict = resolveProjectPackageMemberVersion({
        memberCollectionIds,
        versions: input.versions,
      }, requested.collectionId, requested.versionId);
      if (verdict.kind === 'not_in_package') {
        blockers.push({
          code: 'version_not_in_package',
          collectionId: requested.collectionId,
          versionId: requested.versionId,
        });
        continue;
      }
      if (verdict.kind === 'not_visible') {
        blockers.push({
          code: 'collection_unavailable',
          collectionId: requested.collectionId,
          versionId: requested.versionId,
        });
        continue;
      }
      const member = input.members.find((candidate) => candidate.collectionId === requested.collectionId);
      const collection = collectionById.get(verdict.version.collectionId);
      if (!collection) {
        blockers.push({
          code: 'collection_unavailable',
          collectionId: requested.collectionId,
          versionId: requested.versionId,
        });
        continue;
      }
      pushMember(member!, verdict.version, collection);
    }
    return {
      status: blockers.length > 0 ? 'not_ready' : 'ready',
      members,
      blockers,
      omitted,
    };
  }

  for (const member of input.members) {
    const collection = collectionById.get(member.collectionId);
    if (input.policy === 'delivered') {
      // delivered 只还原冻结事实;collection 缺失时该成员按不可用阻断
      // (collectionRevision 语义上无指针可对,不产出 0)。
      const version = versionById.get(member.deliveredVersionId);
      if (!version || !version.visible || !collection) {
        blockers.push({
          code: 'collection_unavailable',
          collectionId: member.collectionId,
          shortLabel: member.shortLabel,
          filename: member.filename,
        });
        continue;
      }
      pushMember(member, version, collection);
      continue;
    }

    if (!collection) {
      blockers.push({
        code: 'collection_unavailable',
        collectionId: member.collectionId,
        shortLabel: member.shortLabel,
        filename: member.filename,
      });
      continue;
    }

    if (input.policy === 'current') {
      const version = versionById.get(collection.currentVersionId);
      if (!version || !version.visible) {
        blockers.push({
          code: 'collection_unavailable',
          collectionId: member.collectionId,
          shortLabel: member.shortLabel,
          filename: member.filename,
        });
        continue;
      }
      pushMember(member, version, collection);
      const reviewState = input.reviewStateByVersionId.get(version.id) ?? 'pending';
      if (reviewState === 'rejected' || reviewState === 'changes_requested') {
        blockers.push({
          code: 'current_not_formal',
          collectionId: member.collectionId,
          shortLabel: member.shortLabel,
          filename: member.filename,
        });
      }
      continue;
    }

    // final:必需成员缺 finalVersionId → missing_final;非必需无 final → 明确省略。
    if (!collection.finalVersionId) {
      if (member.requiredForFinal) {
        blockers.push({
          code: 'missing_final',
          collectionId: member.collectionId,
          shortLabel: member.shortLabel,
          filename: member.filename,
        });
      } else {
        omitted.push({
          collectionId: member.collectionId,
          shortLabel: member.shortLabel,
          filename: member.filename,
          reason: 'final_not_required',
        });
      }
      continue;
    }
    const finalVersion = versionById.get(collection.finalVersionId);
    if (!finalVersion || !finalVersion.visible) {
      blockers.push({
        code: 'collection_unavailable',
        collectionId: member.collectionId,
        shortLabel: member.shortLabel,
        filename: member.filename,
      });
      continue;
    }
    pushMember(member, finalVersion, collection);
  }

  return {
    status: blockers.length > 0 ? 'not_ready' : 'ready',
    members,
    blockers,
    omitted,
  };
}
