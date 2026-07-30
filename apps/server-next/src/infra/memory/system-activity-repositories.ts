import type {
  SystemActivityCommandReceiptRecord,
  SystemActivityFeedCursorRecord,
  SystemActivityIdempotencyTombstoneRecord,
  SystemActivityNoticeRecord,
  SystemActivityProjectionRecord,
  SystemActivityRepositories,
  SystemActivityWatermarkRecord,
  SystemAttentionRecord,
} from '../../application/system-activity-repositories.js';

export interface SystemActivityMemoryState {
  projections: Map<string, SystemActivityProjectionRecord>;
  attentions: Map<string, SystemAttentionRecord>;
  watermarks: Map<string, SystemActivityWatermarkRecord>;
  feedCursors: Map<string, SystemActivityFeedCursorRecord>;
  receipts: Map<string, SystemActivityCommandReceiptRecord>;
  tombstones: Map<string, SystemActivityIdempotencyTombstoneRecord>;
  notices: Map<string, SystemActivityNoticeRecord>;
  nextFeedPosition: number;
}

export function createSystemActivityMemoryState(): SystemActivityMemoryState {
  return {
    projections: new Map(),
    attentions: new Map(),
    watermarks: new Map(),
    feedCursors: new Map(),
    receipts: new Map(),
    tombstones: new Map(),
    notices: new Map(),
    nextFeedPosition: 1,
  };
}

export function cloneSystemActivityMemoryState(
  state: SystemActivityMemoryState,
): SystemActivityMemoryState {
  return {
    projections: new Map(state.projections),
    attentions: new Map(state.attentions),
    watermarks: new Map(state.watermarks),
    feedCursors: new Map(state.feedCursors),
    receipts: new Map(state.receipts),
    tombstones: new Map(state.tombstones),
    notices: new Map(state.notices),
    nextFeedPosition: state.nextFeedPosition,
  };
}

export function restoreSystemActivityMemoryState(
  target: SystemActivityMemoryState,
  source: SystemActivityMemoryState,
): void {
  target.projections = new Map(source.projections);
  target.attentions = new Map(source.attentions);
  target.watermarks = new Map(source.watermarks);
  target.feedCursors = new Map(source.feedCursors);
  target.receipts = new Map(source.receipts);
  target.tombstones = new Map(source.tombstones);
  target.notices = new Map(source.notices);
  target.nextFeedPosition = source.nextFeedPosition;
}

function watermarkKey(streamKind: string, streamId: string): string {
  return `${streamKind}|${streamId}`;
}

function projectionDedupeKey(eventId: string, recipientId: string, surface: string): string {
  return `${eventId}|${recipientId}|${surface}`;
}

export function createInMemorySystemActivityRepositories(
  state: SystemActivityMemoryState = createSystemActivityMemoryState(),
): SystemActivityRepositories {
  return {
    projections: {
      async upsert(record) {
        state.projections.set(record.projectionId, record);
        return record;
      },
      async getByEventAndRecipient({ eventId, recipientId, surface }) {
        const key = projectionDedupeKey(eventId, recipientId, surface);
        for (const row of state.projections.values()) {
          if (projectionDedupeKey(row.eventId, row.recipientId, row.surface) === key) {
            return row;
          }
        }
        return null;
      },
      async listTaskTimeline({ taskId, recipientId, afterPosition, limit }) {
        return [...state.projections.values()]
          .filter((row) =>
            row.taskId === taskId
            && row.recipientId === recipientId
            && row.surface === 'task_timeline'
            && row.feedPosition > afterPosition)
          .sort((a, b) => a.feedPosition - b.feedPosition || a.sequence - b.sequence)
          .slice(0, limit);
      },
      async listThreadCard({ taskId, channelId, threadId, recipientId }) {
        return [...state.projections.values()]
          .filter((row) =>
            row.taskId === taskId
            && row.recipientId === recipientId
            && row.surface === 'thread_card'
            && row.channelId === channelId
            && (threadId === null || row.threadId === threadId))
          .sort((a, b) => a.sequence - b.sequence || a.occurredAt - b.occurredAt);
      },
      async listChangeFeed({ recipientId, afterPosition, limit }) {
        return [...state.projections.values()]
          .filter((row) => row.recipientId === recipientId && row.feedPosition > afterPosition)
          .sort((a, b) => a.feedPosition - b.feedPosition)
          .slice(0, limit);
      },
      async listByTask(taskId) {
        return [...state.projections.values()].filter((row) => row.taskId === taskId);
      },
      async deleteByIds(ids) {
        let n = 0;
        for (const id of ids) {
          if (state.projections.delete(id)) n += 1;
        }
        return n;
      },
      async nextFeedPosition() {
        const pos = state.nextFeedPosition;
        state.nextFeedPosition += 1;
        return pos;
      },
    },
    attentions: {
      async upsert(record) {
        state.attentions.set(record.attentionIdentity, record);
        return record;
      },
      async getByIdentity(attentionIdentity) {
        return state.attentions.get(attentionIdentity) ?? null;
      },
      async listByRecipient({ recipientId, onlyUnread, afterUpdatedAt, limit }) {
        return [...state.attentions.values()]
          .filter((row) =>
            row.recipientId === recipientId
            && row.updatedAt > afterUpdatedAt
            && (!onlyUnread || row.unread)
            && row.state === 'open')
          .sort((a, b) => a.updatedAt - b.updatedAt)
          .slice(0, limit);
      },
      async listOpenByTask(taskId) {
        return [...state.attentions.values()]
          .filter((row) => row.taskId === taskId && row.state === 'open');
      },
    },
    watermarks: {
      async get(streamKind, streamId) {
        return state.watermarks.get(watermarkKey(streamKind, streamId)) ?? null;
      },
      async upsert(record) {
        state.watermarks.set(watermarkKey(record.streamKind, record.streamId), record);
        return record;
      },
      async listAll() {
        return [...state.watermarks.values()];
      },
    },
    feedCursors: {
      async get(recipientId) {
        return state.feedCursors.get(recipientId) ?? null;
      },
      async upsert(record) {
        state.feedCursors.set(record.recipientId, record);
        return record;
      },
    },
    receipts: {
      async create(record) {
        state.receipts.set(record.idempotencyKey, record);
        return record;
      },
      async getByIdempotencyKey(idempotencyKey) {
        return state.receipts.get(idempotencyKey) ?? null;
      },
      async createTombstone(record) {
        state.tombstones.set(record.idempotencyKey, record);
      },
      async getTombstone(idempotencyKey) {
        return state.tombstones.get(idempotencyKey) ?? null;
      },
    },
    notices: {
      async enqueue(record) {
        state.notices.set(record.noticeId, record);
        return record;
      },
      async listPending(limit) {
        return [...state.notices.values()]
          .filter((row) => row.deliveredAt === null)
          .sort((a, b) => a.issuedAt - b.issuedAt)
          .slice(0, limit);
      },
      async markDelivered(noticeId, deliveredAt) {
        const row = state.notices.get(noticeId);
        if (!row) return;
        state.notices.set(noticeId, { ...row, deliveredAt });
      },
    },
  };
}
