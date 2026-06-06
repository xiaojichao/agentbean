import type { ID, UnixMs } from './common';
import type { AdapterKind } from './agent';

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

export interface DispatchCustomAgentDto {
  adapterKind: AdapterKind;
  command?: string;
  cwd?: string;
}

export interface DispatchRequestDto {
  teamId: ID;
  channelId: ID;
  messageId: ID;
  agentId: ID;
  requestId: string;
  prompt: string;
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
