import type { DispatchMemoryContextItemDto } from '../../../../packages/contracts/src/index.js';
import type { DispatchRequestPayload } from '../index.js';
import { createLocalMemoryStore } from './local-memory-store.js';
import { listLocalMemoriesForDispatch } from './local-memory-search.js';
import { containsSensitiveMemoryValue } from './sensitive-memory.js';

export interface PrepareDispatchRuntimeMemoryInput {
  readonly request: DispatchRequestPayload;
  readonly profileId?: string;
  readonly baseDir?: string;
  readonly now?: number;
}

/**
 * Re-reads Device-local Memory for every execution. This intentionally avoids a process-lifetime
 * cache so reconnect, restart, profile switches and edits made after checkpoint recovery all see
 * the current Device truth.
 */
export async function prepareDispatchRuntimeMemory(
  input: PrepareDispatchRuntimeMemoryInput,
): Promise<DispatchRequestPayload> {
  const serverItems = serverMemoryOnly(input.request.memoryContext);
  if (!input.profileId) return withMemoryContext(input.request, serverItems);

  try {
    const cwd = input.request.customAgent?.cwd;
    const store = await createLocalMemoryStore({
      profileId: input.profileId,
      ...(cwd ? { cwd } : {}),
      ...(input.baseDir ? { baseDir: input.baseDir } : {}),
    });
    const localItems = listLocalMemoriesForDispatch({
      store,
      profileId: input.profileId,
      ...(cwd ? { cwd } : {}),
      agentId: input.request.agentId,
      prompt: input.request.prompt,
      ...(input.now !== undefined ? { now: input.now } : {}),
    })
      // Unscoped entries intentionally follow the Device-local profile/cwd/agent visibility model;
      // an explicit teamId narrows that local entry but is not required by the local Memory contract.
      .filter((item) => item.teamId === undefined || item.teamId === input.request.teamId)
      // Automatic learning already fails closed on secrets. Repeat the check here because manual
      // and legacy records can predate that guard.
      .filter((item) => !containsSensitiveMemoryValue({
        content: item.content,
        summary: item.summary,
        structured: item.structured,
      }))
      .map((item): DispatchMemoryContextItemDto => ({
        schemaVersion: 1,
        id: item.id,
        kind: item.kind,
        scopeType: item.scopeType,
        content: item.summary?.trim() || item.content,
        selectionReason: localSelectionReason(item.scopeType),
        provenance: { origin: 'local', sourceKind: item.sourceKind },
      }));
    return withMemoryContext(input.request, mergeRuntimeMemoryContext(serverItems, localItems));
  } catch {
    // Corrupt, unsafe or unreadable local state must fail closed without blocking the underlying
    // invocation. Server Capsule entries remain usable because they have independent authority.
    return withMemoryContext(input.request, serverItems);
  }
}

export function mergeRuntimeMemoryContext(
  serverItems: readonly DispatchMemoryContextItemDto[],
  localItems: readonly DispatchMemoryContextItemDto[],
): readonly DispatchMemoryContextItemDto[] {
  const selected: DispatchMemoryContextItemDto[] = [];
  const ids = new Set<string>();
  const contents = new Set<string>();
  for (const item of [...serverItems, ...localItems]) {
    const idKey = `${item.provenance.origin}:${item.id}`;
    const contentKey = `${item.kind}:${normalizeForDedupe(item.content)}`;
    if (ids.has(idKey) || contents.has(contentKey)) continue;
    ids.add(idKey);
    contents.add(contentKey);
    selected.push(item);
  }
  return selected;
}

export function buildRuntimePrompt(request: Pick<DispatchRequestPayload, 'prompt' | 'memoryContext'>): string {
  const memory = request.memoryContext ?? [];
  if (memory.length === 0) return request.prompt;
  const server = memory.filter((item) => item.provenance.origin === 'server');
  const local = memory.filter((item) => item.provenance.origin === 'local');
  const sections = [
    '## AgentBean 运行时记忆',
    '以下记忆可能过期；若与当前用户输入或附件冲突，以当前输入和附件为准。',
  ];
  if (server.length > 0) sections.push(renderSection('Server 协作记忆', server));
  if (local.length > 0) sections.push(renderSection('当前 Device 本地记忆', local));
  sections.push('## 当前用户输入', request.prompt);
  return sections.join('\n\n');
}

const DEVICE_LOCAL_MEMORY_REDACTION = '[Device-local Memory redacted]';

/** Removes Device-local Memory entries from any executor output that can be sent upstream. */
export function redactDeviceLocalMemory(
  value: string,
  memoryContext: readonly DispatchMemoryContextItemDto[] | undefined,
): string {
  const localItems = (memoryContext ?? []).filter((item) => item.provenance.origin === 'local');
  const privateValues = localItems.flatMap((item) => [renderItem(item), item.content])
    .filter((candidate) => candidate.trim().length > 0)
    .sort((left, right) => right.length - left.length);
  return privateValues.reduce(
    (redacted, privateValue) => redacted.replace(flexibleWhitespacePattern(privateValue), DEVICE_LOCAL_MEMORY_REDACTION),
    value,
  );
}

function renderSection(title: string, items: readonly DispatchMemoryContextItemDto[]): string {
  return [`### ${title}`, ...items.map(renderItem)].join('\n');
}

function renderItem(item: DispatchMemoryContextItemDto): string {
  let source: string;
  if (item.provenance.origin === 'server') {
    // #718: server 端含 capsule（授权复验）与 projection（team opted-in）两种来源。
    source = 'capsuleId' in item.provenance
      ? `capsule:${item.provenance.capsuleId}`
      : `projection:${item.provenance.projectionId}`;
  } else {
    source = `local:${item.provenance.sourceKind}`;
  }
  return `- [${item.provenance.origin}:${item.id}] (${item.kind}, ${item.scopeType}; ${item.selectionReason}; ${source}) ${item.content}`;
}

function flexibleWhitespacePattern(value: string): RegExp {
  const pattern = value.trim().split(/\s+/u).map(escapeRegExp).join('\\s+');
  return new RegExp(pattern, 'gu');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function serverMemoryOnly(
  items: readonly DispatchMemoryContextItemDto[] | undefined,
): readonly DispatchMemoryContextItemDto[] {
  return (items ?? []).filter((item) => item.provenance.origin === 'server');
}

function withMemoryContext(
  request: DispatchRequestPayload,
  memoryContext: readonly DispatchMemoryContextItemDto[],
): DispatchRequestPayload {
  if (memoryContext.length === 0) {
    const { memoryContext: _discarded, ...rest } = request;
    return rest;
  }
  return { ...request, memoryContext };
}

function normalizeForDedupe(value: string): string {
  return value.trim().replace(/\s+/g, ' ').toLowerCase();
}

function localSelectionReason(scopeType: DispatchMemoryContextItemDto['scopeType']): string {
  if (scopeType === 'local-workspace') return 'current-device-profile-cwd';
  if (scopeType === 'local-agent') return 'current-device-profile-agent';
  return 'current-device-profile';
}
