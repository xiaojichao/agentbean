import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { Phase1ManagementWorkerToolName } from '../../../packages/contracts/src/index.js';
import { managementOutboxFile } from './profile-paths.js';

export interface ManagementDurableOutboxItem {
  readonly schemaVersion: 1;
  readonly managementRunId: string;
  readonly commandId: string;
  readonly idempotencyKey: string;
  readonly requestHash: string;
  readonly toolName: Phase1ManagementWorkerToolName;
  readonly createdAt: number;
}

interface ManagementOutboxSnapshotV1 {
  readonly schemaVersion: 1;
  readonly items: readonly ManagementDurableOutboxItem[];
}

export interface ManagementOutboxStorage {
  load(): Promise<unknown>;
  save(snapshot: ManagementOutboxSnapshotV1): Promise<void>;
}

export interface ManagementDurableOutbox {
  enqueue(item: ManagementDurableOutboxItem): Promise<void>;
  remove(item: Pick<ManagementDurableOutboxItem, 'managementRunId' | 'commandId' | 'idempotencyKey'>): Promise<void>;
  list(): readonly ManagementDurableOutboxItem[];
  size(): number;
}

export interface CreateManagementDurableOutboxInput {
  readonly profileId?: string;
  readonly baseDir?: string;
  readonly storage?: ManagementOutboxStorage;
}

export async function createManagementDurableOutbox(
  input: CreateManagementDurableOutboxInput = {},
): Promise<ManagementDurableOutbox> {
  const storage = input.storage ?? createFileStorage(managementOutboxFile(input.profileId, input.baseDir));
  const loaded = parseSnapshot(await storage.load());
  let items: ManagementDurableOutboxItem[] = loaded ?? [];
  if (loaded === undefined) await saveSnapshot(storage, items);
  let mutationTail = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  return {
    enqueue(item) {
      return mutate(async () => {
        assertSafeItem(item);
        const key = itemKey(item);
        const existing = items.find((candidate) => itemKey(candidate) === key);
        if (existing) {
          if (existing.requestHash === item.requestHash && existing.toolName === item.toolName) return;
          throw new Error('MANAGEMENT_OUTBOX_IDEMPOTENCY_CONFLICT');
        }
        const next = [...items, structuredClone(item)];
        await saveSnapshot(storage, next);
        items = next;
      });
    },
    remove(item) {
      return mutate(async () => {
        const key = itemKey(item);
        const next = items.filter((candidate) => itemKey(candidate) !== key);
        if (next.length === items.length) return;
        await saveSnapshot(storage, next);
        items = next;
      });
    },
    list() {
      return structuredClone(items);
    },
    size() {
      return items.length;
    },
  };
}

function createFileStorage(file: string): ManagementOutboxStorage {
  return {
    async load() {
      try {
        return JSON.parse(await readFile(file, 'utf8'));
      } catch {
        return undefined;
      }
    },
    async save(snapshot) {
      const parent = dirname(file);
      const temporary = `${file}.tmp-${process.pid}`;
      await mkdir(parent, { recursive: true, mode: 0o700 });
      await writeFile(temporary, `${JSON.stringify(snapshot, null, 2)}\n`, { mode: 0o600 });
      await chmod(temporary, 0o600);
      try {
        await rename(temporary, file);
        await chmod(file, 0o600);
      } finally {
        await rm(temporary, { force: true }).catch(() => undefined);
      }
    },
  };
}

async function saveSnapshot(
  storage: ManagementOutboxStorage,
  items: readonly ManagementDurableOutboxItem[],
): Promise<void> {
  try {
    await storage.save({ schemaVersion: 1, items });
  } catch {
    throw new Error('MANAGEMENT_OUTBOX_WRITE_FAILED');
  }
}

function parseSnapshot(value: unknown): ManagementDurableOutboxItem[] | undefined {
  if (!isRecord(value) || value.schemaVersion !== 1 || !Array.isArray(value.items)) return undefined;
  try {
    value.items.forEach(assertSafeItem);
    return value.items.map((item) => structuredClone(item as ManagementDurableOutboxItem));
  } catch {
    return undefined;
  }
}

const ITEM_KEYS = new Set([
  'schemaVersion',
  'managementRunId',
  'commandId',
  'idempotencyKey',
  'requestHash',
  'toolName',
  'createdAt',
]);

function assertSafeItem(value: unknown): asserts value is ManagementDurableOutboxItem {
  if (!isRecord(value)
    || Object.keys(value).some((key) => !ITEM_KEYS.has(key))
    || value.schemaVersion !== 1
    || !safeText(value.managementRunId)
    || !safeText(value.commandId)
    || !safeText(value.idempotencyKey)
    || !safeText(value.requestHash)
    || !safeText(value.toolName)
    || !Number.isSafeInteger(value.createdAt)
    || Number(value.createdAt) < 0) {
    throw new Error('MANAGEMENT_OUTBOX_ITEM_INVALID');
  }
}

function safeText(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && value.length <= 512;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value));
}

function itemKey(item: Pick<ManagementDurableOutboxItem, 'managementRunId' | 'commandId' | 'idempotencyKey'>): string {
  return `${item.managementRunId}\u0000${item.commandId}\u0000${item.idempotencyKey}`;
}
