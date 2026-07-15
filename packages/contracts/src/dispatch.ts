import type { ID, UnixMs } from './common.js';
import type { AdapterKind } from './agent.js';
import type { SenderKind } from './message.js';
import type { AgentInvocationTaskContextV1, DependencyResultRefDto } from './invocation.js';
import type { AcceptanceCriterionDto, EvidenceRefDto } from './task-coordination.js';

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
