import type { ID, UnixMs } from './common.js';
import type { AdapterKind } from './agent.js';
import type { ArtifactRole } from './artifact.js';
import type { SenderKind } from './message.js';
import type { AgentInvocationTaskContextV1, DependencyResultRefDto } from './invocation.js';
import type { AcceptanceCriterionDto, EvidenceRefDto } from './task-coordination.js';
import type { ProjectReferenceSetDto } from './project-reference.js';
import type { ProjectDocumentInputSetV1 } from './project-document-input-set.js';
import type { DeviceWorkspaceSnapshotDto } from './project-channel-workspace.js';
import type {
  LocalMemoryScopeType,
  MemoryKind,
  MemoryScopeType,
  MemorySourceRefDto,
} from './management-memory.js';

export type DispatchStatus =
  | 'queued'
  | 'sent'
  | 'accepted'
  | 'running'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'timed_out';

/** Daemon 对一次 invocation 的终态判定。超时/取消是 stopped，不是 failed。 */
export type DispatchOutcome = 'succeeded' | 'failed' | 'stopped';

export type DispatchReasonCode =
  | 'ADAPTER_EXIT'
  | 'USER_CANCELLED'
  | 'EXECUTION_LIMIT';

export const EXECUTION_LIMIT_REASON_TEXT = '已达执行上限，系统已停止等待';
export const USER_CANCELLED_REASON_TEXT = '执行已被取消';

export interface DispatchAttachmentDto {
  id: ID;
  name: string;
  mimeType?: string;
  sizeBytes?: number;
}

export interface AgentEnvRefDto {
  agentId: ID;
  teamId: ID;
}

export interface AgentArtifactSourceRootConfigDto {
  id: ID;
  label: string;
  envVarName: string;
  defaultRole: Exclude<ArtifactRole, 'attachment'>;
  recursive: boolean;
}

export interface DispatchCustomAgentDto {
  id?: ID;
  name?: string;
  adapterKind: AdapterKind;
  args?: string[];
  command?: string;
  cwd?: string;
  envRef?: AgentEnvRefDto;
  artifactSourceRoots?: AgentArtifactSourceRootConfigDto[];
}

export interface DispatchManagementContextDto {
  invocationId: ID;
  taskContext?: AgentInvocationTaskContextV1;
  contextRefs: readonly EvidenceRefDto[];
  dependencyResults: readonly DependencyResultRefDto[];
  acceptanceCriteria: readonly AcceptanceCriterionDto[];
}

/**
 * Memory context 来源判别联合。
 * - server/capsule：经 Invocation Capsule 授权复验的协作记忆（capsuleId + authorizationDecisionId）。
 * - server/projection（#718）：Team opted-in 的 Agent Memory 公开投影（projectionId；opt-in 即独立授权，
 *   不经 Capsule，server 端 fail-closed 实时查 active+opt-in+revision fence）。
 * - local：Device 端 scan/workspace_run/manual/local_file，只留 Device 不上送。
 */
export type DispatchMemoryContextProvenanceDto =
  | {
      readonly origin: 'server';
      readonly capsuleId: ID;
      readonly authorizationDecisionId: ID;
      readonly sourceRefs: readonly MemorySourceRefDto[];
    }
  | {
      readonly origin: 'server';
      readonly projectionId: ID;
      readonly sourceRefs: readonly MemorySourceRefDto[];
    }
  | {
      readonly origin: 'local';
      readonly sourceKind: 'scan' | 'workspace_run' | 'manual' | 'local_file';
    };

/**
 * Runtime-only Memory projection. Server capsule entries are bound to and revalidated against an
 * Invocation Capsule; server projection entries (#718) are Team opted-in Agent Memory; local entries
 * are appended by the Device and must never be sent upstream.
 */
export interface DispatchMemoryContextItemDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly kind: MemoryKind;
  readonly scopeType: MemoryScopeType | LocalMemoryScopeType;
  readonly content: string;
  readonly selectionReason: string;
  readonly provenance: DispatchMemoryContextProvenanceDto;
}

export interface DispatchRequestDto {
  claimRequired?: boolean;
  teamId: ID;
  channelId: ID;
  messageId: ID;
  threadId?: ID;
  agentId: ID;
  deviceId?: ID;
  requestId: string;
  managementInvocationId?: ID;
  managementContext?: DispatchManagementContextDto;
  /**
   * Direct Agent 的 Server 派生 Task / run 身份。managed invocation 仍以
   * managementContext.taskContext 为权威；旧调用方可省略并由 daemon 回退到 dispatch id。
   */
  taskId?: ID;
  taskAttempt?: number;
  workspaceRunId?: ID;
  memoryContext?: readonly DispatchMemoryContextItemDto[];
  /**
   * 本次 prompt 中各消息发送时冻结的项目引用事实。
   * 合并消息必须逐条保留，执行端不得重新解析为较新的 revision/version。
   */
  projectReferenceSets?: readonly ProjectReferenceSetDto[];
  /** 必需输入；Device 必须完整物化并校验后才可启动 Agent。 */
  projectDocumentInputSet?: ProjectDocumentInputSetV1;
  /** #1043 不可变 Device snapshot；执行端不得回读 current/final。 */
  workspaceSnapshot?: DeviceWorkspaceSnapshotDto;
  prompt: string;
  history?: DispatchHistoryMessageDto[];
  attachments?: DispatchAttachmentDto[];
  customAgent?: DispatchCustomAgentDto;
}

export interface DispatchDto {
  id: ID;
  teamId: ID;
  channelId: ID;
  messageId: ID;
  agentId: ID;
  status: DispatchStatus;
  requestId: string;
  createdAt: UnixMs;
  updatedAt: UnixMs;
  acceptedAt?: UnixMs;
  completedAt?: UnixMs;
  error?: string;
  /** 最后一次 dispatch:progress 心跳时间；用于失联判定（null 表示尚无心跳，回退 updatedAt）。 */
  lastHeartbeatAt?: UnixMs;
}

/**
 * daemon → server 的终态回报扩展。旧 daemon 可不带这些字段，
 * Server 回退到 workspaceRun.status。
 */
export interface DispatchTerminalReportV1 {
  readonly outcome: DispatchOutcome;
  readonly reasonCode?: DispatchReasonCode | string;
  readonly reasonText?: string;
}

export interface DispatchHistoryItemDto extends DispatchDto {
  promptPreview?: string;
}

export interface DispatchHistoryMessageDto {
  messageId: ID;
  threadId?: ID;
  senderKind: SenderKind;
  senderId: ID;
  body: string;
  createdAt: UnixMs;
}
