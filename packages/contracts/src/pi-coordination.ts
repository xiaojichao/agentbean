import type { ID, UnixMs } from './common.js';

export type ChannelCoordinationJobStatus =
  | 'pending'
  | 'running'
  | 'retry_wait'
  | 'completed'
  | 'failed'
  | 'cancelled';

export type ChannelCoordinationActiveModelSnapshot =
  | { readonly availability: 'unavailable' }
  | {
      readonly availability: 'available';
      readonly cardId: ID;
      readonly revisionId: ID;
      readonly modelId: string;
    };

/** Server-internal durable work item. Never project activeModel to Team/Web DTOs. */
export interface ChannelCoordinationJobRecord {
  readonly id: ID;
  readonly teamId: ID;
  readonly channelId: ID;
  readonly messageId: ID;
  readonly idempotencyKey: string;
  readonly status: ChannelCoordinationJobStatus;
  readonly attempt: number;
  readonly nextRetryAt: UnixMs | null;
  readonly activeModel: ChannelCoordinationActiveModelSnapshot;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
}
