/**
 * #1065 AC3/AC4 Task 聚合交付视图契约。
 *
 * Chat/Task/Files 三处投影消费同一组 Server projections:Task 详情投影把
 * stage 目标/依赖、acceptance contract、责任焦点、delivery/package、合法
 * availableActions 与可审计执行链聚合为单一响应,web 只渲染、不推断。
 *
 * - availableActions 只是可发现性投影(AC9);command 提交时 Server 仍完整复验。
 * - responsibilityFocus 只由 Offer/claim/execution/delivery/review 等 Server
 *   事实投影(AC10),Task assignee 下拉、文件包或 Invocation 不自行授予责任。
 * - 卡片视图只显示当前责任焦点;详情保留完整执行链(AC4)。
 */
import type { ID, UnixMs } from './common.js';
import type { ConsistencyTokenV1 } from './system-activity.js';
import type { TaskDto } from './task.js';
import type { ProjectStageDto } from './project.js';
import type { OutputPackageSummaryDto, OutputPackagePendingDeliveryDto } from './output-package.js';

export const TASK_DELIVERY_OVERVIEW_SCHEMA_VERSION = 1;

/** 当前责任焦点(AC3/AC4/AC10;Server 投影,web 只渲染)。 */
export const TASK_RESPONSIBILITY_FOCUS_KINDS = [
  'none',
  'offer_wait',
  'claim_active',
  'execution_active',
  'review_wait',
] as const;
export type TaskResponsibilityFocusKind = (typeof TASK_RESPONSIBILITY_FOCUS_KINDS)[number];

export interface TaskResponsibilityFocusV1 {
  readonly kind: TaskResponsibilityFocusKind;
  /** offer_wait:待响应的 Offer 目标 Agent;claim/execution:claim 持有 Agent。 */
  readonly agentId?: ID;
  readonly agentName?: string;
  readonly offerId?: ID;
  readonly claimLeaseId?: ID;
  /** 人类可读的当前责任说明(文本标签,不只依赖颜色/图标)。 */
  readonly detail: string;
}

/** acceptance contract(AC3:谁验收、review 政策、客观 criteria 要求)。 */
export interface TaskAcceptanceContractV1 {
  readonly nodeKind: 'root' | 'subtask';
  readonly reviewPolicy: string;
  /** 创建时预绑定的人类验收 authority;空 = 未绑定(人类不得验收)。 */
  readonly humanAcceptanceAuthorityIds: readonly ID[];
  readonly requiresHumanAcceptance: boolean;
  readonly acceptanceCriteria: readonly string[];
  readonly taskRevision: number;
  readonly attempt: number;
  readonly maxAttempts: number;
}

/** 可审计执行链事件(AC4:Offer→acceptance→claim→execution→delivery→修改→review/final→交接)。 */
export const TASK_TIMELINE_EVENT_KINDS = [
  'offer',
  'acceptance',
  'claim',
  'execution_start',
  'delivery',
  'human_revision',
  'review',
  'finalization',
  'reject_delivery',
  'handoff',
] as const;
export type TaskTimelineEventKind = (typeof TASK_TIMELINE_EVENT_KINDS)[number];

export interface TaskTimelineEventV1 {
  readonly id: ID;
  readonly kind: TaskTimelineEventKind;
  readonly at: UnixMs;
  readonly actorKind: 'system' | 'agent' | 'human' | 'pi';
  readonly actorName?: string;
  /** 中文人类可读摘要(文本标签,AC11)。 */
  readonly summary: string;
}

/** Task 级可执行动作(Server 计算的可发现性投影,AC9;不据此签发 authority)。 */
export const TASK_LEVEL_ACTIONS = [
  'open-task',
  'delegate-to-agent',
  'review-package',
] as const;
export type TaskLevelAction = (typeof TASK_LEVEL_ACTIONS)[number];

export interface TaskLevelAvailableActionDto {
  readonly action: TaskLevelAction;
  readonly label: string;
  readonly disabled?: boolean;
  readonly disabledReason?: string;
}

export interface TaskDeliveryOverviewV1 {
  readonly schemaVersion: 1;
  readonly taskId: ID;
  readonly channelId: ID;
  readonly task: TaskDto;
  /** 阶段绑定存在时携带(目标/依赖/executionAllowed)。 */
  readonly stage?: ProjectStageDto;
  readonly acceptanceContract: TaskAcceptanceContractV1;
  readonly responsibilityFocus: TaskResponsibilityFocusV1;
  readonly delivery: {
    readonly packages: readonly OutputPackageSummaryDto[];
    readonly pendingDeliveries: readonly OutputPackagePendingDeliveryDto[];
    /** 最近交付包(UI「当前交付」焦点)。 */
    readonly focusPackageId?: ID;
  };
  readonly availableActions: readonly TaskLevelAvailableActionDto[];
  /** 按时间升序的完整执行链。 */
  readonly timeline: readonly TaskTimelineEventV1[];
  /** 读取水位与 audience scope(与 output-package query 同一 consistency 语义)。 */
  readonly asOf: UnixMs;
  readonly audienceScope: string;
  /** 投影依据的 stream 位置(查询带 minimumConsistency 时对照)。 */
  readonly consistencyToken: ConsistencyTokenV1;
}

export interface QueryTaskDeliveryOverviewInputV1 {
  readonly channelId: ID;
  readonly taskId: ID;
  readonly minimumConsistency?: ConsistencyTokenV1;
}
