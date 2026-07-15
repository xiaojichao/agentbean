import { randomUUID } from 'node:crypto';
import { chmod, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';

import { MEMORY_KINDS } from '../../../../packages/contracts/src/index.js';
import { profileRoot, sanitizeProfileId } from '../profile-paths.js';
import {
  containsSensitiveMemoryText,
  containsSensitiveMemoryValue,
} from './sensitive-memory.js';
import type {
  LocalMemoryItem,
  LocalMemoryMutationResult,
  LocalMemoryStatus,
  LocalMemoryStructuredData,
  LocalMemoryUpsertInput,
} from './types.js';

interface LocalMemorySnapshotV1 {
  readonly schemaVersion: 1;
  readonly items: readonly LocalMemoryItem[];
}

export interface LocalMemoryStore {
  upsert(input: LocalMemoryUpsertInput): Promise<LocalMemoryMutationResult>;
  setStatus(id: string, status: LocalMemoryStatus): Promise<LocalMemoryItem | null>;
  getById(id: string): LocalMemoryItem | null;
  list(): readonly LocalMemoryItem[];
  listActive(now?: number): readonly LocalMemoryItem[];
}

export interface CreateLocalMemoryStoreInput {
  readonly profileId: string;
  readonly cwd?: string;
  readonly baseDir?: string;
  readonly maxAutoWorkspaceItems?: number;
  readonly now?: () => number;
  readonly nextId?: () => string;
}

export function workspaceMemoryFile(cwd: string): string {
  return join(resolve(cwd), '.agentbean', 'memory', 'items.json');
}

export function profileMemoryFile(profileId: string, baseDir?: string): string {
  return join(profileRoot(profileId, baseDir), 'memory', 'items.json');
}

export async function createLocalMemoryStore(
  input: CreateLocalMemoryStoreInput,
): Promise<LocalMemoryStore> {
  if (!input.profileId.trim()) throw new Error('LOCAL_MEMORY_PROFILE_REQUIRED');
  const profileId = sanitizeProfileId(input.profileId);
  const workspaceFile = input.cwd ? workspaceMemoryFile(input.cwd) : undefined;
  const profileFile = profileMemoryFile(profileId, input.baseDir);
  const now = input.now ?? Date.now;
  const nextId = input.nextId ?? randomUUID;
  const maxAutoWorkspaceItems = normalizeAutoLimit(input.maxAutoWorkspaceItems ?? 80);
  let workspaceItems = workspaceFile ? await loadItems(workspaceFile, profileId) : [];
  let profileItems = await loadItems(profileFile, profileId);
  let mutationTail = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function allItems(): LocalMemoryItem[] {
    return [...workspaceItems, ...profileItems];
  }

  return {
    upsert(itemInput) {
      return mutate(async () => {
        assertUpsertInput(itemInput, profileId, input.cwd, now());
        const workspaceScoped = itemInput.scopeType === 'local-workspace';
        const file = workspaceScoped ? workspaceFile : profileFile;
        if (!file) throw new Error('LOCAL_MEMORY_CWD_REQUIRED');
        const current = workspaceScoped ? workspaceItems : profileItems;
        const timestamp = now();
        const existingIndex = dedupeIndex(current, itemInput);
        const existing = existingIndex >= 0 ? current[existingIndex] : undefined;
        const item: LocalMemoryItem = existing
          ? {
              ...existing,
              ...copyInput(itemInput),
              structured: mergeStructured(existing.structured, itemInput.structured),
              updatedAt: timestamp,
            }
          : {
              id: nextId(),
              profileId,
              ...copyInput(itemInput),
              status: itemInput.status ?? 'active',
              createdAt: timestamp,
              updatedAt: timestamp,
            };
        const next = existing
          ? current.map((candidate, index) => index === existingIndex ? item : candidate)
          : [...current, item];
        const expired = workspaceScoped
          ? expireOverflow(next, item.cwdHash, maxAutoWorkspaceItems, timestamp)
          : [];
        const persisted = expired.length > 0
          ? next.map((candidate) => expired.some((entry) => entry.id === candidate.id)
            ? { ...candidate, status: 'expired' as const, updatedAt: timestamp }
            : candidate)
          : next;
        await saveItems(file, persisted);
        if (workspaceScoped) workspaceItems = persisted;
        else profileItems = persisted;
        const persistedItem = persisted.find((candidate) => candidate.id === item.id)!;
        return {
          item: structuredClone(persistedItem),
          action: existing ? 'updated' : 'created',
          expired: expired.map((candidate) => structuredClone(
            persisted.find((entry) => entry.id === candidate.id)!,
          )),
        };
      });
    },
    setStatus(id, status) {
      return mutate(async () => {
        const workspaceIndex = workspaceItems.findIndex((item) => item.id === id);
        const profileIndex = profileItems.findIndex((item) => item.id === id);
        if (workspaceIndex < 0 && profileIndex < 0) return null;
        const workspaceScoped = workspaceIndex >= 0;
        const current = workspaceScoped ? workspaceItems : profileItems;
        const index = workspaceScoped ? workspaceIndex : profileIndex;
        const updated = { ...current[index]!, status, updatedAt: now() };
        const next = current.map((item, itemIndex) => itemIndex === index ? updated : item);
        await saveItems(workspaceScoped ? workspaceFile! : profileFile, next);
        if (workspaceScoped) workspaceItems = next;
        else profileItems = next;
        return structuredClone(updated);
      });
    },
    getById(id) {
      const item = allItems().find((candidate) => candidate.id === id);
      return item ? structuredClone(item) : null;
    },
    list() {
      return structuredClone(allItems());
    },
    listActive(at = now()) {
      return structuredClone(allItems().filter((item) => item.status === 'active'
        && (item.validUntil === undefined || item.validUntil > at)));
    },
  };
}

function copyInput(input: LocalMemoryUpsertInput): Omit<LocalMemoryUpsertInput, 'structured'> & {
  readonly structured?: LocalMemoryStructuredData;
} {
  return {
    ...input,
    ...(input.structured ? { structured: structuredClone(input.structured) } : {}),
  };
}

function dedupeIndex(items: readonly LocalMemoryItem[], input: LocalMemoryUpsertInput): number {
  if (input.sourceKind === 'manual' || !input.dedupeKey) return -1;
  return items.findIndex((item) => item.status === 'active'
    && item.cwdHash === input.cwdHash
    && item.kind === input.kind
    && item.dedupeKey === input.dedupeKey);
}

function mergeStructured(
  current: LocalMemoryStructuredData | undefined,
  incoming: LocalMemoryStructuredData | undefined,
): LocalMemoryStructuredData | undefined {
  if (!current) return incoming ? structuredClone(incoming) : undefined;
  if (!incoming) return structuredClone(current);
  const currentData = current;
  const incomingData = incoming;
  return {
    ...currentData,
    ...incomingData,
    ...mergeArray('techStack'),
    ...mergeArray('commands'),
    ...mergeArray('paths'),
    ...mergeArray('tags'),
    ...mergeArray('sourceRunIds'),
  };

  function mergeArray(key: keyof LocalMemoryStructuredData): Partial<LocalMemoryStructuredData> {
    const values = [...(currentData[key] ?? []), ...(incomingData[key] ?? [])];
    return values.length > 0 ? { [key]: [...new Set(values)] } : {};
  }
}

function expireOverflow(
  items: readonly LocalMemoryItem[],
  cwdHash: string | undefined,
  limit: number,
  timestamp: number,
): LocalMemoryItem[] {
  if (!cwdHash) return [];
  const active = items.filter((item) => item.status === 'active'
    && item.scopeType === 'local-workspace'
    && item.cwdHash === cwdHash
    && item.sourceKind !== 'manual');
  const overflow = active.length - limit;
  if (overflow <= 0) return [];
  return [...active]
    .sort((left, right) => {
      const leftPriority = left.sourceKind === 'workspace_run' ? 0 : 1;
      const rightPriority = right.sourceKind === 'workspace_run' ? 0 : 1;
      return leftPriority - rightPriority || left.updatedAt - right.updatedAt || left.id.localeCompare(right.id);
    })
    .slice(0, overflow)
    .map((item) => ({ ...item, status: 'expired', updatedAt: timestamp }));
}

function assertUpsertInput(
  input: LocalMemoryUpsertInput,
  profileId: string,
  configuredCwd: string | undefined,
  timestamp: number,
): void {
  if (!input.content.trim() || input.content.length > 16_384
    || (input.summary?.length ?? 0) > 2_048) {
    throw new Error('LOCAL_MEMORY_CONTENT_INVALID');
  }
  if (!MEMORY_KINDS.includes(input.kind)
    || !['scan', 'workspace_run', 'manual', 'local_file'].includes(input.sourceKind)
    || (input.status !== undefined
      && !['active', 'expired', 'superseded', 'deleted'].includes(input.status))) {
    throw new Error('LOCAL_MEMORY_ITEM_INVALID');
  }
  if (input.validUntil !== undefined && input.validUntil <= timestamp) {
    throw new Error('LOCAL_MEMORY_VALIDITY_INVALID');
  }
  if (input.sourceKind !== 'manual'
    && (containsSensitiveMemoryText(input.content)
      || containsSensitiveMemoryText(input.summary)
      || containsSensitiveMemoryValue(input.structured))) {
    throw new Error('LOCAL_MEMORY_SENSITIVE_CONTENT');
  }
  if (input.scopeType === 'local-workspace') {
    if (!configuredCwd || !input.cwd || !input.cwdHash
      || (input.sourceKind !== 'manual' && !input.dedupeKey)
      || resolve(input.cwd) !== resolve(configuredCwd)) {
      throw new Error('LOCAL_MEMORY_WORKSPACE_SCOPE_INVALID');
    }
  } else if (input.scopeType === 'local-agent') {
    if (!input.agentId) throw new Error('LOCAL_MEMORY_AGENT_SCOPE_INVALID');
  } else if (input.scopeType !== 'local-profile') {
    throw new Error('LOCAL_MEMORY_SCOPE_INVALID');
  }
  if (!profileId) throw new Error('LOCAL_MEMORY_PROFILE_REQUIRED');
}

function normalizeAutoLimit(value: number): number {
  if (!Number.isSafeInteger(value)) throw new Error('LOCAL_MEMORY_LIMIT_INVALID');
  return Math.min(100, Math.max(50, value));
}

async function loadItems(file: string, profileId: string): Promise<LocalMemoryItem[]> {
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as unknown;
    if (!isSnapshot(parsed)) return [];
    return parsed.items.filter((item) => item.profileId === profileId).map((item) => structuredClone(item));
  } catch {
    return [];
  }
}

async function saveItems(file: string, items: readonly LocalMemoryItem[]): Promise<void> {
  const temporary = `${file}.tmp-${process.pid}`;
  await mkdir(dirname(file), { recursive: true, mode: 0o700 });
  await writeFile(temporary, `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`, { mode: 0o600 });
  await chmod(temporary, 0o600);
  try {
    await rename(temporary, file);
    await chmod(file, 0o600);
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function isSnapshot(value: unknown): value is LocalMemorySnapshotV1 {
  if (!value || typeof value !== 'object') return false;
  const snapshot = value as { schemaVersion?: unknown; items?: unknown };
  return snapshot.schemaVersion === 1
    && Array.isArray(snapshot.items)
    && snapshot.items.every(isLocalMemoryItem);
}

function isLocalMemoryItem(value: unknown): value is LocalMemoryItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<LocalMemoryItem>;
  return typeof item.profileId === 'string'
    && item.profileId.length > 0
    && typeof item.id === 'string'
    && typeof item.content === 'string'
    && item.content.length > 0
    && item.content.length <= 16_384
    && (item.summary === undefined || typeof item.summary === 'string')
    && MEMORY_KINDS.includes(item.kind as (typeof MEMORY_KINDS)[number])
    && ['local-workspace', 'local-agent', 'local-profile'].includes(String(item.scopeType))
    && ['active', 'expired', 'superseded', 'deleted'].includes(String(item.status))
    && ['scan', 'workspace_run', 'manual', 'local_file'].includes(String(item.sourceKind))
    && Number.isSafeInteger(item.createdAt)
    && Number.isSafeInteger(item.updatedAt)
    && (item.validUntil === undefined || Number.isSafeInteger(item.validUntil))
    && (item.sourceKind === 'manual'
      || (!containsSensitiveMemoryText(item.content)
        && !containsSensitiveMemoryText(item.summary)
        && !containsSensitiveMemoryValue(item.structured)));
}
