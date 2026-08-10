import type { ID, UnixMs } from './common.js';
import type {
  OutputPackageDto,
  OutputPackageProjectionBlockerDto,
  OutputPackageProjectionMemberDto,
  OutputPackageProjectionResultV1,
  PackageMemberAvailableActionsDto,
} from './output-package.js';
import type { PackageReviewDto } from './package-review.js';
import type {
  ProjectArtifactFinalizationDto,
  ProjectArtifactVersionReviewState,
  ProjectArtifactVersionSourceDto,
  ProjectStageBlockingReasonDto,
  ProjectStageDto,
} from './project.js';
import { parseConsistencyTokenV1, type ConsistencyTokenV1 } from './system-activity.js';
import type { TaskDeliveryOverviewV1 } from './task-delivery-overview.js';

/** #1176：Tasks 中所选阶段的只读交付审核工作区。 */
export const STAGE_DELIVERY_REVIEW_WORKSPACE_SCHEMA_VERSION = 1;

export interface StageDeliveryReviewVersionIdentityV1 extends OutputPackageProjectionMemberDto {
  /** 版本来源由 Server 从 ProjectArtifactVersion 持久事实投影。 */
  readonly source: ProjectArtifactVersionSourceDto;
}

export interface StageDeliveryReviewMemberV1 {
  readonly sequence: number;
  readonly shortLabel: string;
  readonly collectionId: ID;
  /** OutputPackage 创建时冻结的具体版本身份；即使版本详情不可见也不改变。 */
  readonly artifactVersionId: ID;
  readonly requiredForFinal: boolean;
  readonly sourcePath: string;
  readonly filename: string;
  readonly delivered?: StageDeliveryReviewVersionIdentityV1;
  readonly current?: StageDeliveryReviewVersionIdentityV1;
  readonly final?: StageDeliveryReviewVersionIdentityV1;
  /** 仅在查询显式提交 specified selection 时出现。 */
  readonly specified?: StageDeliveryReviewVersionIdentityV1;
  readonly review: {
    readonly state?: ProjectArtifactVersionReviewState;
    readonly covered: boolean;
    readonly actualReviewerIds: readonly ID[];
    readonly records: readonly PackageReviewDto[];
  };
  readonly finalization?: ProjectArtifactFinalizationDto;
  /** 只用于动作可发现性；提交 command 时 Server 仍完整复验。 */
  readonly availableActions?: PackageMemberAvailableActionsDto;
}

export interface StageDeliveryReviewCoverageV1 {
  readonly requiredCount: number;
  readonly reviewedCount: number;
  readonly approvedCount: number;
  readonly uncoveredCount: number;
  readonly complete: boolean;
  readonly uncoveredCollectionIds: readonly ID[];
  readonly actualReviewerIds: readonly ID[];
}

export type StageDeliveryReviewBlockerV1 =
  | {
      readonly source: 'stage';
      readonly code: ProjectStageBlockingReasonDto['code'];
      readonly taskId: ID;
      readonly dependencyTaskId?: ID;
      readonly edgeId?: ID;
      readonly upstreamStageId?: ID;
      readonly requiredInputKey?: string;
    }
  | ({
      readonly source: 'projection';
      readonly policy: 'delivered' | 'current' | 'final' | 'specified';
    } & OutputPackageProjectionBlockerDto)
  | {
      readonly source: 'review';
      readonly code: 'required_review_missing';
      readonly collectionId: ID;
      readonly shortLabel: string;
      readonly filename: string;
    };

export interface StageDeliveryReviewPackageV1 {
  readonly package: OutputPackageDto;
  readonly projections: {
    readonly delivered: OutputPackageProjectionResultV1;
    readonly current: OutputPackageProjectionResultV1;
    readonly final: OutputPackageProjectionResultV1;
    readonly specified?: OutputPackageProjectionResultV1;
  };
  readonly members: readonly StageDeliveryReviewMemberV1[];
  readonly coverage: StageDeliveryReviewCoverageV1;
}

export interface StageDeliveryReviewWorkspaceV1 {
  readonly schemaVersion: 1;
  readonly channelId: ID;
  readonly stageId: ID;
  readonly taskId: ID;
  readonly stage: ProjectStageDto;
  readonly taskOverview: TaskDeliveryOverviewV1;
  /** 管理型根任务存在时指向持久化的来源 Thread；普通阶段任务可为空。 */
  readonly threadRootMessageId?: ID;
  readonly suggestedReviewerIds: readonly ID[];
  readonly archived: boolean;
  /** 当前焦点 OutputPackage；没有交付时为空，不伪造 package。 */
  readonly focusPackage?: StageDeliveryReviewPackageV1;
  readonly blockers: readonly StageDeliveryReviewBlockerV1[];
  readonly asOf: UnixMs;
  readonly audienceScope: string;
  readonly consistencyToken: ConsistencyTokenV1;
}

export interface QueryStageDeliveryReviewWorkspaceInputV1 {
  readonly schemaVersion: 1;
  readonly channelId: ID;
  readonly stageId: ID;
  readonly taskId: ID;
  readonly minimumConsistency?: ConsistencyTokenV1;
  readonly specifiedProjection?: {
    readonly packageId: ID;
    readonly versions: readonly { readonly collectionId: ID; readonly versionId: ID }[];
  };
}

const INVALID = 'STAGE_DELIVERY_REVIEW_WORKSPACE_PAYLOAD_INVALID';

function exactRecord(
  value: unknown,
  allowed: readonly string[],
  required: readonly string[],
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(INVALID);
  const keys = Object.keys(value);
  if (keys.some((key) => !allowed.includes(key)) || required.some((key) => !keys.includes(key))) {
    throw new Error(INVALID);
  }
}

function nonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Socket/Server 共用的 exact-key Query payload 校验。 */
export function parseQueryStageDeliveryReviewWorkspaceInputV1(
  value: unknown,
): QueryStageDeliveryReviewWorkspaceInputV1 {
  exactRecord(
    value,
    ['schemaVersion', 'channelId', 'stageId', 'taskId', 'minimumConsistency', 'specifiedProjection'],
    ['schemaVersion', 'channelId', 'stageId', 'taskId'],
  );
  if (
    value.schemaVersion !== STAGE_DELIVERY_REVIEW_WORKSPACE_SCHEMA_VERSION
    || !nonEmptyString(value.channelId)
    || !nonEmptyString(value.stageId)
    || !nonEmptyString(value.taskId)
  ) throw new Error(INVALID);
  if (value.minimumConsistency !== undefined) parseConsistencyTokenV1(value.minimumConsistency);
  if (value.specifiedProjection !== undefined) {
    exactRecord(value.specifiedProjection, ['packageId', 'versions'], ['packageId', 'versions']);
    if (!nonEmptyString(value.specifiedProjection.packageId) || !Array.isArray(value.specifiedProjection.versions)) {
      throw new Error(INVALID);
    }
    for (const item of value.specifiedProjection.versions) {
      exactRecord(item, ['collectionId', 'versionId'], ['collectionId', 'versionId']);
      if (!nonEmptyString(item.collectionId) || !nonEmptyString(item.versionId)) throw new Error(INVALID);
    }
  }
  return value as unknown as QueryStageDeliveryReviewWorkspaceInputV1;
}
