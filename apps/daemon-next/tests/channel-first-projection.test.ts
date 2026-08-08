import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test, vi } from 'vitest';
import { AGENT_EVENTS } from '../../../packages/contracts/src/index.js';
import { createDaemonProtocolClient, type DaemonProtocolSocket } from '../src/index';
import {
  discoverRecoverableChannelWorkspaceRuns,
  persistDeviceProjectionManifest,
  prepareChannelWorkspaceRun,
} from '../src/workspace-run';

function tempDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function fakeSocket(): {
  socket: DaemonProtocolSocket;
  emits: Array<{ event: string; payload: unknown }>;
  deliver(event: string, payload: unknown): Promise<void>;
} {
  const emits: Array<{ event: string; payload: unknown }> = [];
  const handlers = new Map<string, Array<(payload: unknown) => Promise<void>>>();
  const socket: DaemonProtocolSocket = {
    connected: true,
    async emitWithAck(event, payload) {
      emits.push({ event, payload });
      if (event === AGENT_EVENTS.device.hello) return { device: { id: 'device-current' } };
      return { ok: true };
    },
    on(event, handler) {
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  return {
    socket,
    emits,
    async deliver(event, payload) {
      for (const handler of handlers.get(event) ?? []) await handler(payload);
    },
  };
}

describe('Channel-first Device Workspace Projection', () => {
  test('creates the frozen Team → Channel → Agent → Task attempt → WorkspaceRun hierarchy', () => {
    const home = tempDir('channel-first-home-');
    const ws = prepareChannelWorkspaceRun({
      agentBeanHome: home,
      deviceId: 'device-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 2,
      workspaceRunId: 'workspace-run-1',
      workspaceRevisionId: 'revision-7',
    });
    expect(ws.runDir).toBe(join(home, 'workspaces', 'team-1', 'channels', 'channel-1', 'runs', 'agent-1', 'task-1', '2', 'workspace-run-1'));
    expect(ws.inputDir).toBe(join(ws.runDir, 'inputs'));
    expect(existsSync(join(home, 'workspaces', 'team-1', 'channels', 'channel-1', 'snapshots', 'revision-7', 'manifest.json'))).toBe(true);
  });

  test('rejects traversal and symlink escapes before creating a run', () => {
    const home = tempDir('channel-first-safe-');
    expect(() => prepareChannelWorkspaceRun({
      agentBeanHome: home,
      deviceId: 'device-1',
      teamId: '../outside',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'run-1',
    })).toThrow('WORKSPACE_PROJECTION_INVALID_TEAMID');

    const outside = tempDir('channel-first-outside-');
    const channels = join(home, 'workspaces', 'team-1');
    mkdirSync(channels, { recursive: true });
    symlinkSync(outside, join(channels, 'channels'));
    expect(() => prepareChannelWorkspaceRun({
      agentBeanHome: home,
      deviceId: 'device-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'run-1',
    })).toThrow('WORKSPACE_PROJECTION_SYMLINK_ESCAPE');
    expect(lstatSync(outside).isDirectory()).toBe(true);
  });

  test('only the canonical device can recover channel runs', () => {
    const home = tempDir('channel-first-recovery-');
    persistDeviceProjectionManifest(home, {
      schemaVersion: 1,
      deviceId: 'device-current',
      teamId: 'team-1',
      updatedAt: 1,
    });
    const ws = prepareChannelWorkspaceRun({
      agentBeanHome: home,
      deviceId: 'device-old',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'run-1',
    });
    writeFileSync(ws.responsePath, 'old reply');
    writeFileSync(ws.manifestPath, JSON.stringify({
      schemaVersion: 1,
      runId: 'run-1',
      deviceId: 'device-old',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      status: 'succeeded',
      files: [],
    }));
    expect(discoverRecoverableChannelWorkspaceRuns({ agentBeanHome: home, deviceId: 'device-current' })).toEqual([]);
    expect(JSON.parse(readFileSync(join(home, 'device.json'), 'utf8')).deviceId).toBe('device-current');
  });

  test('recovered workspaceRun preserves the live result field order for fingerprint replay', () => {
    // #1146：Server fingerprint 目前按 JSON 字节计算。恢复载荷必须复现实时回报的
    // 稳定字段顺序，否则字段和值完全相同也会被误判为 CONFLICT。
    const home = tempDir('channel-first-fingerprint-recovery-');
    persistDeviceProjectionManifest(home, {
      schemaVersion: 1,
      deviceId: 'device-current',
      teamId: 'team-1',
      updatedAt: 1,
    });
    const ws = prepareChannelWorkspaceRun({
      agentBeanHome: home,
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'run-1',
    });
    writeFileSync(ws.responsePath, 'recovered reply');
    writeFileSync(ws.manifestPath, JSON.stringify({
      schemaVersion: 1,
      runId: 'run-1',
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      status: 'succeeded',
      cwd: '.',
      command: 'agent --run',
      logExcerpt: 'done',
      exitCode: 0,
      startedAt: 100,
      completedAt: 200,
      publishId: 'publish-1',
      files: [],
    }));

    const [recovered] = discoverRecoverableChannelWorkspaceRuns({
      agentBeanHome: home,
      deviceId: 'device-current',
    });

    expect(Object.keys(recovered!.workspaceRun)).toEqual([
      'status',
      'cwd',
      'command',
      'exitCode',
      'startedAt',
      'completedAt',
      'logExcerpt',
      'publishId',
    ]);
  });

  test('dispatch executes with managed env and reports relative provenance', async () => {
    const home = tempDir('channel-first-dispatch-home-');
    const customCwd = tempDir('channel-first-custom-cwd-');
    const harness = fakeSocket();
    let env: Record<string, string> | undefined;
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      homeDir: home,
      executor: async (request) => {
        env = request.customAgent?.env;
        writeFileSync(join(request.customAgent?.env?.AGENTBEAN_OUTPUT_DIR ?? '', 'answer.md'), 'done');
        return {
          body: 'done',
          workspaceRun: {
            status: 'succeeded', cwd: customCwd, logExcerpt: `${customCwd}/secret.txt`, startedAt: 1, completedAt: 2,
          },
        };
      },
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-1', requestId: 'request-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', taskId: 'task-1', taskAttempt: 3, workspaceRunId: 'workspace-run-1',
      workspaceRevisionId: 'revision-1', prompt: 'run', customAgent: { adapterKind: 'codex', command: 'codex', cwd: customCwd },
    });

    const expectedRun = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'runs', 'agent-1', 'task-1', '3', 'workspace-run-1');
    expect(env?.AGENTBEAN_WORKSPACE).toBe(expectedRun);
    expect(env?.AGENTBEAN_INPUT_DIR).toBe(join(expectedRun, 'inputs'));
    expect(existsSync(join(expectedRun, 'outputs', 'answer.md'))).toBe(true);
    expect(existsSync(join(customCwd, '.agentbean', 'runs'))).toBe(false);
    const manifest = JSON.parse(readFileSync(join(expectedRun, 'manifest.json'), 'utf8')) as { cwd?: string; deviceId?: string; taskAttempt?: number; provenance?: Array<{ relativePath: string }> };
    expect(manifest).toMatchObject({ cwd: '.', deviceId: 'device-current', taskAttempt: 3 });
    expect(manifest.provenance).toEqual(expect.arrayContaining([expect.objectContaining({ relativePath: 'answer.md' })]));
    expect(readFileSync(join(expectedRun, 'manifest.json'), 'utf8')).not.toContain(customCwd);
    const result = harness.emits.find((item) => item.event === AGENT_EVENTS.dispatch.result)?.payload as { workspaceRun?: { cwd?: string } } | undefined;
    expect(result?.workspaceRun?.cwd).toBe('.');
    expect(JSON.stringify(result)).not.toContain(customCwd);
  });

  // #1053 Gap1：没有 workspace snapshot 的受管 dispatch 优先使用
  // managementContext.taskContext 的真实 taskId/taskAttempt。
  test('managed dispatch without snapshot uses managementContext.taskContext identity', async () => {
    const home = tempDir('channel-first-taskctx-home-');
    const customCwd = tempDir('channel-first-taskctx-cwd-');
    const harness = fakeSocket();
    let env: Record<string, string> | undefined;
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      homeDir: home,
      executor: async (request) => {
        env = request.customAgent?.env;
        return { body: 'done', workspaceRun: { status: 'succeeded', cwd: customCwd, startedAt: 1, completedAt: 2 } };
      },
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-9', requestId: 'management:inv-9:2', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', managementInvocationId: 'inv-9',
      managementContext: {
        invocationId: 'inv-9',
        taskContext: { taskId: 'task-real-1', taskRevision: 1, taskAttempt: 4, claimLeaseId: 'lease-1' },
        contextRefs: [], dependencyResults: [], acceptanceCriteria: [],
      },
      prompt: 'run', customAgent: { adapterKind: 'codex', command: 'codex', cwd: customCwd },
    });

    // invocation/request 身份不得再充当 taskId；真实 task 身份进入 run 目录。
    const expectedRun = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'runs', 'agent-1', 'task-real-1', '4', 'dispatch-9');
    expect(env?.AGENTBEAN_WORKSPACE).toBe(expectedRun);
  });

  // #1053 Gap1：连 Task context 都没有时只能回退到安全的 dispatch id
  // （requestId 形如 management:<inv>:<attempt>，含冒号会被段校验拒绝）。
  test('managed dispatch without task context falls back to the safe dispatch id', async () => {
    const home = tempDir('channel-first-notask-home-');
    const customCwd = tempDir('channel-first-notask-cwd-');
    const harness = fakeSocket();
    let env: Record<string, string> | undefined;
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      homeDir: home,
      executor: async (request) => {
        env = request.customAgent?.env;
        return { body: 'done', workspaceRun: { status: 'succeeded', cwd: customCwd, startedAt: 1, completedAt: 2 } };
      },
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-10', requestId: 'management:inv-10:1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
      agentId: 'agent-1', managementInvocationId: 'inv-10',
      managementContext: { invocationId: 'inv-10', contextRefs: [], dependencyResults: [], acceptanceCriteria: [] },
      prompt: 'run', customAgent: { adapterKind: 'codex', command: 'codex', cwd: customCwd },
    });

    const expectedRun = join(home, '.agentbean', 'workspaces', 'team-1', 'channels', 'channel-1', 'runs', 'agent-1', 'dispatch-10', '1', 'dispatch-10');
    expect(env?.AGENTBEAN_WORKSPACE).toBe(expectedRun);
  });

  // #1053 Gap2：Channel run manifest 独立持久化 dispatchId 与 workspaceRunId；
  // 恢复回报使用原始 dispatchId，provenance 仍由 workspaceRunId 承担。
  test('channel run recovery reports with the persisted dispatchId, not workspaceRunId', async () => {
    const home = tempDir('channel-first-recover-id-');
    const agentBeanHome = join(home, '.agentbean');
    persistDeviceProjectionManifest(agentBeanHome, {
      schemaVersion: 1, deviceId: 'device-current', teamId: 'team-1', updatedAt: 1,
    });
    const ws = prepareChannelWorkspaceRun({
      agentBeanHome,
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'wsrun-1',
    });
    writeFileSync(ws.responsePath, 'recovered reply');
    writeFileSync(ws.manifestPath, JSON.stringify({
      runId: 'wsrun-1',
      dispatchId: 'disp-original-1',
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      status: 'succeeded',
      startedAt: 1,
      completedAt: 2,
      files: [],
      // #1053：Channel run 恢复必须还原协作结果（PR#1046 review 遗留，此前只有
      // legacy 路径恢复，Channel 路径静默丢弃）。
      collaborationProposals: [{
        schemaVersion: 1,
        sourceInvocationId: 'inv-1',
        sourceAgentId: 'agent-1',
        toAgentId: 'agent-2',
        kind: 'consult',
        objective: 'consult objective',
        reason: 'consult reason',
        contextRefs: [],
        dependencyResults: [],
        acceptanceCriteria: [],
        attachmentIds: [],
        returnMode: 'deliver_to_root',
      }],
    }));
    // 旧 manifest（无 dispatchId）：回退 runId 回报（兼容路径）。
    const legacy = prepareChannelWorkspaceRun({
      agentBeanHome,
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      taskId: 'task-1',
      taskAttempt: 1,
      workspaceRunId: 'wsrun-legacy',
    });
    writeFileSync(legacy.responsePath, 'legacy reply');
    writeFileSync(legacy.manifestPath, JSON.stringify({
      runId: 'wsrun-legacy',
      deviceId: 'device-current',
      teamId: 'team-1',
      channelId: 'channel-1',
      agentId: 'agent-1',
      status: 'succeeded',
      startedAt: 1,
      completedAt: 2,
      files: [],
    }));

    const harness = fakeSocket();
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      device: { teamId: 'team-1', ownerId: 'owner-1' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      homeDir: home,
      executor: async () => ({ body: 'should not run' }),
    });
    await client.start();
    await vi.waitFor(() => {
      const reported = harness.emits
        .filter((item) => item.event === AGENT_EVENTS.dispatch.result)
        .map((item) => (item.payload as { dispatchId?: string }).dispatchId);
      expect(reported).toContain('disp-original-1');
      expect(reported).toContain('wsrun-legacy');
      expect(reported).not.toContain('wsrun-1');
    });
    // 协作结果随恢复回报还原，不在重启后丢失。
    const recoveredPayload = harness.emits
      .filter((item) => item.event === AGENT_EVENTS.dispatch.result)
      .map((item) => item.payload as { dispatchId?: string; collaborationProposals?: Array<{ toAgentId?: string }> })
      .find((payload) => payload.dispatchId === 'disp-original-1');
    expect(recoveredPayload?.collaborationProposals?.map((proposal) => proposal.toAgentId)).toEqual(['agent-2']);
    const manifest = JSON.parse(readFileSync(ws.manifestPath, 'utf8')) as { reportedAt?: number; dispatchId?: string };
    expect(typeof manifest.reportedAt).toBe('number');
    expect(manifest.dispatchId).toBe('disp-original-1');
  });

  // #1053 Gap3：snapshot 物化/下载/refresh 使用 dispatch 目标 teamId（request.teamId），
  // 不是 Device primary Team（device.teamId）。
  test('snapshot materialize and downloads use the dispatch target team, not the device primary team', async () => {
    const home = tempDir('channel-first-xteam-home-');
    const customCwd = tempDir('channel-first-xteam-cwd-');
    const content = 'frozen-plan';
    const snapshot = {
      id: 'snapshot-b1',
      teamId: 'team-b',
      channelId: 'channel-b',
      workspaceRevisionId: 'rev-b1',
      inputSet: {
        id: 'input-set-b1',
        contractVersion: 1,
        selections: [{ kind: 'version', collectionId: 'collection-b1', versionId: 'version-b1' }],
        items: [{
          collectionId: 'collection-b1',
          artifactVersionId: 'version-b1',
          artifactId: 'artifact-b1',
          path: 'plan.md',
          filename: 'plan.md',
          mimeType: 'text/plain',
          sizeBytes: Buffer.byteLength(content),
          sha256: createHash('sha256').update(content).digest('hex'),
        }],
      },
      provenance: {
        createdByDeviceId: 'device-current',
        agentId: 'agent-1',
        taskId: 'task-b1',
        taskAttempt: 2,
        workspaceRunId: 'dispatch-x1',
        createdAt: 1,
      },
      immutable: true,
    };
    const requestedUrls: string[] = [];
    const harness = fakeSocket();
    const client = createDaemonProtocolClient({
      socket: harness.socket,
      // Device primary Team 是 team-a；dispatch 目标是 team-b。
      device: { teamId: 'team-a', ownerId: 'owner-1', token: 'tok' },
      runtimes: [],
      agents: [],
      serverUrl: 'http://server.test',
      homeDir: home,
      fetch: (async (input: unknown) => {
        const url = String(input);
        requestedUrls.push(url);
        const json = (value: unknown) => new Response(JSON.stringify(value), {
          status: 200, headers: { 'content-type': 'application/json' },
        });
        if (url.includes('/device-workspace-snapshots/')) {
          return json({ ok: true, snapshot });
        }
        if (url.includes('/artifacts/artifact-b1/download')) {
          return new Response(content, { status: 200, headers: { 'x-artifact-version-id': 'version-b1' } });
        }
        return new Response('not found', { status: 404 });
      }) as typeof fetch,
      executor: async () => ({
        body: 'done',
        workspaceRun: { status: 'succeeded', cwd: customCwd, startedAt: 1, completedAt: 2 },
      }),
    });
    await client.start();
    await harness.deliver(AGENT_EVENTS.dispatch.request, {
      id: 'dispatch-x1', requestId: 'req-x1', teamId: 'team-b', channelId: 'channel-b', messageId: 'message-1',
      agentId: 'agent-1', workspaceSnapshot: snapshot,
      prompt: 'run', customAgent: { adapterKind: 'codex', command: 'codex', cwd: customCwd },
    });

    const result = harness.emits.find((item) => item.event === AGENT_EVENTS.dispatch.result);
    expect(result).toBeDefined();
    // refresh 与 artifact 下载都必须命中目标 Team（team-b），绝不回 Device primary（team-a）。
    expect(requestedUrls.some((url) => url.includes('/api/teams/team-b/channels/channel-b/device-workspace-snapshots/snapshot-b1'))).toBe(true);
    expect(requestedUrls.some((url) => url.includes('/api/teams/team-b/artifacts/artifact-b1/download'))).toBe(true);
    expect(requestedUrls.every((url) => !url.includes('/api/teams/team-a/'))).toBe(true);
  });
});
