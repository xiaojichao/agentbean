const READ_KEY_PREFIX = 'agentbean:chat:done:';
const MUTED_CHANNEL_KEY_PREFIX = 'agentbean:chat:muted-channels:';

export interface ReadIdStorage {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

function resolveStorage(storage?: ReadIdStorage): ReadIdStorage | null {
  if (storage) return storage;
  if (typeof window === 'undefined') return null;
  return window.localStorage;
}

export function readKey(teamId: string): string {
  return `${READ_KEY_PREFIX}${teamId}`;
}

export function mutedChannelKey(teamId: string): string {
  return `${MUTED_CHANNEL_KEY_PREFIX}${teamId}`;
}

export function deserializeReadIds(raw: string | null): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((value): value is string => typeof value === 'string'));
  } catch {
    return new Set();
  }
}

export function serializeReadIds(ids: Set<string>): string {
  return JSON.stringify([...ids]);
}

export function loadReadIds(teamId: string, storage?: ReadIdStorage): Set<string> {
  const store = resolveStorage(storage);
  if (!store) return new Set();
  return deserializeReadIds(store.getItem(readKey(teamId)));
}

export function saveReadIds(teamId: string, ids: Set<string>, storage?: ReadIdStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  store.setItem(readKey(teamId), serializeReadIds(ids));
}

export function loadMutedChannelIds(teamId: string, storage?: ReadIdStorage): Set<string> {
  const store = resolveStorage(storage);
  if (!store) return new Set();
  return deserializeReadIds(store.getItem(mutedChannelKey(teamId)));
}

export function saveMutedChannelIds(teamId: string, ids: Set<string>, storage?: ReadIdStorage): void {
  const store = resolveStorage(storage);
  if (!store) return;
  store.setItem(mutedChannelKey(teamId), serializeReadIds(ids));
}
