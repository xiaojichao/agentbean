import { basename } from 'node:path';
import type { LocalMemoryGovernanceSummaryDto } from '../../../../packages/contracts/src/index.js';
import { createLocalMemoryStore } from './local-memory-store.js';
import { containsSensitiveMemoryText } from './sensitive-memory.js';

export async function listLocalMemoryGovernanceSummaries(input: {
  profileId: string;
  teamId: string;
  cwds: readonly string[];
  baseDir?: string;
}): Promise<readonly LocalMemoryGovernanceSummaryDto[]> {
  const stores = [
    await createLocalMemoryStore({ profileId: input.profileId, ...(input.baseDir ? { baseDir: input.baseDir } : {}) }),
  ];
  for (const cwd of new Set(input.cwds.filter(Boolean))) {
    try {
      stores.push(await createLocalMemoryStore({
        profileId: input.profileId,
        cwd,
        ...(input.baseDir ? { baseDir: input.baseDir } : {}),
      }));
    } catch {
      // Stale or inaccessible agent workspaces must not hide profile-level or other valid summaries.
    }
  }
  const summaries = new Map<string, LocalMemoryGovernanceSummaryDto>();
  for (const store of stores) {
    for (const item of store.list()) {
      if (item.teamId !== undefined && item.teamId !== input.teamId) continue;
      const summary = item.summary?.trim() || `${item.kind} · ${item.sourceKind}（正文仅保留在当前 Device）`;
      if (containsSensitiveMemoryText(summary)) continue;
      summaries.set(item.id, {
        schemaVersion: 1,
        id: item.id,
        kind: item.kind,
        scopeType: item.scopeType,
        status: item.status,
        sourceKind: item.sourceKind,
        summary,
        ...(item.cwd ? { workspaceLabel: basename(item.cwd) } : {}),
        createdAt: item.createdAt,
        updatedAt: item.updatedAt,
        ...(item.validUntil !== undefined ? { validUntil: item.validUntil } : {}),
      });
    }
  }
  return [...summaries.values()].sort((left, right) => right.updatedAt - left.updatedAt || left.id.localeCompare(right.id));
}
