import type {
  MessageTargetKind,
  MessageSenderKind,
  MessageTracerCommandName,
  MessageTracerReceiptOutcome,
  MessageTracerRevisionRefV1,
  MessageTracerEventRefV1,
} from '../../../../../packages/contracts/src/index.js';
import type { SqliteDatabase } from './repositories.js';
import type {
  CommandReceiptRecord,
  CommandReceiptRepository,
  IdempotencyTombstoneRecord,
  InboxItemRecord,
  InboxReadBoundaryRecord,
  InboxTargetKey,
  MessageInboxRepository,
  MessageTracerRepositories,
} from '../../application/message-tracer-repositories.js';

// #921 切片 B：Message tracer 的 SQLite 持久化实现。
// inbox 投影 / Read boundary 用生成列 thread_key=COALESCE(thread_id,'') 做 recipient × target 定位，
// 使 mainline（thread_id IS NULL）与 thread 在同一 channel 内独立成序（见 migration team/0056）。

interface InboxItemRow {
  id: string;
  team_id: string;
  message_id: string;
  recipient_id: string;
  channel_id: string;
  thread_id: string | null;
  target_kind: MessageTargetKind;
  target_seq: number;
  sender_kind: MessageSenderKind;
  sender_id: string;
  committed_at: number;
  created_at: number;
}

interface ReadBoundaryRow {
  id: string;
  team_id: string;
  recipient_id: string;
  channel_id: string;
  thread_id: string | null;
  target_kind: MessageTargetKind;
  read_seq: number;
  advanced_at: number;
  created_at: number;
}

interface ReceiptRow {
  receipt_id: string;
  team_id: string;
  command_name: MessageTracerCommandName;
  command_schema_version: number;
  idempotency_key: string;
  command_hash: string;
  outcome: MessageTracerReceiptOutcome;
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
  command_name: MessageTracerCommandName;
  idempotency_key: string;
  command_hash: string;
  receipt_id: string;
  outcome: MessageTracerReceiptOutcome;
  result_available: number;
  created_at: number;
}

function mapInboxItem(row: InboxItemRow | undefined): InboxItemRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    messageId: row.message_id,
    recipientId: row.recipient_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    targetKind: row.target_kind,
    targetSeq: row.target_seq,
    senderKind: row.sender_kind,
    senderId: row.sender_id,
    committedAt: row.committed_at,
    createdAt: row.created_at,
  };
}

function mapReadBoundary(row: ReadBoundaryRow | undefined): InboxReadBoundaryRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    recipientId: row.recipient_id,
    channelId: row.channel_id,
    threadId: row.thread_id,
    targetKind: row.target_kind,
    readSeq: row.read_seq,
    advancedAt: row.advanced_at,
    createdAt: row.created_at,
  };
}

function mapReceipt(row: ReceiptRow | undefined): CommandReceiptRecord | null {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    teamId: row.team_id,
    commandName: row.command_name,
    commandSchemaVersion: row.command_schema_version,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    outcome: row.outcome,
    committedRevisions: JSON.parse(row.committed_revisions_json) as MessageTracerRevisionRefV1[],
    eventRefs: JSON.parse(row.event_refs_json) as MessageTracerEventRefV1[],
    resultAvailable: row.result_available === 1,
    resultJson: row.result_json,
    commitTime: row.commit_time,
    createdAt: row.created_at,
  };
}

function mapTombstone(row: TombstoneRow | undefined): IdempotencyTombstoneRecord | null {
  if (!row) return null;
  return {
    id: row.id,
    teamId: row.team_id,
    commandName: row.command_name,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    receiptId: row.receipt_id,
    outcome: row.outcome,
    resultAvailable: row.result_available === 1,
    createdAt: row.created_at,
  };
}

function targetKeyClause(key: InboxTargetKey): { sql: string; params: unknown[] } {
  // thread_key = COALESCE(thread_id, '')：mainline('') 与 thread 在同 channel 内独立定位。
  return {
    sql: 'recipient_id = ? AND channel_id = ? AND thread_key = ?',
    params: [key.recipientId, key.channelId, key.threadId ?? ''],
  };
}

export function createSqliteMessageInboxRepository(teamDb: SqliteDatabase): MessageInboxRepository {
  return {
    async insertItem(input) {
      teamDb.prepare(`INSERT INTO inbox_items (
          id, team_id, message_id, recipient_id, channel_id, thread_id, target_kind, target_seq,
          sender_kind, sender_id, committed_at, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.messageId,
          input.recipientId,
          input.channelId,
          input.threadId,
          input.targetKind,
          input.targetSeq,
          input.senderKind,
          input.senderId,
          input.committedAt,
          input.createdAt,
        );
      return input;
    },

    async listItems(input) {
      const where = targetKeyClause(input);
      const rows = teamDb.prepare(
        `SELECT id, team_id, message_id, recipient_id, channel_id, thread_id, target_kind, target_seq,
           sender_kind, sender_id, committed_at, created_at
         FROM inbox_items
         WHERE ${where.sql} AND target_seq > ?
         ORDER BY target_seq ASC
         LIMIT ?`,
      ).all(...where.params, input.afterSeq, input.limit) as InboxItemRow[];
      return rows
        .map(mapInboxItem)
        .filter((item): item is InboxItemRecord => item !== null);
    },

    async getMaxTargetSeq(input) {
      const where = targetKeyClause(input);
      const row = teamDb.prepare(
        `SELECT COALESCE(MAX(target_seq), -1) AS max_seq FROM inbox_items WHERE ${where.sql}`,
      ).get(...where.params) as { max_seq: number } | undefined;
      return row?.max_seq ?? -1;
    },

    async getReadBoundary(input) {
      const where = targetKeyClause(input);
      const row = teamDb.prepare(
        `SELECT id, team_id, recipient_id, channel_id, thread_id, target_kind, read_seq, advanced_at, created_at
         FROM inbox_read_boundaries WHERE ${where.sql}`,
      ).get(...where.params) as ReadBoundaryRow | undefined;
      return mapReadBoundary(row);
    },

    async advanceReadBoundary(input) {
      const existing = await this.getReadBoundary({
        recipientId: input.recipientId,
        channelId: input.channelId,
        threadId: input.threadId,
      });
      if (!existing) {
        teamDb.prepare(`INSERT INTO inbox_read_boundaries (
            id, team_id, recipient_id, channel_id, thread_id, target_kind, read_seq, advanced_at, created_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
          .run(
            input.id,
            input.teamId,
            input.recipientId,
            input.channelId,
            input.threadId,
            input.targetKind,
            input.newSeq,
            input.now,
            input.now,
          );
        return {
          id: input.id,
          teamId: input.teamId,
          recipientId: input.recipientId,
          channelId: input.channelId,
          threadId: input.threadId,
          targetKind: input.targetKind,
          readSeq: input.newSeq,
          advancedAt: input.now,
          createdAt: input.now,
        };
      }
      // 单调推进：仅当 newSeq 严格大于当前 readSeq 才更新（ack 幂等，不可回退，#900 §13）。
      if (input.newSeq > existing.readSeq) {
        teamDb.prepare(
          `UPDATE inbox_read_boundaries SET read_seq = ?, advanced_at = ? WHERE id = ? AND read_seq < ?`,
        ).run(input.newSeq, input.now, existing.id, input.newSeq);
        return { ...existing, readSeq: input.newSeq, advancedAt: input.now };
      }
      return existing;
    },
  };
}

export function createSqliteCommandReceiptRepository(teamDb: SqliteDatabase): CommandReceiptRepository {
  // 复用同一列清单，避免两处 SELECT 漂移（加列时只改一处）。
  const RECEIPT_COLUMNS = `receipt_id, team_id, command_name, command_schema_version, idempotency_key, command_hash, outcome,
           committed_revisions_json, event_refs_json, result_available, result_json, commit_time, created_at`;
  return {
    async createReceipt(input) {
      teamDb.prepare(`INSERT INTO command_receipts (
          receipt_id, team_id, command_name, command_schema_version, idempotency_key, command_hash, outcome,
          committed_revisions_json, event_refs_json, result_available, result_json, commit_time, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.receiptId,
          input.teamId,
          input.commandName,
          input.commandSchemaVersion,
          input.idempotencyKey,
          input.commandHash,
          input.outcome,
          JSON.stringify(input.committedRevisions),
          JSON.stringify(input.eventRefs),
          input.resultAvailable ? 1 : 0,
          input.resultJson,
          input.commitTime,
          input.createdAt,
        );
      return input;
    },

    async getReceiptByIdempotencyKey(idempotencyKey) {
      const row = teamDb.prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM command_receipts WHERE idempotency_key = ?`,
      ).get(idempotencyKey) as ReceiptRow | undefined;
      return mapReceipt(row);
    },

    async getReceiptById(receiptId) {
      const row = teamDb.prepare(
        `SELECT ${RECEIPT_COLUMNS} FROM command_receipts WHERE receipt_id = ?`,
      ).get(receiptId) as ReceiptRow | undefined;
      return mapReceipt(row);
    },

    async createTombstone(input) {
      teamDb.prepare(`INSERT INTO idempotency_tombstones (
          id, team_id, command_name, idempotency_key, command_hash, receipt_id, outcome, result_available, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
        .run(
          input.id,
          input.teamId,
          input.commandName,
          input.idempotencyKey,
          input.commandHash,
          input.receiptId,
          input.outcome,
          input.resultAvailable ? 1 : 0,
          input.createdAt,
        );
      return input;
    },

    async getTombstoneByIdempotencyKey(idempotencyKey) {
      const row = teamDb.prepare(
        `SELECT id, team_id, command_name, idempotency_key, command_hash, receipt_id, outcome, result_available, created_at
         FROM idempotency_tombstones WHERE idempotency_key = ?`,
      ).get(idempotencyKey) as TombstoneRow | undefined;
      return mapTombstone(row);
    },
  };
}

export function createSqliteMessageTracerRepositories(teamDb: SqliteDatabase): MessageTracerRepositories {
  return {
    inbox: createSqliteMessageInboxRepository(teamDb),
    commandReceipts: createSqliteCommandReceiptRepository(teamDb),
  };
}
