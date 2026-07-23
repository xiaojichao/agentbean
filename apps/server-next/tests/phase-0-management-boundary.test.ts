import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, test } from 'vitest';

import { AGENT_EVENTS, WEB_EVENTS } from '../../../packages/contracts/src/index.js';
import {
  createInMemoryRepositories,
  createServerNextUseCases,
} from '../src/index.js';
import type { CreateServerNextUseCasesInput } from '../src/application/usecases.js';

const serverRoot = fileURLToPath(new URL('../src', import.meta.url));

describe('Phase 0 existing execution fact boundary', () => {
  test('channel file index reads historical message attachments with stable cursor and visibility filters', async () => {
    const { app, repositories } = await createHarness(['user-1', 'team-1', 'channel-1', 'member-1', 'agent-1', 'device-1', 'artifact-id', 'message-id']);
    const channel = await repositories.channels.getDefaultChannel('team-1');
    expect(channel).not.toBeNull();
    const messages = [
      { id: 'message-old', createdAt: 100 },
      { id: 'message-new', createdAt: 200 },
      { id: 'message-deleted', createdAt: 300 },
    ];
    for (const message of messages) {
      await repositories.messages.append({
        id: message.id, teamId: 'team-1', channelId: channel!.id,
        senderKind: 'human', senderId: 'user-1', body: 'attachment', createdAt: message.createdAt,
        ...(message.id === 'message-new' ? { meta: { taskId: 'task-1' } } : {}),
        ...(message.id === 'message-deleted' ? { meta: { deletedAt: 301 } } : {}),
      });
    }
    await repositories.artifacts.create({
      id: 'artifact-old', teamId: 'team-1', channelId: channel!.id, messageId: 'message-old', uploaderId: 'user-1',
      filename: 'same-name.md', mimeType: 'text/markdown', sizeBytes: 1, createdAt: 100,
    });
    await repositories.artifacts.create({
      id: 'artifact-new', teamId: 'team-1', channelId: channel!.id, messageId: 'message-new', uploaderId: 'user-1',
      filename: 'same-name.md', mimeType: 'text/markdown', sizeBytes: 2, createdAt: 200,
    });
    await repositories.artifacts.create({
      id: 'artifact-deleted', teamId: 'team-1', channelId: channel!.id, messageId: 'message-deleted',
      workspaceRunId: 'run-1', uploaderId: 'user-1', role: 'attachment',
      filename: 'deleted.txt', mimeType: 'text/plain', sizeBytes: 1, createdAt: 300,
    });
    await repositories.artifacts.create({
      id: 'artifact-log', teamId: 'team-1', channelId: channel!.id, messageId: 'message-new', workspaceRunId: 'run-1', uploaderId: 'user-1',
      filename: 'workspace-run.log', mimeType: 'text/plain', sizeBytes: 1, relativePath: 'logs/workspace-run.log', createdAt: 400,
    });
    await repositories.workspaceRuns.create({
      id: 'run-1',
      teamId: 'team-1',
      channelId: channel!.id,
      messageId: 'message-new',
      dispatchId: 'dispatch-run-1',
      agentId: 'agent-1',
      status: 'succeeded',
      createdAt: 350,
      updatedAt: 350,
      artifactIds: ['artifact-run'],
    });
    await repositories.artifacts.create({
      id: 'artifact-run',
      teamId: 'team-1',
      channelId: channel!.id,
      workspaceRunId: 'run-1',
      dispatchId: 'dispatch-run-1',
      uploaderId: 'agent-1',
      filename: 'brief.md',
      mimeType: 'text/markdown',
      sizeBytes: 3,
      relativePath: 'reports/brief.md',
      role: 'run_output',
      sourceRoot: { id: 'root-default', kind: 'run_output', label: '默认运行输出' },
      createdAt: 350,
    });
    await expect(repositories.artifacts.listByChannel({
      teamId: 'team-1', channelId: channel!.id,
    })).resolves.toMatchObject([
      { id: 'artifact-log' },
      { id: 'artifact-run' },
      { id: 'artifact-deleted' },
      { id: 'artifact-new' },
      { id: 'artifact-old' },
    ]);

    const first = await app.listChannelFiles({ userId: 'user-1', teamId: 'team-1', channelId: channel!.id, pageSize: 1 });
    expect(first).toMatchObject({ ok: true, files: [{ artifact: { id: 'artifact-new' }, source: { messageId: 'message-new' } }] });
    expect(first.nextCursor).toBeTruthy();
    const second = await app.listChannelFiles({ userId: 'user-1', teamId: 'team-1', channelId: channel!.id, cursor: first.nextCursor, pageSize: 10 });
    expect(second).toMatchObject({ ok: true, files: [{ artifact: { id: 'artifact-old' } }] });
    expect(second.files).toHaveLength(1);
    await expect(app.searchChannelFiles({ userId: 'user-1', teamId: 'team-1', channelId: channel!.id, query: 'same-name' })).resolves.toMatchObject({
      ok: true, files: [{ artifact: { id: 'artifact-new' } }, { artifact: { id: 'artifact-old' } }],
    });
    const root = await app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: channel!.id,
    });
    expect(root).toMatchObject({
      ok: true,
      directories: [{ name: '运行产物', fileCount: 1 }],
    });
    const sourceRootPath = '运行产物/任务 task-1/Run run-1/默认运行输出 [root-default]';
    await expect(app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: channel!.id, path: sourceRootPath,
    })).resolves.toMatchObject({
      ok: true,
      files: [],
      directories: [{ name: 'reports', fileCount: 1 }],
    });
    await expect(app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: channel!.id, path: `${sourceRootPath}/reports`,
    })).resolves.toMatchObject({
      ok: true,
      files: [{
        artifact: { id: 'artifact-run', role: 'run_output', sourceRoot: { id: 'root-default' } },
        source: { messageId: 'message-new', taskId: 'task-1', workspaceRunId: 'run-1', agentId: 'agent-1' },
        logicalPath: `${sourceRootPath}/reports/brief.md`,
        role: 'run_output',
      }],
      directories: [],
    });
    await expect(app.searchChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: channel!.id, query: 'brief',
    })).resolves.toMatchObject({
      ok: true,
      files: [{ artifact: { id: 'artifact-run' }, logicalPath: `${sourceRootPath}/reports/brief.md` }],
    });
    await expect(app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: channel!.id, role: 'run_output',
    })).resolves.toMatchObject({
      ok: true,
      files: [],
      directories: [{ name: '运行产物', fileCount: 1 }],
    });
  });

  test('channel file index exposes a legacy Run artifact when the Workspace Run row is missing', async () => {
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'member-1', 'agent-1', 'device-1',
    ]);
    await repositories.artifacts.create({
      id: 'artifact-legacy-run',
      teamId: 'team-1',
      channelId: 'channel-1',
      workspaceRunId: 'missing-run',
      uploaderId: 'agent-1',
      filename: 'result.csv',
      mimeType: 'text/csv',
      sizeBytes: 3,
      relativePath: 'result.csv',
      role: 'run_output',
      sourceRoot: {
        id: 'legacy_run:missing-run',
        kind: 'legacy_run',
        label: '历史运行产物',
      },
      createdAt: 100,
    });

    await expect(app.listChannelFiles({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      path: '运行产物/未关联任务/Run missing-run/历史运行产物 [legacy_run:missing-run]',
    })).resolves.toMatchObject({
      ok: true,
      files: [{
        artifact: { id: 'artifact-legacy-run' },
        source: {
          workspaceRunId: 'missing-run',
          senderKind: 'system',
          senderId: null,
        },
      }],
    });
  });

  test('channel file index keeps an internal handoff artifact hidden when its Workspace Run row is missing', async () => {
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'member-1', 'agent-1', 'device-1',
    ]);
    await repositories.management.dispatchAttempts.create({
      id: 'attempt-internal',
      invocationId: 'invocation-internal',
      dispatchId: 'dispatch-internal',
      attemptNumber: 1,
      status: 'succeeded',
      startedAt: 50,
      completedAt: 60,
    });
    await repositories.management.handoffs.create({
      schemaVersion: 1,
      id: 'handoff-internal',
      managementRunId: 'management-run-1',
      invocationId: 'invocation-internal',
      intent: {
        schemaVersion: 1,
        managementRunId: 'management-run-1',
        toAgentId: 'agent-1',
        kind: 'consult',
        objective: 'internal consultation',
        reason: 'private sub-call',
        contextRefs: [],
        dependencyResults: [],
        acceptanceCriteria: [],
        attachmentIds: [],
        returnMode: 'return_to_manager',
      },
      intentHash: 'internal-hash',
      idempotencyKey: 'internal-handoff',
      status: 'returned',
      createdAt: 40,
      updatedAt: 60,
    });
    await repositories.artifacts.create({
      id: 'artifact-internal',
      teamId: 'team-1',
      channelId: 'channel-1',
      dispatchId: 'dispatch-internal',
      workspaceRunId: 'missing-internal-run',
      uploaderId: 'agent-1',
      filename: 'private.txt',
      mimeType: 'text/plain',
      sizeBytes: 3,
      relativePath: 'private.txt',
      role: 'run_output',
      sourceRoot: {
        id: 'legacy_run:missing-internal-run',
        kind: 'legacy_run',
        label: '历史运行产物',
      },
      createdAt: 100,
    });

    await expect(app.searchChannelFiles({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      query: 'private',
    })).resolves.toMatchObject({
      ok: true,
      files: [],
    });
  });

  test('in-memory channel artifact ordering matches SQLite binary id ordering', async () => {
    const repositories = createInMemoryRepositories();
    for (const id of ['artifact-!', 'artifact-B', 'artifact-a', 'artifact-\uE000', 'artifact-\u{10000}']) {
      await repositories.artifacts.create({
        id,
        teamId: 'team-1',
        channelId: 'channel-1',
        uploaderId: 'user-1',
        filename: `${id}.txt`,
        mimeType: 'text/plain',
        sizeBytes: 1,
        createdAt: 100,
      });
    }

    await expect(repositories.artifacts.listByChannel({
      teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject([
      { id: 'artifact-\u{10000}' },
      { id: 'artifact-\uE000' },
      { id: 'artifact-a' },
      { id: 'artifact-B' },
      { id: 'artifact-!' },
    ]);
  });

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
      management: { kind: 'direct', mode: 'direct' },
    });
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
      management: { kind: 'direct', mode: 'direct' },
    });
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
    const committedArtifactIds: string[] = [];
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1', 'result-message-1',
    ], {
      async onArtifactCommitted(artifact) {
        committedArtifactIds.push(artifact.id);
      },
      async resolveArtifactPreview(artifact) {
        return {
          status: 'ready',
          url: `/api/teams/${artifact.teamId}/artifacts/${artifact.id}/preview-derivative`,
        };
      },
    });
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
    expect(committedArtifactIds).toEqual(['artifact-1']);
    expect(artifact).not.toHaveProperty('invocationId');
    expect(workspaceRun).not.toHaveProperty('invocationId');
    await expect(app.listChannelFiles({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({
      ok: true,
      files: [],
      directories: [{ name: '运行产物', fileCount: 1 }],
    });
    await expect(app.listChannelFiles({
      userId: 'user-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      path: '运行产物/未关联任务/Run workspace-run-1/默认运行输出',
    })).resolves.toMatchObject({
      ok: true,
      files: [{
        artifact: {
          id: 'artifact-1',
          preview: { status: 'ready', url: '/api/teams/team-1/artifacts/artifact-1/preview-derivative' },
        },
        source: { messageId: 'result-message-1' },
      }],
    });
  });

  test('rejects unsafe source-root labels from dispatch results before persisting artifacts', async () => {
    const { app, repositories } = await createHarness([
      'user-1', 'team-1', 'channel-1', 'message-1', 'dispatch-1', 'request-1',
    ]);
    await app.sendMessage({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '@Codex generate output',
    });

    await expect(app.receiveDispatchResult({
      dispatchId: 'dispatch-1',
      agentId: 'agent-1',
      body: 'generated output',
      workspaceRun: { id: 'workspace-run-1', status: 'succeeded', exitCode: 0 },
      artifacts: [{
        id: 'artifact-unsafe',
        filename: 'result.txt',
        sourceRoot: { id: 'reports', kind: 'configured_output', label: '伪/目录' },
      }],
    })).resolves.toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
    });
    await expect(repositories.artifacts.getForTeam({
      teamId: 'team-1',
      artifactId: 'artifact-unsafe',
    })).resolves.toBeNull();
  });

  test('Worker transport stays isolated from existing Task and Dispatch APIs', () => {
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
    expect(agentHandlerSource).toContain('AGENT_EVENTS.managementWorker.register');
    expect(agentHandlerSource).toContain('safeParseManagementWorkerPayload');
    expect(agentHandlerSource).not.toMatch(/app,\s*'(?:registerManagementWorker|scheduleManagementRun)'/);
    expect(agentHandlerSource).not.toMatch(/app,\s*'(?:createTask|updateTask|deleteTask|reorderTask)'/);

    const repositories = createInMemoryRepositories();
    expect(Object.keys(repositories).filter((name) => /management|invocation|checkpoint/i.test(name))).toEqual([
      'management',
      'managementUnitOfWork',
      'managementDispatchUnitOfWork',
      'managementMemoryUnitOfWork',
    ]);

    const repositorySource = readFileSync(join(serverRoot, 'application/repositories.ts'), 'utf8');
    expect(repositorySource).toContain('management: ManagementRepositories');
    expect(repositorySource).toContain('managementUnitOfWork: ManagementUnitOfWork');
    expect(repositorySource).toContain('managementMemoryUnitOfWork: ManagementMemoryUnitOfWork');
    expect(repositorySource).toContain('managementDispatchUnitOfWork: ManagementDispatchUnitOfWork');

    const migrationSql = readTreeText(join(serverRoot, 'infra/sqlite/migrations'));
    expect(migrationSql).toMatch(/CREATE TABLE management_runs/i);
    expect(migrationSql).toMatch(/CREATE TABLE management_events/i);
    expect(migrationSql).toMatch(/CREATE TABLE agent_invocations/i);
    expect(migrationSql).toMatch(/CREATE TABLE management_checkpoints/i);

    const artifactContract = readFileSync(
      fileURLToPath(new URL('../../../packages/contracts/src/artifact.ts', import.meta.url)),
      'utf8',
    );
    expect(artifactContract).not.toMatch(/\b(?:invocationId|managementRunId)\b/);

    const serverSource = readTreeText(serverRoot);
    // Phase 0 仍禁止 Server 接入完整 PI Session / Worker Host。
    // PI MVP (#701/#703) 允许 Server 复用共享 OpenAI-compatible Adapter 做 Provider 生产同路径测试，
    // 因此不再 ban 包名 `pi-management-runtime` 与 adapter 符号。
    expect(serverSource).not.toMatch(
      /createManagementRuntimeFactory|ManagementRuntimeFactory|\bManagementSession\b|PiManagerWorkerHost|ManagementWorkerHost|\bManagementOutbox\b|pi-session-adapter/,
    );
    expect(serverSource).toMatch(/createOpenAiCompatibleManagementModelAdapter|pi-provider-production-test/);
  });
});

async function createHarness(
  ids: string[],
  options: Partial<Pick<CreateServerNextUseCasesInput, 'onArtifactCommitted' | 'resolveArtifactPreview'>> = {},
) {
  const repositories = createInMemoryRepositories();
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => 500 },
    ids: { nextId: createIds(ids) },
    messageIngestionMode: 'legacy',
    ...options,
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
