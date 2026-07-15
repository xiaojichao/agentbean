import { randomUUID } from 'node:crypto';
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  realpath,
  rename,
  rm,
  stat,
} from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';

import { MEMORY_KINDS } from '../../../../packages/contracts/src/index.js';
import { agentBeanHome, profileRoot, sanitizeProfileId } from '../profile-paths.js';
import { withLocalMemoryFileLock } from './file-lock.js';
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
import { workspaceCwdHash } from './workspace-identity.js';

interface LocalMemorySnapshotV1 {
  readonly schemaVersion: 1;
  readonly items: readonly LocalMemoryItem[];
}

interface StoreLimits {
  readonly maxAutoWorkspaceItems: number;
  readonly maxTotalItems: number;
  readonly maxTerminalItems: number;
  readonly maxFileBytes: number;
}

interface WorkspaceFileTarget {
  readonly kind: 'workspace';
  readonly file: string;
  readonly profileId: string;
  readonly safetyRoot: string;
  readonly directories: readonly string[];
  readonly workspaceCwd: string;
  readonly workspaceCwdHash: string;
}

interface ProfileFileTarget {
  readonly kind: 'profile';
  readonly file: string;
  readonly profileId: string;
  readonly safetyRoot: string;
  readonly directories: readonly string[];
}

type FileTarget = WorkspaceFileTarget | ProfileFileTarget;

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
  readonly maxTotalItems?: number;
  readonly maxTerminalItems?: number;
  readonly maxFileBytes?: number;
  readonly now?: () => number;
  readonly nextId?: () => string;
}

export function workspaceMemoryFile(cwd: string, profileId = 'default'): string {
  return join(resolve(cwd), '.agentbean', 'memory', `${sanitizeProfileId(profileId)}.json`);
}

export function profileMemoryFile(profileId: string, baseDir?: string): string {
  return join(profileRoot(profileId, baseDir), 'memory', 'items.json');
}

export async function createLocalMemoryStore(
  input: CreateLocalMemoryStoreInput,
): Promise<LocalMemoryStore> {
  if (!input.profileId.trim()) throw new Error('LOCAL_MEMORY_PROFILE_REQUIRED');
  const profileId = sanitizeProfileId(input.profileId);
  const canonicalCwd = input.cwd ? await canonicalWorkspace(input.cwd) : undefined;
  const workspaceTarget: WorkspaceFileTarget | undefined = canonicalCwd
    ? workspaceFileTarget(canonicalCwd, profileId)
    : undefined;
  const profileTarget = profileFileTarget(profileId, input.baseDir);
  const now = input.now ?? Date.now;
  const nextId = input.nextId ?? randomUUID;
  const limits = normalizeLimits(input);
  if (workspaceTarget) await assertSafeTarget(workspaceTarget, false);
  await assertSafeTarget(profileTarget, false);
  let workspaceItems = workspaceTarget
    ? await loadItems(workspaceTarget, limits)
    : [];
  let profileItems = await loadItems(profileTarget, limits);
  let mutationTail = Promise.resolve();

  function mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = mutationTail.then(operation, operation);
    mutationTail = result.then(() => undefined, () => undefined);
    return result;
  }

  function allItems(): LocalMemoryItem[] {
    return [...workspaceItems, ...profileItems];
  }

  function replaceCached(target: FileTarget, items: LocalMemoryItem[]): void {
    if (target.kind === 'workspace') workspaceItems = items;
    else profileItems = items;
  }

  return {
    upsert(itemInput) {
      return mutate(async () => {
        const timestamp = now();
        const normalized = await normalizeUpsertInput(itemInput, canonicalCwd, timestamp);
        const target = normalized.scopeType === 'local-workspace' ? workspaceTarget : profileTarget;
        if (!target) throw new Error('LOCAL_MEMORY_CWD_REQUIRED');
        return withTargetLock(target, async () => {
          const current = await loadItems(target, limits);
          const existingIndex = dedupeIndex(current, normalized);
          const existing = existingIndex >= 0 ? current[existingIndex] : undefined;
          const item: LocalMemoryItem = existing
            ? {
                ...existing,
                ...copyInput(normalized),
                structured: mergeStructured(existing.structured, normalized.structured),
                updatedAt: timestamp,
              }
            : {
                id: nextId(),
                profileId,
                ...copyInput(normalized),
                status: normalized.status ?? 'active',
                createdAt: timestamp,
                updatedAt: timestamp,
              };
          const next = existing
            ? current.map((candidate, index) => index === existingIndex ? item : candidate)
            : [...current, item];
          const expired = target.kind === 'workspace'
            ? expireOverflow(next, item.cwdHash, limits.maxAutoWorkspaceItems, timestamp)
            : [];
          const withExpiry = expired.length > 0
            ? next.map((candidate) => expired.some((entry) => entry.id === candidate.id)
              ? { ...candidate, status: 'expired' as const, updatedAt: timestamp }
              : candidate)
            : next;
          const persisted = compactItems(withExpiry, limits);
          await saveItems(target, persisted, limits.maxFileBytes);
          replaceCached(target, persisted);
          return {
            item: structuredClone(persisted.find((candidate) => candidate.id === item.id) ?? item),
            action: existing ? 'updated' : 'created',
            expired: expired.map((candidate) => structuredClone(
              persisted.find((entry) => entry.id === candidate.id) ?? candidate,
            )),
          };
        });
      });
    },
    setStatus(id, status) {
      return mutate(async () => {
        assertStatus(status);
        for (const target of [workspaceTarget, profileTarget]) {
          if (!target) continue;
          const result = await withTargetLock(target, async () => {
            const current = await loadItems(target, limits);
            const index = current.findIndex((item) => item.id === id);
            if (index < 0) return { item: null, items: current };
            const item = { ...current[index]!, status, updatedAt: now() };
            const persisted = compactItems(
              current.map((candidate, itemIndex) => itemIndex === index ? item : candidate),
              limits,
            );
            await saveItems(target, persisted, limits.maxFileBytes);
            return { item, items: persisted };
          });
          replaceCached(target, result.items);
          if (result.item) return structuredClone(result.item);
        }
        return null;
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

async function normalizeUpsertInput(
  input: LocalMemoryUpsertInput,
  canonicalCwd: string | undefined,
  timestamp: number,
): Promise<LocalMemoryUpsertInput> {
  assertCommonInput(input, timestamp);
  if (input.scopeType !== 'local-workspace') {
    if (input.scopeType === 'local-agent' && !input.agentId) {
      throw new Error('LOCAL_MEMORY_AGENT_SCOPE_INVALID');
    }
    if (input.scopeType !== 'local-agent' && input.scopeType !== 'local-profile') {
      throw new Error('LOCAL_MEMORY_SCOPE_INVALID');
    }
    return input;
  }
  if (!canonicalCwd || !input.cwd || (input.sourceKind !== 'manual' && !input.dedupeKey)) {
    throw new Error('LOCAL_MEMORY_WORKSPACE_SCOPE_INVALID');
  }
  const inputCwd = await canonicalWorkspace(input.cwd);
  if (inputCwd !== canonicalCwd) throw new Error('LOCAL_MEMORY_WORKSPACE_SCOPE_INVALID');
  const derivedHash = workspaceCwdHash(canonicalCwd);
  if (input.cwdHash !== undefined && input.cwdHash !== derivedHash) {
    throw new Error('LOCAL_MEMORY_CWD_HASH_INVALID');
  }
  return { ...input, cwd: canonicalCwd, cwdHash: derivedHash };
}

function assertCommonInput(input: LocalMemoryUpsertInput, timestamp: number): void {
  const knownKeys = new Set([
    'teamId', 'agentId', 'cwd', 'cwdHash', 'dedupeKey', 'kind', 'scopeType', 'content', 'summary',
    'structured', 'status', 'sourceKind', 'sourcePath', 'validUntil',
  ]);
  if (Object.keys(input).some((key) => !knownKeys.has(key))) {
    throw new Error('LOCAL_MEMORY_ITEM_INVALID');
  }
  if (!input.content.trim() || input.content.length > 16_384
    || (input.summary?.length ?? 0) > 2_048
    || !optionalText(input.teamId)
    || !optionalText(input.agentId)
    || !optionalText(input.cwd)
    || !optionalText(input.cwdHash)
    || !optionalText(input.dedupeKey)
    || !optionalText(input.sourcePath)
    || !isStructuredData(input.structured)) {
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
}

function assertStatus(status: LocalMemoryStatus): void {
  if (!['active', 'expired', 'superseded', 'deleted'].includes(status)) {
    throw new Error('LOCAL_MEMORY_STATUS_INVALID');
  }
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

function compactItems(items: readonly LocalMemoryItem[], limits: StoreLimits): LocalMemoryItem[] {
  const terminalIds = () => new Set([...items]
    .filter((item) => item.status !== 'active')
    .sort((left, right) => right.updatedAt - left.updatedAt || right.id.localeCompare(left.id))
    .slice(limits.maxTerminalItems)
    .map((item) => item.id));
  let removed = terminalIds();
  let next = items.filter((item) => !removed.has(item.id));
  while (next.length > limits.maxTotalItems || serializedSnapshotBytes(next) > limits.maxFileBytes) {
    const oldestTerminal = next
      .filter((item) => item.status !== 'active')
      .sort((left, right) => left.updatedAt - right.updatedAt || left.id.localeCompare(right.id))[0];
    if (!oldestTerminal) throw new Error('LOCAL_MEMORY_CAPACITY_EXCEEDED');
    removed = new Set([oldestTerminal.id]);
    next = next.filter((item) => !removed.has(item.id));
  }
  return next;
}

function normalizeLimits(input: CreateLocalMemoryStoreInput): StoreLimits {
  const maxAutoWorkspaceItems = boundedInteger(input.maxAutoWorkspaceItems ?? 80, 50, 100);
  const maxTotalItems = boundedInteger(input.maxTotalItems ?? 500, 1, 10_000);
  const maxTerminalItems = boundedInteger(input.maxTerminalItems ?? 200, 0, maxTotalItems);
  const maxFileBytes = boundedInteger(input.maxFileBytes ?? 4 * 1024 * 1024, 1_024, 64 * 1024 * 1024);
  return { maxAutoWorkspaceItems, maxTotalItems, maxTerminalItems, maxFileBytes };
}

function boundedInteger(value: number, minimum: number, maximum: number): number {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new Error('LOCAL_MEMORY_LIMIT_INVALID');
  }
  return value;
}

async function canonicalWorkspace(cwd: string): Promise<string> {
  try {
    const canonical = await realpath(cwd);
    const metadata = await stat(canonical);
    if (!metadata.isDirectory()) throw new Error('not-directory');
    return canonical;
  } catch {
    throw new Error('LOCAL_MEMORY_CWD_INVALID');
  }
}

function workspaceFileTarget(cwd: string, profileId: string): WorkspaceFileTarget {
  const memoryRoot = join(cwd, '.agentbean', 'memory');
  return {
    kind: 'workspace',
    file: workspaceMemoryFile(cwd, profileId),
    profileId,
    safetyRoot: cwd,
    directories: [join(cwd, '.agentbean'), memoryRoot],
    workspaceCwd: cwd,
    workspaceCwdHash: workspaceCwdHash(cwd),
  };
}

function profileFileTarget(profileId: string, baseDir?: string): ProfileFileTarget {
  const safetyRoot = resolve(agentBeanHome(baseDir));
  const root = profileRoot(profileId, safetyRoot);
  return {
    kind: 'profile',
    file: join(root, 'memory', 'items.json'),
    profileId,
    safetyRoot,
    directories: [safetyRoot, join(safetyRoot, 'teams'), root, join(root, 'memory')],
  };
}

async function loadItems(target: FileTarget, limits: StoreLimits): Promise<LocalMemoryItem[]> {
  let metadata;
  try {
    metadata = await lstat(target.file);
  } catch (error) {
    if (errorCode(error) === 'ENOENT') return [];
    throw new Error('LOCAL_MEMORY_FILE_READ_FAILED');
  }
  if (!metadata.isFile() || metadata.isSymbolicLink() || metadata.size > limits.maxFileBytes) {
    throw new Error('LOCAL_MEMORY_FILE_INVALID');
  }
  let raw: string;
  try {
    raw = await readFile(target.file, 'utf8');
  } catch {
    throw new Error('LOCAL_MEMORY_FILE_READ_FAILED');
  }
  if (Buffer.byteLength(raw) > limits.maxFileBytes) throw new Error('LOCAL_MEMORY_FILE_INVALID');
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw) as unknown;
  } catch {
    throw new Error('LOCAL_MEMORY_FILE_INVALID');
  }
  if (!isSnapshot(parsed)
    || parsed.items.length > limits.maxTotalItems
    || parsed.items.some((item) => !itemMatchesTarget(item, target))) {
    throw new Error('LOCAL_MEMORY_FILE_INVALID');
  }
  return parsed.items.map((item) => structuredClone(item));
}

function itemMatchesTarget(item: LocalMemoryItem, target: FileTarget): boolean {
  if (item.profileId !== target.profileId) return false;
  if (target.kind === 'workspace') {
    return item.scopeType === 'local-workspace'
      && item.cwd === target.workspaceCwd
      && item.cwdHash === target.workspaceCwdHash;
  }
  return item.scopeType === 'local-profile' || item.scopeType === 'local-agent';
}

async function withTargetLock<T>(target: FileTarget, operation: () => Promise<T>): Promise<T> {
  await ensureSafeParent(target);
  return withLocalMemoryFileLock(`${target.file}.lock`, async () => {
    await assertSafeTarget(target, true);
    return await operation();
  });
}

async function ensureSafeParent(target: FileTarget): Promise<void> {
  await assertSafeTarget(target, false);
  for (const directory of target.directories) {
    try {
      await mkdir(directory, { mode: 0o700 });
    } catch (error) {
      if (errorCode(error) !== 'EEXIST') throw new Error('LOCAL_MEMORY_PATH_CHECK_FAILED');
    }
    await assertSafeDirectory(directory);
  }
  await assertSafeTarget(target, true);
}

async function assertSafeTarget(target: FileTarget, parentMustExist: boolean): Promise<void> {
  const expectedParent = target.directories[target.directories.length - 1];
  if (!expectedParent
    || !pathInside(target.safetyRoot, target.file)
    || dirname(target.file) !== expectedParent) {
    throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
  }
  for (const path of [...target.directories, target.file]) {
    try {
      const metadata = await lstat(path);
      if (metadata.isSymbolicLink()) throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
      if (path === target.file && !metadata.isFile()) throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
      if (path !== target.file && !metadata.isDirectory()) throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
    } catch (error) {
      if (error instanceof Error && error.message === 'LOCAL_MEMORY_PATH_ESCAPE') throw error;
      if (errorCode(error) !== 'ENOENT') throw new Error('LOCAL_MEMORY_PATH_CHECK_FAILED');
      if (parentMustExist && path !== target.file) throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
    }
  }
  if (parentMustExist) {
    const [canonicalRoot, canonicalParent] = await Promise.all([
      realpath(target.safetyRoot),
      realpath(expectedParent),
    ]);
    if (!pathInside(canonicalRoot, canonicalParent)) throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
  }
}

async function assertSafeDirectory(path: string): Promise<void> {
  try {
    const metadata = await lstat(path);
    if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
      throw new Error('LOCAL_MEMORY_PATH_ESCAPE');
    }
  } catch (error) {
    if (error instanceof Error && error.message === 'LOCAL_MEMORY_PATH_ESCAPE') throw error;
    throw new Error('LOCAL_MEMORY_PATH_CHECK_FAILED');
  }
}

async function saveItems(target: FileTarget, items: readonly LocalMemoryItem[], maxFileBytes: number): Promise<void> {
  await assertSafeTarget(target, true);
  const serialized = serializeSnapshot(items);
  if (Buffer.byteLength(serialized) > maxFileBytes) throw new Error('LOCAL_MEMORY_CAPACITY_EXCEEDED');
  const temporary = `${target.file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(serialized, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temporary, 0o600);
  try {
    await assertSafeTarget(target, true);
    await rename(temporary, target.file);
    await chmod(target.file, 0o600);
    try {
      const directory = await open(dirname(target.file), 'r');
      try {
        await directory.sync();
      } finally {
        await directory.close();
      }
    } catch {
      // Directory fsync is not supported on every target platform; file fsync above is mandatory.
    }
  } finally {
    await rm(temporary, { force: true }).catch(() => undefined);
  }
}

function serializeSnapshot(items: readonly LocalMemoryItem[]): string {
  return `${JSON.stringify({ schemaVersion: 1, items }, null, 2)}\n`;
}

function serializedSnapshotBytes(items: readonly LocalMemoryItem[]): number {
  return Buffer.byteLength(serializeSnapshot(items));
}

function pathInside(parent: string, candidate: string): boolean {
  const path = relative(parent, candidate);
  return path === '' || (path !== '..' && !path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`)
    && !isAbsolute(path));
}

function errorCode(error: unknown): string | undefined {
  return error && typeof error === 'object' && 'code' in error
    ? String((error as { code?: unknown }).code)
    : undefined;
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
  const keys = Object.keys(item);
  const knownKeys = new Set([
    'id', 'profileId', 'teamId', 'agentId', 'cwd', 'cwdHash', 'dedupeKey', 'kind', 'scopeType',
    'content', 'summary', 'structured', 'status', 'sourceKind', 'sourcePath', 'createdAt', 'updatedAt',
    'validUntil',
  ]);
  const common = keys.every((key) => knownKeys.has(key))
    && typeof item.profileId === 'string'
    && item.profileId.length > 0
    && typeof item.id === 'string'
    && item.id.length > 0
    && typeof item.content === 'string'
    && item.content.length > 0
    && item.content.length <= 16_384
    && optionalText(item.teamId)
    && optionalText(item.agentId)
    && optionalText(item.cwd)
    && optionalText(item.cwdHash)
    && optionalText(item.dedupeKey)
    && optionalText(item.summary)
    && optionalText(item.sourcePath)
    && isStructuredData(item.structured)
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
  if (!common) return false;
  if (item.scopeType === 'local-workspace') {
    return Boolean(item.cwd && item.cwdHash && (item.sourceKind === 'manual' || item.dedupeKey));
  }
  if (item.scopeType === 'local-agent') return Boolean(item.agentId);
  return item.scopeType === 'local-profile';
}

function optionalText(value: unknown): value is string | undefined {
  return value === undefined || (typeof value === 'string' && value.length > 0);
}

function isStructuredData(value: unknown): value is LocalMemoryStructuredData | undefined {
  if (value === undefined) return true;
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  const keys = ['techStack', 'commands', 'paths', 'tags', 'sourceRunIds'];
  return Object.keys(record).every((key) => keys.includes(key))
    && keys.every((key) => record[key] === undefined
      || (Array.isArray(record[key])
        && record[key].every((entry: unknown) => typeof entry === 'string' && entry.length > 0)));
}
