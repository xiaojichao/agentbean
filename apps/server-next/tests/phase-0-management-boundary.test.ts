import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createInMemoryRepositories,
  createServerNextUseCases,
} from '../src/index.js';

const serverRoot = fileURLToPath(new URL('../src', import.meta.url));

describe('Phase 0 existing execution fact boundary', () => {
  test('direct channel and DM messages create only canonical Dispatch records', async () => {
    const channel = await createHarness([
      'user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1',
    ]);
    const channelAck = await channel.app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex handle this',
    });
    expect(channelAck).toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1', status: 'queued' }],
    });
    expect(Object.keys(channelAck).filter((key) => /management|invocation/i.test(key))).toEqual([]);
    await expect(channel.repositories.dispatches.listByMessage('message-1')).resolves.toMatchObject([
      { id: 'dispatch-1', requestId: 'request-1' },
    ]);

    const dm = await createHarness([
      'user-1', 'team-1', 'channel-1', 'dm-1', 'message-1', 'dispatch-1', 'request-1',
    ]);
    await expect(dm.app.startDirectMessage({
      userId: 'user-1', teamId: 'team-1', agentId: 'agent-1',
    })).resolves.toMatchObject({ ok: true, dm: { channel: { id: 'dm-1' } } });
    const dmAck = await dm.app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'dm-1', body: 'handle this',
    });
    expect(dmAck).toMatchObject({
      ok: true,
      dispatches: [{ id: 'dispatch-1', messageId: 'message-1', status: 'queued' }],
    });
    expect(Object.keys(dmAck).filter((key) => /management|invocation/i.test(key))).toEqual([]);
    await expect(dm.repositories.dispatches.listByMessage('message-1')).resolves.toHaveLength(1);
  });

  test('message dispatch status is projected from the Dispatch repository at read time', async () => {
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1',
    ]);
    await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex handle this',
    });

    const [storedMessage] = await repositories.messages.listByChannel('channel-1', 10);
    expect(storedMessage).not.toHaveProperty('dispatchId');
    expect(storedMessage).not.toHaveProperty('dispatchStatus');

    await expect(app.acceptDispatch({
      dispatchId: 'dispatch-1', agentId: 'agent-1', quietWindowMs: 0,
    })).resolves.toMatchObject({ ok: true, dispatch: { id: 'dispatch-1', status: 'accepted' } });
    await expect(app.listChannelMessages({ channelId: 'channel-1', limit: 10 })).resolves.toMatchObject({
      ok: true,
      messages: [{ id: 'message-1', dispatchId: 'dispatch-1', dispatchStatus: 'accepted' }],
    });
  });

  test('agent delivery moves a linked Task to in_review and only a human update completes it', async () => {
    const { app } = await createHarness([
      'user-1', 'team-1', 'channel-1',
      'message-1', 'task-1', 'dispatch-1', 'request-1', 'ack-message-1',
      'result-message-1', 'status-message-1',
    ]);
    await app.sendMessage({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      body: '@Codex implement this',
      asTask: true,
    });

    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1', agentId: 'agent-1', body: 'delivery ready for review',
    })).resolves.toMatchObject({ ok: true, task: { id: 'task-1', status: 'in_review' } });
    await expect(app.updateTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1', status: 'done',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-1', status: 'done' },
      message: { senderKind: 'system', meta: { previousStatus: 'in_review', status: 'done' } },
    });
    await expect(app.deleteTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({ ok: true, task: { id: 'task-1', status: 'done' } });
    await expect(app.listTasks({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: true, tasks: [] });
  });

  test('the existing Task create, update, and delete APIs keep their human-owned lifecycle', async () => {
    const { app } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'task-1', 'status-message-1', 'status-message-2',
    ]);
    await expect(app.createTask({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', title: 'Review this work',
    })).resolves.toMatchObject({
      ok: true,
      task: { id: 'task-1', creatorId: 'user-1', status: 'todo' },
    });
    await expect(app.updateTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1', status: 'in_review',
    })).resolves.toMatchObject({ ok: true, task: { id: 'task-1', status: 'in_review' } });
    await expect(app.updateTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1', status: 'done',
    })).resolves.toMatchObject({ ok: true, task: { id: 'task-1', status: 'done' } });
    await expect(app.deleteTask({
      userId: 'user-1', teamId: 'team-1', taskId: 'task-1',
    })).resolves.toMatchObject({ ok: true, task: { id: 'task-1', status: 'done' } });
  });

  test('Artifact and Workspace Run records remain linked by dispatchId without invocationId', async () => {
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1', 'result-message-1',
    ]);
    await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex generate output',
    });
    await app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'generated output',
      workspaceRun: { id: 'workspace-run-1', status: 'succeeded', exitCode: 0 },
      artifacts: [{
        id: 'artifact-1', filename: 'result.txt', mimeType: 'text/plain', sizeBytes: 6,
      }],
    });

    const artifact = await repositories.artifacts.getForTeam({ teamId: 'team-1', artifactId: 'artifact-1' });
    const workspaceRun = await repositories.workspaceRuns.getForTeam({
      teamId: 'team-1', runId: 'workspace-run-1',
    });
    expect(artifact).toMatchObject({
      id: 'artifact-1', dispatchId: 'dispatch-1', workspaceRunId: 'workspace-run-1',
    });
    expect(workspaceRun).toMatchObject({ id: 'workspace-run-1', dispatchId: 'dispatch-1' });
    expect(artifact).not.toHaveProperty('invocationId');
    expect(workspaceRun).not.toHaveProperty('invocationId');
  });

  test('Worker contracts remain inert until Server handlers, repositories, and migrations are implemented', () => {
    expect(AGENT_EVENTS.managementWorker).toEqual({
      register: 'management-worker:register',
      leaseOffer: 'management-worker:lease-offer',
      leaseAcquire: 'management-worker:lease-acquire',
      leaseRenew: 'management-worker:lease-renew',
      leaseRelease: 'management-worker:lease-release',
      abort: 'management-worker:abort',
      toolRequest: 'management-worker:tool-request',
      checkpointFetch: 'management-worker:checkpoint-fetch',
      outboxReplay: 'management-worker:outbox-replay',
      shadowEvaluate: 'management-worker:shadow-evaluate',
      shadowResult: 'management-worker:shadow-result',
    });
    expect(collectLeafStrings(AGENT_EVENTS).filter((name) => /(?:^|:)task(?::|$)/.test(name))).toEqual([]);

    const socketHandlerSource = readFileSync(join(serverRoot, 'transport/socket-handlers.ts'), 'utf8');
    const agentHandlerSource = socketHandlerSource.slice(
      socketHandlerSource.indexOf('export function registerAgentSocketHandlers'),
    );
    expect(agentHandlerSource).not.toContain('AGENT_EVENTS.managementWorker');
    expect(agentHandlerSource).not.toMatch(/app,\s*'(?:createTask|updateTask|deleteTask|reorderTask)'/);

    const repositories = createInMemoryRepositories();
    expect(Object.keys(repositories).filter((name) => /management|invocation|checkpoint/i.test(name))).toEqual([]);

    const repositorySource = readFileSync(join(serverRoot, 'application/repositories.ts'), 'utf8');
    expect(repositorySource).not.toMatch(
      /\b(?:Management(?:Run|Event|Checkpoint)?|AgentInvocation|Invocation)Repository\b|\b(?:managementRuns?|managementEvents?|agentInvocations?|invocations?|managementCheckpoints?|checkpoints?)\s*:/,
    );

    const migrationSql = readTreeText(join(serverRoot, 'infra/sqlite/migrations'));
    expect(migrationSql).not.toMatch(
      /\b(?:management_runs?|management_events?|agent_invocations?|management_checkpoints?|invocation_id|management_run_id)\b/i,
    );

    const artifactContract = readFileSync(
      fileURLToPath(new URL('../../../packages/contracts/src/artifact.ts', import.meta.url)),
      'utf8',
    );
    expect(artifactContract).not.toMatch(/\b(?:invocationId|managementRunId)\b/);

    const serverSource = readTreeText(serverRoot);
    expect(serverSource).not.toMatch(
      /pi-management-runtime|createManagementRuntimeFactory|ManagementRuntimeFactory|ManagementSession|PiManagerWorkerHost|ManagementWorkerHost|ManagementOutbox/,
    );
  });
});

async function createHarness(ids: string[]) {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 500 },
    ids: { nextId: createIds(ids) },
  });
  await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
  await app.registerAgent({
    id: 'agent-1',
    primaryTeamId: 'team-1',
    visibleTeamIds: ['team-1'],
    channelIds: ['channel-1'],
    name: 'Codex',
    adapterKind: 'codex',
    category: 'agentos-hosted',
    source: 'scanned',
    status: 'online',
    deviceId: 'device-1',
    lastSeenAt: 500,
  });
  return { app, repositories };
}

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

function collectLeafStrings(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (!value || typeof value !== 'object') return [];
  return Object.values(value).flatMap(collectLeafStrings);
}

function readTreeText(root: string): string {
  return readdirSync(root, { withFileTypes: true })
    .flatMap((entry) => {
      const path = join(root, entry.name);
      return `${entry.name}\n${entry.isDirectory() ? readTreeText(path) : readFileSync(path, 'utf8')}`;
    })
    .join('\n');
}
