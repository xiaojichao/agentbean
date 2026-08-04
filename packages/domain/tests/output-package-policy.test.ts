import { describe, expect, test } from 'vitest';
import {
  evaluateOutputPackageFormation,
  type OutputPackageStagingSnapshot,
} from '../src/output-package-policy.js';

const staging = (overrides: Partial<OutputPackageStagingSnapshot> = {}): OutputPackageStagingSnapshot => ({
  status: 'committed',
  channelId: 'ch-1',
  committedRevisionId: 'rev-1',
  provenance: {
    agentId: 'agent-1',
    taskId: 'task-1',
    taskAttempt: 1,
    deviceId: 'dev-1',
    workspaceRunId: 'run-1',
  },
  ...overrides,
});

const files = [
  { path: 'docs/ep1.md', artifactId: 'art-1', filename: 'ep1.md', sizeBytes: 10, sha256: 'a' },
  { path: 'docs/ep2.md', artifactId: 'art-2', filename: 'ep2.md', sizeBytes: 20, sha256: 'b' },
] as const;

const baseInput = {
  teamId: 'team-1',
  channelId: 'ch-1',
  expectedWorkspaceRevisionId: 'rev-1',
  channel: { exists: true, archived: false },
  staging: staging(),
  revision: { id: 'rev-1', files },
  agentAuthorityOk: true,
  task: null,
  coordination: null,
  workspaceRun: null,
  invocation: null,
  claim: null,
} as const;

const managedFacts = {
  task: { id: 'task-1', teamId: 'team-1', channelId: 'ch-1', revision: 3 },
  coordination: { attempt: 1 },
  workspaceRun: { id: 'run-1', managementInvocationId: 'inv-1' },
  invocation: {
    id: 'inv-1',
    targetAgentId: 'agent-1',
    taskContext: { taskId: 'task-1', taskRevision: 3, taskAttempt: 1, claimLeaseId: 'lease-1' },
  },
  claim: { id: 'lease-1', taskRevision: 3, taskAttempt: 1, status: 'active' as const },
};

describe('evaluateOutputPackageFormation', () => {
  test('synthetic taskId → unmanaged package with frozen ordered members', () => {
    const decision = evaluateOutputPackageFormation(baseInput);
    expect(decision.kind).toBe('create');
    if (decision.kind !== 'create') return;
    expect(decision.plan.taskBinding).toBe('unmanaged');
    expect(decision.plan.taskRevision).toBeUndefined();
    expect(decision.plan.agentId).toBe('agent-1');
    expect(decision.plan.deviceId).toBe('dev-1');
    expect(decision.plan.members.map((m) => [m.sequence, m.shortLabel, m.collectionKey, m.artifactId])).toEqual([
      [1, 'F1', 'docs/ep1.md', 'art-1'],
      [2, 'F2', 'docs/ep2.md', 'art-2'],
    ]);
  });

  test('managed run with valid invocation+claim → managed lineage frozen', () => {
    const decision = evaluateOutputPackageFormation({ ...baseInput, ...managedFacts });
    expect(decision.kind).toBe('create');
    if (decision.kind !== 'create') return;
    expect(decision.plan.taskBinding).toBe('managed');
    expect(decision.plan.taskRevision).toBe(3);
    expect(decision.plan.invocationId).toBe('inv-1');
    expect(decision.plan.workspaceRunId).toBe('run-1');
    expect(decision.plan.claimLeaseId).toBe('lease-1');
  });

  test.each([
    ['open staging', { ...baseInput, staging: staging({ status: 'open', committedRevisionId: undefined }) }],
    ['failed staging', { ...baseInput, staging: staging({ status: 'failed', committedRevisionId: undefined }) }],
    ['missing staging', { ...baseInput, staging: null }],
    ['revision mismatch', { ...baseInput, expectedWorkspaceRevisionId: 'rev-2' }],
    ['missing revision row', { ...baseInput, revision: null }],
    ['channel mismatch', { ...baseInput, staging: staging({ channelId: 'ch-2' }) }],
  ])('rejects workspace-revision-not-committed: %s', (_label, input) => {
    expect(evaluateOutputPackageFormation(input)).toEqual({
      kind: 'rejected', reasonCode: 'workspace-revision-not-committed',
    });
  });

  test('rejects incomplete-delivery: empty files', () => {
    expect(evaluateOutputPackageFormation({ ...baseInput, revision: { id: 'rev-1', files: [] } })).toEqual({
      kind: 'rejected', reasonCode: 'incomplete-delivery',
    });
  });

  test('rejects incomplete-delivery: file without artifactId', () => {
    const bad = [{ path: 'a.md', filename: 'a.md', sizeBytes: 1 }];
    expect(evaluateOutputPackageFormation({ ...baseInput, revision: { id: 'rev-1', files: bad } })).toEqual({
      kind: 'rejected', reasonCode: 'incomplete-delivery',
    });
  });

  test('rejects incomplete-delivery: missing provenance', () => {
    expect(evaluateOutputPackageFormation({ ...baseInput, staging: staging({ provenance: undefined }) })).toEqual({
      kind: 'rejected', reasonCode: 'incomplete-delivery',
    });
  });

  test('rejects duplicate-manifest-entry: same collection path twice in one delivery', () => {
    const dup = [
      { path: 'docs/ep1.md', artifactId: 'art-1', filename: 'ep1.md', sizeBytes: 10 },
      { path: 'docs/ep1.md', artifactId: 'art-3', filename: 'ep1.md', sizeBytes: 12 },
    ];
    expect(evaluateOutputPackageFormation({ ...baseInput, revision: { id: 'rev-1', files: dup } })).toEqual({
      kind: 'rejected', reasonCode: 'duplicate-manifest-entry',
    });
  });

  test('rejects agent-authority-revoked', () => {
    expect(evaluateOutputPackageFormation({ ...baseInput, agentAuthorityOk: false })).toEqual({
      kind: 'rejected', reasonCode: 'agent-authority-revoked',
    });
  });

  test('rejects channel-archived / channel-not-found', () => {
    expect(evaluateOutputPackageFormation({ ...baseInput, channel: { exists: true, archived: true } })).toEqual({
      kind: 'rejected', reasonCode: 'channel-archived',
    });
    expect(evaluateOutputPackageFormation({ ...baseInput, channel: { exists: false, archived: false } })).toEqual({
      kind: 'rejected', reasonCode: 'channel-not-found',
    });
  });

  test('rejects task-authority-mismatch: task of another team or channel', () => {
    expect(evaluateOutputPackageFormation({
      ...baseInput, task: { id: 'task-1', teamId: 'team-2', revision: 1 },
    })).toEqual({ kind: 'rejected', reasonCode: 'task-authority-mismatch' });
    expect(evaluateOutputPackageFormation({
      ...baseInput, task: { id: 'task-1', teamId: 'team-1', channelId: 'ch-9', revision: 1 },
    })).toEqual({ kind: 'rejected', reasonCode: 'task-authority-mismatch' });
  });

  test('rejects task-attempt-superseded: coordination attempt moved on', () => {
    expect(evaluateOutputPackageFormation({
      ...baseInput, ...managedFacts, coordination: { attempt: 2 },
    })).toEqual({ kind: 'rejected', reasonCode: 'task-attempt-superseded' });
  });

  test('rejects task-attempt-superseded: task revision drifted past invocation intent', () => {
    expect(evaluateOutputPackageFormation({
      ...baseInput, ...managedFacts,
      task: { id: 'task-1', teamId: 'team-1', channelId: 'ch-1', revision: 4 },
    })).toEqual({ kind: 'rejected', reasonCode: 'task-attempt-superseded' });
  });

  test.each([
    ['run missing', { workspaceRun: null, invocation: null, claim: null }],
    ['invocation missing', { invocation: null, claim: null }],
    ['invocation targets another agent', {
      invocation: { ...managedFacts.invocation, targetAgentId: 'agent-2' }, claim: managedFacts.claim,
    }],
    ['invocation context of another task', {
      invocation: {
        ...managedFacts.invocation,
        taskContext: { ...managedFacts.invocation.taskContext, taskId: 'task-2' },
      },
      claim: managedFacts.claim,
    }],
    ['invocation attempt mismatch', {
      invocation: {
        ...managedFacts.invocation,
        taskContext: { ...managedFacts.invocation.taskContext, taskAttempt: 2 },
      },
      claim: managedFacts.claim,
    }],
  ])('rejects invocation-mismatch: %s', (_label, overrides) => {
    expect(evaluateOutputPackageFormation({ ...baseInput, ...managedFacts, ...overrides })).toEqual({
      kind: 'rejected', reasonCode: 'invocation-mismatch',
    });
  });

  test.each([
    ['claim missing', { claim: null }],
    ['claim invalidated', { claim: { ...managedFacts.claim, status: 'invalidated' as const } }],
    ['claim expired', { claim: { ...managedFacts.claim, status: 'expired' as const } }],
  ])('rejects claim-inactive: %s', (_label, overrides) => {
    expect(evaluateOutputPackageFormation({ ...baseInput, ...managedFacts, ...overrides })).toEqual({
      kind: 'rejected', reasonCode: 'claim-inactive',
    });
  });

  test('released claim (normal completion within same attempt) still forms package', () => {
    const decision = evaluateOutputPackageFormation({
      ...baseInput, ...managedFacts,
      claim: { ...managedFacts.claim, status: 'released' as const },
    });
    expect(decision.kind).toBe('create');
  });

  test('managed coordination without workspaceRunId binds current revision only', () => {
    const decision = evaluateOutputPackageFormation({
      ...baseInput,
      staging: staging({ provenance: { agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1 } }),
      task: managedFacts.task,
      coordination: managedFacts.coordination,
    });
    expect(decision.kind).toBe('create');
    if (decision.kind !== 'create') return;
    expect(decision.plan.taskBinding).toBe('managed');
    expect(decision.plan.taskRevision).toBe(3);
    expect(decision.plan.invocationId).toBeUndefined();
    expect(decision.plan.claimLeaseId).toBeUndefined();
  });

  test('plain task (no coordination) binds current revision', () => {
    const decision = evaluateOutputPackageFormation({
      ...baseInput,
      task: { id: 'task-1', teamId: 'team-1', channelId: 'ch-1', revision: 7 },
    });
    expect(decision.kind).toBe('create');
    if (decision.kind !== 'create') return;
    expect(decision.plan.taskBinding).toBe('managed');
    expect(decision.plan.taskRevision).toBe(7);
  });
});
