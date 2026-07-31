/**
 * #999 System activity / attention / change feed 的 SQLite 持久化。
 * 对齐 memory 接口与 migration team/0072_system_activity.sql。
 */
import type { ID, UnixMs } from '../../../../../packages/contracts/src/common.js';
import type {
  SystemActivityCommandName,
  SystemActivityFactKind,
  SystemActivityLevel,
  SystemActivitySurface,
  SystemAttentionState,
} from '../../../../../packages/contracts/src/system-activity.js';
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
import type { SystemActivityUnitOfWork } from '../../application/system-activity-unit-of-work.js';
import type { SqliteDatabase } from './repositories.js';

interface ProjectionRow {
  projection_id: string;
  event_id: string;
  surface: SystemActivitySurface;
  level: SystemActivityLevel;
  fact_kind: SystemActivityFactKind;
  team_id: string;
  task_id: string;
  root_task_id: string | null;
  channel_id: string | null;
  thread_id: string | null;
  recipient_id: string;
  sequence: number;
  revision: number;
  summary: string;
  occurred_at: number;
  actor_kind: 'system';
  attention_identity: string | null;
  attention_revision: number | null;
  task_revision: number | null;
  delivery_revision: number | null;
  allowed_commands_json: string | null;
  confirmation_token: string | null;
  escalation_revision: number | null;
  feed_position: number;
  created_at: number;
}

interface AttentionRow {
  attention_identity: string;
  team_id: string;
  recipient_id: string;
  task_id: string;
  root_task_id: string | null;
  channel_id: string | null;
  thread_id: string | null;
  level: 'attention' | 'action_required';
  state: SystemAttentionState;
  revision: number;
  source_event_id: string;
  summary: string;
  unread: number;
  seen_at: number | null;
  last_reminder_at: number | null;
  created_at: number;
  updated_at: number;
  resolved_at: number | null;
  task_revision: number | null;
  delivery_revision: number | null;
  allowed_commands_json: string | null;
  confirmation_token: string | null;
  escalation_revision: number | null;
}

interface WatermarkRow {
  stream_kind: string;
  stream_id: string;
  revision: number;
  updated_at: number;
}

interface FeedCursorRow {
  recipient_id: string;
  team_id: string;
  acked_position: number;
  feed_epoch: number;
  updated_at: number;
}

interface ReceiptRow {
  receipt_id: string;
  team_id: string;
  command_name: SystemActivityCommandName;
  command_schema_version: number;
  idempotency_key: string;
  command_hash: string;
  outcome: 'applied' | 'no_op';
  committed_revisions_json: string;
  event_refs_json: string;
  result_available: number;
  result_json: string | null;
  commit_time: number;
  created_at: number;
}

interface TombstoneRow {
  id: string;
  team_id: string;
  command_name: string;
  idempotency_key: string;
  command_hash: string;
  receipt_id: string;
  created_at: number;
}

interface NoticeRow {
  notice_id: string;
  team_id: string;
  recipient_id: string;
  projection_ids_json: string;
  attention_identities_json: string;
  cursor: string;
  issued_at: number;
  delivered_at: number | null;
}

const PROJECTION_COLS = `projection_id, event_id, surface, level, fact_kind, team_id, task_id,
  root_task_id, channel_id, thread_id, recipient_id, sequence, revision, summary, occurred_at,
  actor_kind, attention_identity, attention_revision, task_revision, delivery_revision,
  allowed_commands_json, confirmation_token, escalation_revision, feed_position, created_at`;

function mapProjection(row: ProjectionRow | undefined): SystemActivityProjectionRecord | null {
  if (!row) return null;
  return {
    projectionId: row.projection_id,
    eventId: row.event_id,
    surface: row.surface,
    level: row.level,
    factKind: row.fact_kind,
    teamId: row.team_id,
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    recipientId: row.recipient_id,
    sequence: row.sequence,
    revision: row.revision,
    summary: row.summary,
    occurredAt: row.occurred_at,
    actorKind: 'system',
    attentionIdentity: row.attention_identity,
    attentionRevision: row.attention_revision,
    taskRevision: row.task_revision,
    deliveryRevision: row.delivery_revision,
    allowedCommandsJson: row.allowed_commands_json,
    confirmationToken: row.confirmation_token,
    escalationRevision: row.escalation_revision,
    feedPosition: row.feed_position,
    createdAt: row.created_at,
  };
}

function mapAttention(row: AttentionRow | undefined): SystemAttentionRecord | null {
  if (!row) return null;
  return {
    attentionIdentity: row.attention_identity,
    teamId: row.team_id,
    recipientId: row.recipient_id,
    taskId: row.task_id,
    rootTaskId: row.root_task_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    level: row.level,
    state: row.state,
    revision: row.revision,
    sourceEventId: row.source_event_id,
    summary: row.summary,
    unread: row.unread === 1,
    seenAt: row.seen_at,
    lastReminderAt: row.last_reminder_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    resolvedAt: row.resolved_at,
    taskRevision: row.task_revision,
    deliveryRevision: row.delivery_revision,
    allowedCommandsJson: row.allowed_commands_json,
    confirmationToken: row.confirmation_token,
    escalationRevision: row.escalation_revision,
  };
}

function mapReceipt(row: ReceiptRow | undefined): SystemActivityCommandReceiptRecord | null {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    teamId: row.team_id,
    commandName: row.command_name,
    commandSchemaVersion: row.command_schema_version,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    outcome: row.outcome,
    committedRevisions: JSON.parse(row.committed_revisions_json) as SystemActivityCommandReceiptRecord['committedRevisions'],
    eventRefs: JSON.parse(row.event_refs_json) as SystemActivityCommandReceiptRecord['eventRefs'],
    commitTime: row.commit_time,
    resultAvailable: row.result_available === 1,
    resultJson: row.result_json,
  };
}

export function createSqliteSystemActivityRepositories(
  teamDb: SqliteDatabase,
): SystemActivityRepositories {
  return {
    projections: {
      async upsert(record) {
        teamDb.prepare(`
          INSERT INTO system_activity_projections (
            projection_id, event_id, surface, level, fact_kind, team_id, task_id,
            root_task_id, channel_id, thread_id, recipient_id, sequence, revision, summary,
            occurred_at, actor_kind, attention_identity, attention_revision, task_revision,
            delivery_revision, allowed_commands_json, confirmation_token, escalation_revision,
            feed_position, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(projection_id) DO UPDATE SET
            summary=excluded.summary,
            level=excluded.level,
            attention_revision=excluded.attention_revision,
            allowed_commands_json=excluded.allowed_commands_json,
            confirmation_token=excluded.confirmation_token,
            escalation_revision=excluded.escalation_revision
        `).run(
          record.projectionId, record.eventId, record.surface, record.level, record.factKind,
          record.teamId, record.taskId, record.rootTaskId, record.channelId, record.threadId,
          record.recipientId, record.sequence, record.revision, record.summary, record.occurredAt,
          record.actorKind, record.attentionIdentity, record.attentionRevision, record.taskRevision,
          record.deliveryRevision, record.allowedCommandsJson, record.confirmationToken,
          record.escalationRevision, record.feedPosition, record.createdAt,
        );
        return record;
      },
      async getByEventAndRecipient({ eventId, recipientId, surface }) {
        return mapProjection(teamDb.prepare(`
          SELECT ${PROJECTION_COLS} FROM system_activity_projections
          WHERE event_id = ? AND recipient_id = ? AND surface = ?
        `).get(eventId, recipientId, surface) as ProjectionRow | undefined);
      },
      async listTaskTimeline({ taskId, recipientId, afterPosition, limit }) {
        const rows = teamDb.prepare(`
          SELECT ${PROJECTION_COLS} FROM system_activity_projections
          WHERE task_id = ? AND recipient_id = ? AND surface = 'task_timeline' AND feed_position > ?
          ORDER BY feed_position ASC, sequence ASC
          LIMIT ?
        `).all(taskId, recipientId, afterPosition, limit) as ProjectionRow[];
        return rows.map((row) => mapProjection(row)!);
      },
      async listThreadCard({ taskId, channelId, threadId, recipientId }) {
        const rows = threadId === null
          ? teamDb.prepare(`
              SELECT ${PROJECTION_COLS} FROM system_activity_projections
              WHERE task_id = ? AND recipient_id = ? AND surface = 'thread_card' AND channel_id = ?
              ORDER BY sequence ASC, occurred_at ASC
            `).all(taskId, recipientId, channelId) as ProjectionRow[]
          : teamDb.prepare(`
              SELECT ${PROJECTION_COLS} FROM system_activity_projections
              WHERE task_id = ? AND recipient_id = ? AND surface = 'thread_card'
                AND channel_id = ? AND thread_id = ?
              ORDER BY sequence ASC, occurred_at ASC
            `).all(taskId, recipientId, channelId, threadId) as ProjectionRow[];
        return rows.map((row) => mapProjection(row)!);
      },
      async listChangeFeed({ recipientId, afterPosition, limit }) {
        const rows = teamDb.prepare(`
          SELECT ${PROJECTION_COLS} FROM system_activity_projections
          WHERE recipient_id = ? AND feed_position > ?
          ORDER BY feed_position ASC
          LIMIT ?
        `).all(recipientId, afterPosition, limit) as ProjectionRow[];
        return rows.map((row) => mapProjection(row)!);
      },
      async listByTask(taskId) {
        const rows = teamDb.prepare(`
          SELECT ${PROJECTION_COLS} FROM system_activity_projections WHERE task_id = ?
        `).all(taskId) as ProjectionRow[];
        return rows.map((row) => mapProjection(row)!);
      },
      async deleteByIds(ids) {
        if (ids.length === 0) return 0;
        const del = teamDb.prepare('DELETE FROM system_activity_projections WHERE projection_id = ?');
        let n = 0;
        for (const id of ids) {
          const result = del.run(id) as { changes: number };
          n += result.changes;
        }
        return n;
      },
      async nextFeedPosition() {
        const row = teamDb.prepare(`
          SELECT COALESCE(MAX(feed_position), 0) + 1 AS next_pos FROM system_activity_projections
        `).get() as { next_pos: number };
        return row.next_pos;
      },
    },
    attentions: {
      async upsert(record) {
        teamDb.prepare(`
          INSERT INTO system_attention_items (
            attention_identity, team_id, recipient_id, task_id, root_task_id, channel_id, thread_id,
            level, state, revision, source_event_id, summary, unread, seen_at, last_reminder_at,
            created_at, updated_at, resolved_at, task_revision, delivery_revision,
            allowed_commands_json, confirmation_token, escalation_revision
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
          ON CONFLICT(attention_identity) DO UPDATE SET
            level=excluded.level,
            state=excluded.state,
            revision=excluded.revision,
            source_event_id=excluded.source_event_id,
            summary=excluded.summary,
            unread=excluded.unread,
            seen_at=excluded.seen_at,
            last_reminder_at=excluded.last_reminder_at,
            updated_at=excluded.updated_at,
            resolved_at=excluded.resolved_at,
            task_revision=excluded.task_revision,
            delivery_revision=excluded.delivery_revision,
            allowed_commands_json=excluded.allowed_commands_json,
            confirmation_token=excluded.confirmation_token,
            escalation_revision=excluded.escalation_revision
        `).run(
          record.attentionIdentity, record.teamId, record.recipientId, record.taskId,
          record.rootTaskId, record.channelId, record.threadId, record.level, record.state,
          record.revision, record.sourceEventId, record.summary, record.unread ? 1 : 0,
          record.seenAt, record.lastReminderAt, record.createdAt, record.updatedAt,
          record.resolvedAt, record.taskRevision, record.deliveryRevision,
          record.allowedCommandsJson, record.confirmationToken, record.escalationRevision,
        );
        return record;
      },
      async getByIdentity(attentionIdentity) {
        return mapAttention(teamDb.prepare(`
          SELECT * FROM system_attention_items WHERE attention_identity = ?
        `).get(attentionIdentity) as AttentionRow | undefined);
      },
      async listByRecipient({ recipientId, onlyUnread, afterUpdatedAt, limit }) {
        const rows = onlyUnread
          ? teamDb.prepare(`
              SELECT * FROM system_attention_items
              WHERE recipient_id = ? AND state = 'open' AND unread = 1 AND updated_at > ?
              ORDER BY updated_at ASC
              LIMIT ?
            `).all(recipientId, afterUpdatedAt, limit) as AttentionRow[]
          : teamDb.prepare(`
              SELECT * FROM system_attention_items
              WHERE recipient_id = ? AND state = 'open' AND updated_at > ?
              ORDER BY updated_at ASC
              LIMIT ?
            `).all(recipientId, afterUpdatedAt, limit) as AttentionRow[];
        return rows.map((row) => mapAttention(row)!);
      },
      async listOpenByTask(taskId) {
        const rows = teamDb.prepare(`
          SELECT * FROM system_attention_items WHERE task_id = ? AND state = 'open'
        `).all(taskId) as AttentionRow[];
        return rows.map((row) => mapAttention(row)!);
      },
    },
    watermarks: {
      async get(streamKind, streamId) {
        const row = teamDb.prepare(`
          SELECT stream_kind, stream_id, revision, updated_at FROM system_activity_watermarks
          WHERE stream_kind = ? AND stream_id = ?
        `).get(streamKind, streamId) as WatermarkRow | undefined;
        if (!row) return null;
        return {
          streamKind: row.stream_kind,
          streamId: row.stream_id,
          revision: row.revision,
          updatedAt: row.updated_at,
        };
      },
      async upsert(record) {
        teamDb.prepare(`
          INSERT INTO system_activity_watermarks (stream_kind, stream_id, revision, updated_at)
          VALUES (?, ?, ?, ?)
          ON CONFLICT(stream_kind, stream_id) DO UPDATE SET
            revision=excluded.revision,
            updated_at=excluded.updated_at
        `).run(record.streamKind, record.streamId, record.revision, record.updatedAt);
        return record;
      },
      async listAll() {
        const rows = teamDb.prepare(`
          SELECT stream_kind, stream_id, revision, updated_at FROM system_activity_watermarks
        `).all() as WatermarkRow[];
        return rows.map((row) => ({
          streamKind: row.stream_kind,
          streamId: row.stream_id,
          revision: row.revision,
          updatedAt: row.updated_at,
        }));
      },
    },
    feedCursors: {
      async get(recipientId) {
        const row = teamDb.prepare(`
          SELECT recipient_id, team_id, acked_position, feed_epoch, updated_at
          FROM system_activity_feed_cursors WHERE recipient_id = ?
        `).get(recipientId) as FeedCursorRow | undefined;
        if (!row) return null;
        return {
          recipientId: row.recipient_id,
          teamId: row.team_id,
          ackedPosition: row.acked_position,
          feedEpoch: row.feed_epoch,
          updatedAt: row.updated_at,
        };
      },
      async upsert(record) {
        teamDb.prepare(`
          INSERT INTO system_activity_feed_cursors
            (recipient_id, team_id, acked_position, feed_epoch, updated_at)
          VALUES (?, ?, ?, ?, ?)
          ON CONFLICT(recipient_id) DO UPDATE SET
            team_id=excluded.team_id,
            acked_position=excluded.acked_position,
            feed_epoch=excluded.feed_epoch,
            updated_at=excluded.updated_at
        `).run(
          record.recipientId, record.teamId, record.ackedPosition, record.feedEpoch, record.updatedAt,
        );
        return record;
      },
    },
    receipts: {
      async create(record) {
        const teamId = record.teamId ?? '';
        teamDb.prepare(`
          INSERT INTO system_activity_command_receipts (
            receipt_id, team_id, command_name, command_schema_version, idempotency_key, command_hash,
            outcome, committed_revisions_json, event_refs_json, result_available, result_json,
            commit_time, created_at
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)
        `).run(
          record.receiptId, teamId, record.commandName, record.commandSchemaVersion,
          record.idempotencyKey, record.commandHash, record.outcome,
          JSON.stringify(record.committedRevisions), JSON.stringify(record.eventRefs),
          record.resultAvailable ? 1 : 0, record.resultJson, record.commitTime, record.commitTime,
        );
        return record;
      },
      async getByIdempotencyKey(idempotencyKey) {
        return mapReceipt(teamDb.prepare(`
          SELECT * FROM system_activity_command_receipts WHERE idempotency_key = ?
        `).get(idempotencyKey) as ReceiptRow | undefined);
      },
      async createTombstone(record) {
        const teamId = record.teamId ?? '';
        const id = record.id ?? `tombstone:${record.idempotencyKey}`;
        teamDb.prepare(`
          INSERT INTO system_activity_idempotency_tombstones
            (id, team_id, command_name, idempotency_key, command_hash, receipt_id, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?)
          ON CONFLICT(idempotency_key) DO NOTHING
        `).run(
          id, teamId, record.commandName ?? 'project-source-fact',
          record.idempotencyKey, record.commandHash, record.receiptId, record.createdAt,
        );
      },
      async getTombstone(idempotencyKey) {
        const row = teamDb.prepare(`
          SELECT * FROM system_activity_idempotency_tombstones WHERE idempotency_key = ?
        `).get(idempotencyKey) as TombstoneRow | undefined;
        if (!row) return null;
        return {
          id: row.id,
          teamId: row.team_id,
          commandName: row.command_name,
          idempotencyKey: row.idempotency_key,
          commandHash: row.command_hash,
          receiptId: row.receipt_id,
          createdAt: row.created_at,
        };
      },
    },
    notices: {
      async enqueue(record) {
        teamDb.prepare(`
          INSERT INTO system_activity_notices (
            notice_id, team_id, recipient_id, projection_ids_json, attention_identities_json,
            cursor, issued_at, delivered_at
          ) VALUES (?,?,?,?,?,?,?,?)
        `).run(
          record.noticeId, record.teamId, record.recipientId, record.projectionIdsJson,
          record.attentionIdentitiesJson, record.cursor, record.issuedAt, record.deliveredAt,
        );
        return record;
      },
      async listPending(limit) {
        const rows = teamDb.prepare(`
          SELECT * FROM system_activity_notices
          WHERE delivered_at IS NULL
          ORDER BY issued_at ASC
          LIMIT ?
        `).all(limit) as NoticeRow[];
        return rows.map((row) => ({
          noticeId: row.notice_id,
          teamId: row.team_id,
          recipientId: row.recipient_id,
          projectionIdsJson: row.projection_ids_json,
          attentionIdentitiesJson: row.attention_identities_json,
          cursor: row.cursor,
          issuedAt: row.issued_at,
          deliveredAt: row.delivered_at,
        }));
      },
      async markDelivered(noticeId, deliveredAt) {
        teamDb.prepare(`
          UPDATE system_activity_notices SET delivered_at = ? WHERE notice_id = ?
        `).run(deliveredAt, noticeId);
      },
    },
  };
}

/** SQLite 事务 UoW：BEGIN IMMEDIATE → work → COMMIT/ROLLBACK（与 management 一致）。 */
export function createSqliteSystemActivityUnitOfWork(
  teamDb: SqliteDatabase,
  repos: SystemActivityRepositories,
): SystemActivityUnitOfWork {
  return {
    async runInTransaction(work) {
      teamDb.exec('BEGIN IMMEDIATE;');
      try {
        const result = await work(repos);
        teamDb.exec('COMMIT;');
        return result;
      } catch (error) {
        try {
          teamDb.exec('ROLLBACK;');
        } catch {
          /* preserve original */
        }
        throw error;
      }
    },
  };
}

export type { ID, UnixMs };
