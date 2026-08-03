import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, test } from 'vitest';
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
});
