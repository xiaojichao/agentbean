import type { SqliteDatabase } from './repositories.js';
import type {
  TaskLifecycleCommandName,
  TaskLifecycleReceiptOutcome,
} from '../../../../../packages/contracts/src/index.js';
import type {
  TaskLifecycleCommandReceiptRecord,
  TaskLifecycleCommandReceiptRepository,
  TaskLifecycleIdempotencyTombstoneRecord,
  TaskLifecycleRepositories,
} from '../../application/task-lifecycle-repositories.js';

interface ReceiptRow {
  receipt_id: string;
  team_id: string;
  command_name: TaskLifecycleCommandName;
  command_schema_version: number;
  idempotency_key: string;
  command_hash: string;
  outcome: TaskLifecycleReceiptOutcome;
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
  command_name: TaskLifecycleCommandName;
  idempotency_key: string;
  command_hash: string;
  receipt_id: string;
  outcome: TaskLifecycleReceiptOutcome;
  result_available: number;
  created_at: number;
}

function mapReceipt(row: ReceiptRow | undefined): TaskLifecycleCommandReceiptRecord | null {
  if (!row) return null;
  return {
    receiptId: row.receipt_id,
    teamId: row.team_id,
    commandName: row.command_name,
    commandSchemaVersion: row.command_schema_version,
    idempotencyKey: row.idempotency_key,
    commandHash: row.command_hash,
    outcome: row.outcome,
    committedRevisions: JSON.parse(row.committed_revisions_json),
    eventRefs: JSON.parse(row.event_refs_json),
    resultAvailable: row.result_available === 1,
    resultJson: row.result_json,
    commitTime: row.commit_time,
    createdAt: row.created_at,
  };
}

function mapTombstone(row: TombstoneRow | undefined): TaskLifecycleIdempotencyTombstoneRecord | null {
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

export function createSqliteTaskLifecycleCommandReceiptRepository(
  teamDb: SqliteDatabase,
): TaskLifecycleCommandReceiptRepository {
  const columns = 'receipt_id,team_id,command_name,command_schema_version,idempotency_key,command_hash,outcome,committed_revisions_json,event_refs_json,result_available,result_json,commit_time,created_at';
  return {
    async createReceipt(input) {
      teamDb.prepare(
        'INSERT INTO task_lifecycle_command_receipts(receipt_id,team_id,command_name,command_schema_version,idempotency_key,command_hash,outcome,committed_revisions_json,event_refs_json,result_available,result_json,commit_time,created_at)VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).run(
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
    async getReceiptByIdempotencyKey(key) {
      return mapReceipt(
        teamDb.prepare(`SELECT ${columns} FROM task_lifecycle_command_receipts WHERE idempotency_key=?`)
          .get(key) as ReceiptRow | undefined,
      );
    },
    async getReceiptById(id) {
      return mapReceipt(
        teamDb.prepare(`SELECT ${columns} FROM task_lifecycle_command_receipts WHERE receipt_id=?`)
          .get(id) as ReceiptRow | undefined,
      );
    },
    async deleteReceiptByIdempotencyKey(key) {
      const result = teamDb.prepare(
        'DELETE FROM task_lifecycle_command_receipts WHERE idempotency_key=?',
      ).run(key) as { changes?: number };
      return Number(result.changes ?? 0) > 0;
    },
    async createTombstone(input) {
      teamDb.prepare(
        'INSERT INTO task_lifecycle_idempotency_tombstones(id,team_id,command_name,idempotency_key,command_hash,receipt_id,outcome,result_available,created_at)VALUES(?,?,?,?,?,?,?,?,?)',
      ).run(
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
    async getTombstoneByIdempotencyKey(key) {
      return mapTombstone(
        teamDb.prepare(
          'SELECT id,team_id,command_name,idempotency_key,command_hash,receipt_id,outcome,result_available,created_at FROM task_lifecycle_idempotency_tombstones WHERE idempotency_key=?',
        ).get(key) as TombstoneRow | undefined,
      );
    },
  };
}

export function createSqliteTaskLifecycleRepositories(
  teamDb: SqliteDatabase,
): TaskLifecycleRepositories {
  return { receipts: createSqliteTaskLifecycleCommandReceiptRepository(teamDb) };
}
