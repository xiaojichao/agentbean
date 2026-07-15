import type {
  LocalMemoryScopeType,
  MemoryKind,
} from '../../../../packages/contracts/src/index.js';

export type LocalMemoryStatus = 'active' | 'expired' | 'superseded' | 'deleted';
export type LocalMemorySourceKind = 'scan' | 'workspace_run' | 'manual' | 'local_file';

export interface LocalMemoryStructuredData {
  readonly techStack?: readonly string[];
  readonly commands?: readonly string[];
  readonly paths?: readonly string[];
  readonly tags?: readonly string[];
  readonly sourceRunIds?: readonly string[];
}

export interface LocalMemoryItem {
  readonly id: string;
  readonly profileId: string;
  readonly teamId?: string;
  readonly agentId?: string;
  readonly cwd?: string;
  readonly cwdHash?: string;
  readonly dedupeKey?: string;
  readonly kind: MemoryKind;
  readonly scopeType: LocalMemoryScopeType;
  readonly content: string;
  readonly summary?: string;
  readonly structured?: LocalMemoryStructuredData;
  readonly status: LocalMemoryStatus;
  readonly sourceKind: LocalMemorySourceKind;
  readonly sourcePath?: string;
  readonly createdAt: number;
  readonly updatedAt: number;
  readonly validUntil?: number;
}

export interface LocalMemoryUpsertInput {
  readonly teamId?: string;
  readonly agentId?: string;
  readonly cwd?: string;
  readonly cwdHash?: string;
  readonly dedupeKey?: string;
  readonly kind: MemoryKind;
  readonly scopeType: LocalMemoryScopeType;
  readonly content: string;
  readonly summary?: string;
  readonly structured?: LocalMemoryStructuredData;
  readonly status?: LocalMemoryStatus;
  readonly sourceKind: LocalMemorySourceKind;
  readonly sourcePath?: string;
  readonly validUntil?: number;
}

export interface AutoAccumulatedMemorySummary {
  readonly id: string;
  readonly kind: MemoryKind;
  readonly scopeType: LocalMemoryScopeType;
  readonly sourceKind: LocalMemorySourceKind;
  readonly summary: string;
  readonly action: 'created' | 'updated' | 'expired';
}

export interface LocalMemoryMutationResult {
  readonly item: LocalMemoryItem;
  readonly action: 'created' | 'updated';
  readonly expired: readonly LocalMemoryItem[];
}
