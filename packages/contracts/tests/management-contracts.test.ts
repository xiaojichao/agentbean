import { resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import type {
  AgentInvocationIntentV1,
  DispatchDto,
  ManagementEventV1,
  MemoryCapsuleRefDto,
  TaskDto,
  TaskCoordinationDto,
  ManagementCheckpointV1,
  ManagementRunDto,
  ManagementRunV2Dto,
  TeamManagementPolicyV2Dto,
} from '../src/index.js';

const packageRoot = fileURLToPath(new URL('..', import.meta.url));
const tsc = resolve(packageRoot, '..', '..', 'node_modules', '.bin', 'tsc');

function compileFixture(path: string) {
  const build = spawnSync(tsc, ['-p', 'tsconfig.json'], { cwd: packageRoot, encoding: 'utf8' });
  expect(build.status, `${build.stdout}${build.stderr}`).toBe(0);
  return spawnSync(tsc, [
    '--noEmit', '--module', 'NodeNext', '--moduleResolution', 'NodeNext',
    '--target', 'ES2022', '--strict', '--skipLibCheck', path,
  ], { cwd: packageRoot, encoding: 'utf8' });
}

describe('Phase 0 management contracts', () => {
  test('freezes explicit Phase 2 Run and Team rollout policy contracts', () => {
    const policy: TeamManagementPolicyV2Dto = {
      schemaVersion: 2,
      teamId: 'team-1',
      mode: 'managed',
      maxManagementPhase: 2,
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      updatedBy: 'user-1',
      updatedAt: 1,
    };
    const run: ManagementRunV2Dto = {
      schemaVersion: 2,
      managementPhase: 2,
      id: 'run-2',
      teamId: 'team-1',
      channelId: 'channel-1',
      rootTaskId: 'task-root',
      rootMessageId: 'message-1',
      mode: 'managed',
      status: 'queued',
      placementPolicy: policy.placementPolicy,
      checkpointRevision: 0,
      budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: 1,
      updatedAt: 1,
    };
    expect(policy.maxManagementPhase).toBe(2);
    expect(run.frozenTarget).toBeUndefined();
  });

  test('requires a root Task for every Phase 2 Run', () => {
    const result = compileFixture('tests/fixtures/management-run-v2-forbidden.ts');
    expect(result.status).not.toBe(0);
    expect(`${result.stdout}${result.stderr}`).toContain('rootTaskId');
  });

  test('exports ManagementRun and checkpoint through public declarations', () => {
    const result = compileFixture('tests/fixtures/management-contracts-valid.ts');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
  });

  test('keeps PI SDK imports out of every public declaration', () => {
    const result = compileFixture('tests/fixtures/management-contracts-valid.ts');
    expect(result.status, `${result.stdout}${result.stderr}`).toBe(0);
    const declarationFiles = readdirSync(resolve(packageRoot, 'dist'))
      .filter((file) => file.endsWith('.d.ts'));
    expect(declarationFiles.length).toBeGreaterThan(0);
    for (const file of declarationFiles) {
      expect(readFileSync(resolve(packageRoot, 'dist', file), 'utf8')).not.toContain('@earendil-works');
    }
  });

  test('rejects sensitive event fields and mutation of immutable Invocation intent', () => {
    const result = compileFixture('tests/fixtures/management-contracts-forbidden.ts');
    expect(result.status).not.toBe(0);
    const diagnostics = `${result.stdout}${result.stderr}`;
    for (const forbidden of [
      'direct', 'shadow', 'prompt', 'secret', 'token', 'reasoning', 'absolutePath', 'sourceCode', 'rawLog',
      'memoryContent',
    ]) {
      expect(diagnostics).toContain(forbidden);
    }
    expect(diagnostics).toMatch(/Record<string, unknown>|read-only property/);
  });

  test('freezes a versioned ManagementRun and separates checkpoint facts from context hints', () => {
    const run: ManagementRunDto = {
      schemaVersion: 1,
      id: 'run-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      rootMessageId: 'message-1',
      rootTaskId: 'task-root',
      mode: 'managed',
      status: 'running',
      placementPolicy: {
        placement: 'device',
        allowedDeviceIds: ['device-1'],
        allowServerContext: false,
        requireLocalModelCredentials: true,
      },
      checkpointRevision: 3,
      budget: {
        maxSubtasks: 20,
        maxDepth: 3,
        maxExternalInvocations: 40,
      },
      createdAt: 100,
      updatedAt: 120,
    };
    const checkpoint: ManagementCheckpointV1 = {
      schemaVersion: 1,
      managementRunId: run.id,
      revision: 3,
      authoritative: {
        lastEventSequence: 12,
        taskGraphRevision: 4,
        openTaskIds: ['task-2'],
        waitingInvocationIds: ['invocation-2'],
        completedInvocationIds: ['invocation-1'],
        memoryCapsuleIds: ['capsule-1'],
      },
      contextHints: {
        objective: 'Coordinate the requested work',
        planSummary: 'Wait for the second invocation',
        completedInvocationSummaries: [{ invocationId: 'invocation-1', summary: 'Evidence ready' }],
        unresolvedQuestions: [],
        nextAction: 'Wait',
      },
      updatedAt: 120,
    };

    expect(run.schemaVersion).toBe(1);
    expect(checkpoint.authoritative).not.toHaveProperty('objective');
    expect(checkpoint.contextHints).not.toHaveProperty('taskGraphRevision');
  });

  test('keeps Task coordination separate and Invocation intent immutable by contract', () => {
    const coordination: TaskCoordinationDto = {
      schemaVersion: 1,
      managementRunId: 'run-1',
      nodeKind: 'subtask',
      reviewPolicy: 'manager',
      claimPolicy: 'open',
      requiredCapabilities: ['research'],
      acceptanceCriteria: [],
      dependencyTaskIds: [],
      attempt: 1,
      maxAttempts: 2,
    };
    const intent: AgentInvocationIntentV1 = {
      schemaVersion: 1,
      teamId: 'team-1',
      channelId: 'channel-1',
      targetAgentId: 'agent-1',
      targetKind: 'agentos-hosted',
      objective: 'Research the question',
      acceptanceCriteria: [],
      dependencyResults: [],
      attachmentIds: [],
    };

    expect(coordination.managementRunId).toBe('run-1');
    expect(intent).not.toHaveProperty('status');
    expect(intent).not.toHaveProperty('dispatchAttempts');
  });

  test('uses discriminated event payloads and reference-only Memory records without changing legacy DTOs', () => {
    const event: ManagementEventV1 = {
      schemaVersion: 1,
      id: 'event-1',
      managementRunId: 'run-1',
      sequence: 2,
      type: 'checkpoint-updated',
      actorKind: 'manager',
      actorId: 'worker-1',
      idempotencyKey: 'checkpoint-2',
      payload: { checkpointRevision: 2, lastEventSequence: 1 },
      createdAt: 2,
    };
    const capsule: MemoryCapsuleRefDto = {
      schemaVersion: 1,
      id: 'capsule-1',
      teamId: 'team-1',
      managementRunId: 'run-1',
      targetAgentId: 'agent-1',
      contentHash: 'sha256:capsule',
      authorizationDecisionId: 'decision-1',
      expiresAt: 10,
    };
    const task: TaskDto = {
      id: 'task-legacy', teamId: 'team-1', title: 'Legacy', status: 'todo', creatorId: 'user-1',
      tags: [], sortOrder: 0, createdAt: 1, updatedAt: 1,
    };
    const dispatch: DispatchDto = {
      id: 'dispatch-legacy', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', status: 'queued', requestId: 'request-1', createdAt: 1, updatedAt: 1,
    };

    expect(event.payload).toEqual({ checkpointRevision: 2, lastEventSequence: 1 });
    expect(capsule).not.toHaveProperty('content');
    expect(task).not.toHaveProperty('managementRunId');
    expect(dispatch).not.toHaveProperty('invocationId');
  });
});
