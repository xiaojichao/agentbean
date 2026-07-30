import type { ID, UnixMs } from '../../../../packages/contracts/src/common.js';
import type {
  SystemActivityCommandName,
  SystemActivityFactKind,
  SystemActivityLevel,
  SystemActivitySurface,
  SystemAttentionState,
} from '../../../../packages/contracts/src/system-activity.js';

/**
 * #929 System activity / attention / change feed 仓储接口。
 */

export interface SystemActivityProjectionRecord {
  readonly projectionId: ID;
  readonly eventId: ID;
  readonly surface: SystemActivitySurface;
  readonly level: SystemActivityLevel;
  readonly factKind: SystemActivityFactKind;
  readonly teamId: ID;
  readonly taskId: ID;
  readonly rootTaskId: ID | null;
  readonly channelId: ID | null;
  readonly threadId: ID | null;
  readonly recipientId: ID;
  readonly sequence: number;
  readonly revision: number;
  readonly summary: string;
  readonly occurredAt: UnixMs;
  readonly actorKind: 'system';
  readonly attentionIdentity: ID | null;
  readonly attentionRevision: number | null;
  readonly taskRevision: number | null;
  readonly deliveryRevision: number | null;
  readonly allowedCommandsJson: string | null;
  readonly confirmationToken: string | null;
  readonly escalationRevision: number | null;
  readonly feedPosition: number;
  readonly createdAt: UnixMs;
}

export interface SystemAttentionRecord {
  readonly attentionIdentity: ID;
  readonly teamId: ID;
  readonly recipientId: ID;
  readonly taskId: ID;
  readonly rootTaskId: ID | null;
  readonly channelId: ID | null;
  readonly threadId: ID | null;
  readonly level: 'attention' | 'action_required';
  readonly state: SystemAttentionState;
  readonly revision: number;
  readonly sourceEventId: ID;
  readonly summary: string;
  readonly unread: boolean;
  readonly seenAt: UnixMs | null;
  readonly lastReminderAt: UnixMs | null;
  readonly createdAt: UnixMs;
  readonly updatedAt: UnixMs;
  readonly resolvedAt: UnixMs | null;
  readonly taskRevision: number | null;
  readonly deliveryRevision: number | null;
  readonly allowedCommandsJson: string | null;
  readonly confirmationToken: string | null;
  readonly escalationRevision: number | null;
}

export interface SystemActivityWatermarkRecord {
  readonly streamKind: string;
  readonly streamId: ID;
  readonly revision: number;
  readonly updatedAt: UnixMs;
}

export interface SystemActivityFeedCursorRecord {
  readonly recipientId: ID;
  readonly teamId: ID;
  readonly ackedPosition: number;
  readonly feedEpoch: number;
  readonly updatedAt: UnixMs;
}

export interface SystemActivityCommandReceiptRecord {
  readonly receiptId: ID;
  readonly commandName: SystemActivityCommandName;
  readonly commandSchemaVersion: number;
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly outcome: 'applied' | 'no_op';
  readonly committedRevisions: readonly { streamKind: string; streamId: ID; revision: number }[];
  readonly eventRefs: readonly { streamKind: string; streamId: ID; sequence: number }[];
  readonly commitTime: UnixMs;
  readonly resultAvailable: boolean;
  readonly resultJson: string | null;
}

export interface SystemActivityIdempotencyTombstoneRecord {
  readonly idempotencyKey: string;
  readonly commandHash: string;
  readonly receiptId: ID;
  readonly createdAt: UnixMs;
}

export interface SystemActivityNoticeRecord {
  readonly noticeId: ID;
  readonly teamId: ID;
  readonly recipientId: ID;
  readonly projectionIdsJson: string;
  readonly attentionIdentitiesJson: string;
  readonly cursor: string;
  readonly issuedAt: UnixMs;
  readonly deliveredAt: UnixMs | null;
}

export interface SystemActivityProjectionRepository {
  upsert(record: SystemActivityProjectionRecord): Promise<SystemActivityProjectionRecord>;
  getByEventAndRecipient(input: {
    eventId: ID;
    recipientId: ID;
    surface: SystemActivitySurface;
  }): Promise<SystemActivityProjectionRecord | null>;
  listTaskTimeline(input: {
    taskId: ID;
    recipientId: ID;
    afterPosition: number;
    limit: number;
  }): Promise<readonly SystemActivityProjectionRecord[]>;
  listThreadCard(input: {
    taskId: ID;
    channelId: ID;
    threadId: ID | null;
    recipientId: ID;
  }): Promise<readonly SystemActivityProjectionRecord[]>;
  listChangeFeed(input: {
    recipientId: ID;
    afterPosition: number;
    limit: number;
  }): Promise<readonly SystemActivityProjectionRecord[]>;
  listByTask(taskId: ID): Promise<readonly SystemActivityProjectionRecord[]>;
  deleteByIds(ids: readonly ID[]): Promise<number>;
  nextFeedPosition(): Promise<number>;
}

export interface SystemAttentionRepository {
  upsert(record: SystemAttentionRecord): Promise<SystemAttentionRecord>;
  getByIdentity(attentionIdentity: ID): Promise<SystemAttentionRecord | null>;
  listByRecipient(input: {
    recipientId: ID;
    onlyUnread?: boolean;
    afterUpdatedAt: number;
    limit: number;
  }): Promise<readonly SystemAttentionRecord[]>;
  listOpenByTask(taskId: ID): Promise<readonly SystemAttentionRecord[]>;
}

export interface SystemActivityWatermarkRepository {
  get(streamKind: string, streamId: ID): Promise<SystemActivityWatermarkRecord | null>;
  upsert(record: SystemActivityWatermarkRecord): Promise<SystemActivityWatermarkRecord>;
  listAll(): Promise<readonly SystemActivityWatermarkRecord[]>;
}

export interface SystemActivityFeedCursorRepository {
  get(recipientId: ID): Promise<SystemActivityFeedCursorRecord | null>;
  upsert(record: SystemActivityFeedCursorRecord): Promise<SystemActivityFeedCursorRecord>;
}

export interface SystemActivityReceiptRepository {
  create(record: SystemActivityCommandReceiptRecord): Promise<SystemActivityCommandReceiptRecord>;
  getByIdempotencyKey(idempotencyKey: string): Promise<SystemActivityCommandReceiptRecord | null>;
  createTombstone(record: SystemActivityIdempotencyTombstoneRecord): Promise<void>;
  getTombstone(idempotencyKey: string): Promise<SystemActivityIdempotencyTombstoneRecord | null>;
}

export interface SystemActivityNoticeRepository {
  enqueue(record: SystemActivityNoticeRecord): Promise<SystemActivityNoticeRecord>;
  listPending(limit: number): Promise<readonly SystemActivityNoticeRecord[]>;
  markDelivered(noticeId: ID, deliveredAt: UnixMs): Promise<void>;
}

export interface SystemActivityRepositories {
  readonly projections: SystemActivityProjectionRepository;
  readonly attentions: SystemAttentionRepository;
  readonly watermarks: SystemActivityWatermarkRepository;
  readonly feedCursors: SystemActivityFeedCursorRepository;
  readonly receipts: SystemActivityReceiptRepository;
  readonly notices: SystemActivityNoticeRepository;
}
