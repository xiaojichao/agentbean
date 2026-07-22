import type { ID, UnixMs } from './common.js';
import type { TaskDto } from './task.js';
import type { AgentHandoffTraceDto } from './collaboration.js';
import type { ManagementBudgetDto } from './management.js';

export type EvidenceKind = 'message' | 'artifact' | 'workspace-run' | 'invocation' | 'task';

export interface AcceptanceCriterionDto {
  readonly id: ID;
  readonly description: string;
  readonly evidenceRequired: boolean;
  readonly allowedEvidenceKinds?: readonly EvidenceKind[];
}

export interface EvidenceRefDto {
  readonly kind: EvidenceKind;
  readonly id: ID;
  readonly snapshotHash: string;
  readonly snapshotRevision?: number;
  readonly capturedAt: UnixMs;
}

export interface TaskCoordinationDto {
  readonly schemaVersion: 1;
  readonly rootTaskId?: ID;
  readonly parentTaskId?: ID;
  readonly managementRunId: ID;
  readonly nodeKind: 'root' | 'subtask';
  readonly reviewPolicy: 'human' | 'manager';
  readonly claimPolicy: 'open' | 'targeted';
  readonly requiredCapabilities: readonly string[];
  readonly acceptanceCriteria: readonly AcceptanceCriterionDto[];
  readonly dependencyTaskIds: readonly ID[];
  readonly attempt: number;
  readonly maxAttempts: number;
}

export interface SubtaskDeliveryV1 {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly taskId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly invocationId: ID;
  readonly summary: string;
  readonly claims: readonly {
    readonly statement: string;
    readonly evidenceRefs: readonly EvidenceRefDto[];
  }[];
  readonly evidenceRefs: readonly EvidenceRefDto[];
}

export interface SubtaskAcceptanceV1 {
  readonly schemaVersion: 1;
  readonly taskId: ID;
  readonly deliveryId: ID;
  readonly expectedTaskRevision: number;
  readonly taskAttempt: number;
  readonly claimLeaseId: ID;
  readonly decision: 'accepted' | 'rejected' | 'needs_human';
  readonly criteriaResults: readonly {
    readonly criterionId: ID;
    readonly passed: boolean;
    readonly evidenceRefs: readonly EvidenceRefDto[];
  }[];
  readonly reason: string;
  readonly decidedBy: 'manager' | 'human';
  readonly decidedAt: UnixMs;
}

export interface TaskDagClaimViewDto {
  readonly agentId: ID;
  readonly taskRevision: number;
  readonly taskAttempt: number;
  readonly status: 'active' | 'released' | 'expired' | 'invalidated';
  readonly acquiredAt: UnixMs;
  readonly expiresAt: UnixMs;
}

export interface TaskDagResultRefDto {
  readonly kind: EvidenceKind | 'invocation';
  readonly id: ID;
}

export interface TaskDagNodeViewDto {
  readonly task: TaskDto;
  readonly taskRevision: number;
  readonly coordination: TaskCoordinationDto;
  readonly claim?: TaskDagClaimViewDto;
  readonly latestDelivery?: {
    readonly id: ID;
    readonly invocationId: ID;
    readonly summary: string;
  };
  readonly canonicalAcceptance?: {
    readonly decision: SubtaskAcceptanceV1['decision'];
    readonly reason: string;
    readonly decidedBy: SubtaskAcceptanceV1['decidedBy'];
    readonly decidedAt: UnixMs;
  };
  readonly resultRefs: readonly TaskDagResultRefDto[];
}

export interface TaskDagViewDto {
  readonly schemaVersion: 1;
  readonly managementRunId: ID;
  readonly rootTaskId: ID;
  readonly graphRevision: number;
  readonly nodes: readonly TaskDagNodeViewDto[];
  readonly handoffs?: readonly AgentHandoffTraceDto[];
  readonly events: readonly {
    readonly sequence: number;
    readonly type: string;
    readonly createdAt: UnixMs;
  }[];
  /** Phase 4 第二阶段 #649：从既有 management events 派生的用量计数（不建表）。
   *  #660/#661：计数口径与 budget enforcement 逐维对齐——maxFanOut 为单父扇出峰值
   * （budget.maxSubtasks 的实际 enforcement 维度），maxDepthReached 为 0-based 边深
   * （root=0，同 evaluateTaskDag depthOf）。 */
  readonly usage?: {
    readonly maxFanOut: number;
    readonly externalInvocationCount: number;
    readonly maxDepthReached: number;
  };
  /** run 创建时冻结的预算上限（与 usage 对照展示）。 */
  readonly budget?: ManagementBudgetDto;
  /** #709 root task 的不可变 revision 历史（旧→新），供 Task 视图展示当前 revision、
   *  变更原因（supersededReasonCode）与已失效执行关系。已失效执行关系另由 events 中的
   *  claim-invalidated 事件表达。web 渲染见切片 C/E。 */
  readonly revisionHistory?: readonly TaskRevisionHistoryEntry[];
}

/** #709 Task revision 历史条目：append-only 保留的每个 revision 行投影（AC7）。 */
export interface TaskRevisionHistoryEntry {
  readonly revision: number;
  readonly objective: string;
  /** 是否已被后续 revision 取代（superseded）。 */
  readonly superseded: boolean;
  readonly supersededByRevision: number | null;
  readonly supersededReasonCode: string | null;
  readonly supersededAt: UnixMs | null;
  readonly createdAt: UnixMs;
}
