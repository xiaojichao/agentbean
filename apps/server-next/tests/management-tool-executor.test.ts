import { describe, expect, test } from 'vitest';
import { createManagementKernel } from '../src/application/management/management-kernel.js';
import { createManagementToolExecutor } from '../src/application/management/management-tool-executor.js';
import { createInMemoryManagementPersistence } from '../src/infra/memory/management-repositories.js';

describe('management tool executor', () => {
  test('allows wired reads but fences writes before reporting later-task handlers unavailable', async () => {
    const persistence = createInMemoryManagementPersistence();
    let id = 0;
    const kernel = createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => `id-${++id}` } });
    const { run } = await kernel.createOrResumeRun({
      teamId: 'team-1', channelId: 'channel-1', rootMessageId: 'message-1', requestKey: 'request-1', requestHash: 'hash-1',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true }, budget: { maxSubtasks: 2, maxDepth: 1, maxExternalInvocations: 2 },
    });
    await kernel.acquireLease({ managementRunId: run.id, workerId: 'worker-1', host: { deviceId: 'device-1', profileId: 'profile-1' }, leaseToken: 'token', ttlMs: 100 });
    const execute = createManagementToolExecutor({
      kernel,
      handlers: {
        'context.get_management_state': async () => ({ status: 'running', checkpointRevision: 0, lastEventSequence: 2 }),
      },
    });

    await expect(execute({ schemaVersion: 1, commandId: 'command-read', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-read', toolName: 'context.get_management_state', input: {} })).resolves.toMatchObject({ ok: true, output: { lastEventSequence: 2 } });
    await expect(execute({ schemaVersion: 1, commandId: 'command-write', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-write', toolName: 'agents.invoke', input: { objective: 'do work', attachmentIds: [] }, leaseToken: 'token', fencingToken: 1, idempotencyKey: 'invoke-1' })).resolves.toMatchObject({ ok: false, errorCode: 'UNAVAILABLE', diagnosticCode: 'TOOL_NOT_WIRED' });
    await expect(execute({ schemaVersion: 1, commandId: 'command-stale', managementRunId: run.id, workerId: 'worker-1', toolCallId: 'tool-stale', toolName: 'agents.invoke', input: { objective: 'do work', attachmentIds: [] }, leaseToken: 'token', fencingToken: 2, idempotencyKey: 'invoke-2' })).resolves.toMatchObject({ ok: false, errorCode: 'NOT_AUTHORIZED', diagnosticCode: 'LEASE_FUTURE_FENCING_TOKEN' });
  });

  test('does not echo arbitrary handler errors through client diagnostics', async () => {
    const persistence = createInMemoryManagementPersistence();
    const kernel = createManagementKernel({ ...persistence, clock: { now: () => 10 }, ids: { nextId: () => 'unused' } });
    const execute = createManagementToolExecutor({ kernel, handlers: { 'context.get_root_message': async () => { throw new Error('provider secret sk-live-123'); } } });
    const result = await execute({ schemaVersion: 1, commandId: 'command-1', managementRunId: 'run-1', workerId: 'worker-1', toolCallId: 'tool-1', toolName: 'context.get_root_message', input: {} });
    expect(result).toMatchObject({ ok: false, diagnosticCode: 'TOOL_EXECUTION_FAILED' });
    expect(JSON.stringify(result)).not.toContain('sk-live-123');
  });
});
