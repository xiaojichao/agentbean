import { describe, expect, test } from 'vitest';

import {
  evaluateContinuationOwnerTransition,
  resolveCollaborationIdempotency,
  wouldCreateContinuationLoop,
} from '../src/index.js';

describe('serial collaboration policy', () => {
  test('deduplicates the same proposal hash and conflicts on key reuse', () => {
    expect(resolveCollaborationIdempotency({ existing: {
      id: 'proposal-1', managementRunId: 'run-1', idempotencyKey: 'proposal-key', payloadHash: 'hash-a',
    }, requestedManagementRunId: 'run-1', requestedIdempotencyKey: 'proposal-key', requestedPayloadHash: 'hash-a' }))
      .toEqual({ kind: 'existing', id: 'proposal-1' });
    expect(resolveCollaborationIdempotency({ existing: {
      id: 'proposal-1', managementRunId: 'run-1', idempotencyKey: 'proposal-key', payloadHash: 'hash-a',
    }, requestedManagementRunId: 'run-1', requestedIdempotencyKey: 'proposal-key', requestedPayloadHash: 'hash-b' }))
      .toEqual({ kind: 'conflict', reason: 'payload-hash-mismatch' });
  });

  test('switches continuation owner only after accepted and rolls back terminal failure', () => {
    expect(evaluateContinuationOwnerTransition({ currentAgentId: 'agent-a', sourceAgentId: 'agent-a',
      targetAgentId: 'agent-b', status: 'requested', taskFenceCurrent: true }))
      .toEqual({ kind: 'unchanged' });
    expect(evaluateContinuationOwnerTransition({ currentAgentId: 'agent-a', sourceAgentId: 'agent-a',
      targetAgentId: 'agent-b', status: 'accepted', taskFenceCurrent: true }))
      .toEqual({ kind: 'changed', nextAgentId: 'agent-b', reasonCode: 'HANDOFF_ACCEPTED' });
    expect(evaluateContinuationOwnerTransition({ currentAgentId: 'agent-b', sourceAgentId: 'agent-a',
      targetAgentId: 'agent-b', status: 'failed', taskFenceCurrent: true }))
      .toEqual({ kind: 'changed', nextAgentId: 'agent-a', reasonCode: 'HANDOFF_FAILED_ROLLBACK' });
    expect(evaluateContinuationOwnerTransition({ currentAgentId: 'agent-a', sourceAgentId: 'agent-a',
      targetAgentId: 'agent-b', status: 'accepted', taskFenceCurrent: false }))
      .toEqual({ kind: 'unchanged' });
  });

  test('rejects an immediate continuation cycle while allowing consult return paths', () => {
    expect(wouldCreateContinuationLoop({ fromAgentId: 'agent-b', toAgentId: 'agent-a', priorEdges: [
      { fromAgentId: 'agent-a', toAgentId: 'agent-b', kind: 'continuation' },
    ] })).toBe(true);
    expect(wouldCreateContinuationLoop({ fromAgentId: 'agent-b', toAgentId: 'agent-a', priorEdges: [
      { fromAgentId: 'agent-a', toAgentId: 'agent-b', kind: 'consult' },
    ] })).toBe(false);
  });
});
