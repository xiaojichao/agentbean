import type { CompletionNotificationDto, CompletionNotificationCursor } from '../../../../packages/contracts/src/completion-notification.js';
import type { PushNotificationRepository } from './push-notification-repository.js';

export interface CompletionSource {
  readonly id: string;
  readonly teamId: string;
  readonly taskId: string | null;
  readonly dispatchId: string | null;
  readonly revision: number;
  readonly createdAt: number;
  readonly retryAt: number;
}

export interface CompletionNotificationRepository extends PushNotificationRepository {
  enqueue(source: CompletionSource): Promise<void>;
  pending(now: number, limit: number): Promise<CompletionSource[]>;
  defer(id: string, retryAt: number): Promise<void>;
  /** Atomically finish the source and persist recipient projections. */
  complete(id: string, items: readonly CompletionNotificationDto[]): Promise<void>;
  list(teamId: string, recipientId: string, cursor?: CompletionNotificationCursor): Promise<CompletionNotificationDto[]>;
  get(teamId: string, recipientId: string, id: string): Promise<CompletionNotificationDto | null>;
  unreadScopes(teamId: string, recipientId: string): Promise<Array<{ channelId?: string; taskId?: string; count: number }>>;
  pruneRead(teamId: string, recipientId: string, now: number): Promise<void>;
  markRead(teamId: string, recipientId: string, id: string, now: number): Promise<boolean>;
}
