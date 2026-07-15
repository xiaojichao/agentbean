import type { AgentHandoffStatus, SerialAgentHandoffKind } from '@agentbean/contracts';

interface CollaborationIdentity {
  readonly id: string;
  readonly managementRunId: string;
  readonly idempotencyKey: string;
  readonly payloadHash: string;
}

export function resolveCollaborationIdempotency(input: {
  readonly existing?: CollaborationIdentity;
  readonly requestedManagementRunId: string;
  readonly requestedIdempotencyKey: string;
  readonly requestedPayloadHash: string;
}): { readonly kind: 'create' }
  | { readonly kind: 'existing'; readonly id: string }
  | { readonly kind: 'conflict'; readonly reason: string } {
  if (!input.existing) return { kind: 'create' };
  if (input.existing.managementRunId !== input.requestedManagementRunId) {
    return { kind: 'conflict', reason: 'management-run-mismatch' };
  }
  if (input.existing.idempotencyKey !== input.requestedIdempotencyKey) {
    return { kind: 'conflict', reason: 'idempotency-key-mismatch' };
  }
  if (input.existing.payloadHash !== input.requestedPayloadHash) {
    return { kind: 'conflict', reason: 'payload-hash-mismatch' };
  }
  return { kind: 'existing', id: input.existing.id };
}

export function evaluateContinuationOwnerTransition(input: {
  readonly currentAgentId?: string;
  readonly sourceAgentId?: string;
  readonly targetAgentId: string;
  readonly status: AgentHandoffStatus;
  readonly taskFenceCurrent: boolean;
}): { readonly kind: 'unchanged' }
  | { readonly kind: 'changed'; readonly nextAgentId?: string; readonly reasonCode: string } {
  if (!input.taskFenceCurrent) return { kind: 'unchanged' };
  if (input.status === 'accepted' || input.status === 'running') {
    if (input.currentAgentId === input.targetAgentId) return { kind: 'unchanged' };
    return { kind: 'changed', nextAgentId: input.targetAgentId, reasonCode: 'HANDOFF_ACCEPTED' };
  }
  if (input.status === 'failed' || input.status === 'cancelled'
    || input.status === 'timed_out' || input.status === 'rejected') {
    if (input.currentAgentId !== input.targetAgentId || input.currentAgentId === input.sourceAgentId) {
      return { kind: 'unchanged' };
    }
    return { kind: 'changed', nextAgentId: input.sourceAgentId,
      reasonCode: `HANDOFF_${input.status.toUpperCase()}_ROLLBACK` };
  }
  return { kind: 'unchanged' };
}

export function wouldCreateContinuationLoop(input: {
  readonly fromAgentId?: string;
  readonly toAgentId: string;
  readonly priorEdges: readonly {
    readonly fromAgentId?: string;
    readonly toAgentId: string;
    readonly kind: SerialAgentHandoffKind;
  }[];
}): boolean {
  if (!input.fromAgentId || input.fromAgentId === input.toAgentId) return input.fromAgentId === input.toAgentId;
  const continuationTargets = new Map<string, string[]>();
  for (const edge of input.priorEdges) {
    if (edge.kind !== 'continuation' || !edge.fromAgentId) continue;
    continuationTargets.set(edge.fromAgentId,
      [...(continuationTargets.get(edge.fromAgentId) ?? []), edge.toAgentId]);
  }
  const pending = [input.toAgentId];
  const visited = new Set<string>();
  while (pending.length > 0) {
    const agentId = pending.pop()!;
    if (agentId === input.fromAgentId) return true;
    if (visited.has(agentId)) continue;
    visited.add(agentId);
    pending.push(...(continuationTargets.get(agentId) ?? []));
  }
  return false;
}
