import type {
  TaskLifecycleCommandReceiptRecord,
  TaskLifecycleCommandReceiptRepository,
  TaskLifecycleIdempotencyTombstoneRecord,
  TaskLifecycleRepositories,
} from '../../application/task-lifecycle-repositories.js';

export function createMemoryTaskLifecycleRepositories(): TaskLifecycleRepositories {
  const receipts = new Map<string, TaskLifecycleCommandReceiptRecord>();
  const byReceiptId = new Map<string, TaskLifecycleCommandReceiptRecord>();
  const tombstones = new Map<string, TaskLifecycleIdempotencyTombstoneRecord>();

  const repo: TaskLifecycleCommandReceiptRepository = {
    async createReceipt(input) {
      if (receipts.has(input.idempotencyKey)) {
        throw Object.assign(new Error('UNIQUE'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
      receipts.set(input.idempotencyKey, input);
      byReceiptId.set(input.receiptId, input);
      return input;
    },
    async getReceiptByIdempotencyKey(key) {
      return receipts.get(key) ?? null;
    },
    async getReceiptById(id) {
      return byReceiptId.get(id) ?? null;
    },
    async deleteReceiptByIdempotencyKey(key) {
      const existing = receipts.get(key);
      if (!existing) return false;
      receipts.delete(key);
      byReceiptId.delete(existing.receiptId);
      return true;
    },
    async createTombstone(input) {
      if (tombstones.has(input.idempotencyKey)) {
        throw Object.assign(new Error('UNIQUE'), { code: 'SQLITE_CONSTRAINT_UNIQUE' });
      }
      tombstones.set(input.idempotencyKey, input);
      return input;
    },
    async getTombstoneByIdempotencyKey(key) {
      return tombstones.get(key) ?? null;
    },
  };
  return { receipts: repo };
}
