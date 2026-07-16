import type { ID, UnixMs } from './common.js';
import type { AdapterKind } from './agent.js';
import type { SenderKind } from './message.js';
import type { AgentInvocationTaskContextV1, DependencyResultRefDto } from './invocation.js';
import type { AcceptanceCriterionDto, EvidenceRefDto } from './task-coordination.js';
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

export interface DispatchCustomAgentDto {
  id?: ID;
  name?: string;
  adapterKind: AdapterKind;
  args?: string[];
  command?: string;
  cwd?: string;
  envRef?: AgentEnvRefDto;
}

export interface DispatchManagementContextDto {
  invocationId: ID;
  taskContext?: AgentInvocationTaskContextV1;
  contextRefs: readonly EvidenceRefDto[];
  dependencyResults: readonly DependencyResultRefDto[];
  acceptanceCriteria: readonly AcceptanceCriterionDto[];
}

export type DispatchMemoryContextProvenanceDto =
  | {
      readonly origin: 'server';
      readonly capsuleId: ID;
      readonly authorizationDecisionId: ID;
      readonly sourceRefs: readonly MemorySourceRefDto[];
    }
  | {
      readonly origin: 'local';
      readonly sourceKind: 'scan' | 'workspace_run' | 'manual' | 'local_file';
    };

/**
 * Runtime-only Memory projection. Server entries are already bound to and revalidated against an
 * Invocation Capsule; local entries are appended by the Device and must never be sent upstream.
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
  memoryContext?: readonly DispatchMemoryContextItemDto[];
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
