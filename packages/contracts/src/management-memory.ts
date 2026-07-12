import type { ID, UnixMs } from './common.js';

export interface MemoryCapsuleRefDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly taskId?: ID;
  readonly targetAgentId: ID;
  readonly contentHash: string;
  readonly authorizationDecisionId: ID;
  readonly expiresAt: UnixMs;
}

export interface MemoryCandidateRefDto {
  readonly schemaVersion: 1;
  readonly id: ID;
  readonly teamId: ID;
  readonly managementRunId: ID;
  readonly sourceKind: 'message' | 'task' | 'artifact' | 'workspace-run' | 'invocation' | 'memory';
  readonly sourceId: ID;
  readonly projectionHash: string;
  readonly createdAt: UnixMs;
}
