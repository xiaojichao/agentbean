import type { ID, UnixMs } from './common.js';
import type { AdapterKind } from './agent.js';
import type { SenderKind } from './message.js';

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
  id?: ID;
  name?: string;
  adapterKind: AdapterKind;
  args?: string[];
  command?: string;
  cwd?: string;
  env?: Record<string, string>;
}

export interface DispatchRequestDto {
  teamId: ID;
  channelId: ID;
  messageId: ID;
  threadId?: ID;
  agentId: ID;
  deviceId?: ID;
  requestId: string;
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
