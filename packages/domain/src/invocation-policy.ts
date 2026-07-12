import type { AgentInvocationIntentV1 } from '@agentbean/contracts';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('INVOCATION_INTENT_NON_FINITE_NUMBER');
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object') {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .filter((key) => record[key] !== undefined)
      .sort((left, right) => (left < right ? -1 : left > right ? 1 : 0))
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  throw new Error('INVOCATION_INTENT_UNSUPPORTED_VALUE');
}

export function canonicalizeAgentInvocationIntent(intent: AgentInvocationIntentV1): string {
  return canonicalJson(intent);
}

export interface ExistingInvocationIdempotencyRecord {
  readonly invocationId: string;
  readonly managementRunId: string;
  readonly idempotencyKey: string;
  readonly intentHash: string;
}

export interface ResolveInvocationIdempotencyInput {
  readonly existing?: ExistingInvocationIdempotencyRecord;
  readonly requestedManagementRunId: string;
  readonly requestedIdempotencyKey: string;
  readonly requestedIntentHash: string;
}

export type InvocationIdempotencyDecision =
  | { readonly kind: 'create' }
  | { readonly kind: 'existing'; readonly invocationId: string }
  | {
      readonly kind: 'conflict';
      readonly invocationId: string;
      readonly existingIntentHash: string;
      readonly requestedIntentHash: string;
    };

export function resolveInvocationIdempotency(
  input: ResolveInvocationIdempotencyInput,
): InvocationIdempotencyDecision {
  if (
    !input.existing
    || input.existing.managementRunId !== input.requestedManagementRunId
    || input.existing.idempotencyKey !== input.requestedIdempotencyKey
  ) {
    return { kind: 'create' };
  }
  if (input.existing.intentHash === input.requestedIntentHash) {
    return { kind: 'existing', invocationId: input.existing.invocationId };
  }
  return {
    kind: 'conflict',
    invocationId: input.existing.invocationId,
    existingIntentHash: input.existing.intentHash,
    requestedIntentHash: input.requestedIntentHash,
  };
}
