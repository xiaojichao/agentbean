import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  agentEvents,
  artifactUploadFallbackUrls,
  artifactUploadProxyUrl,
  artifactUploadUrl,
  channelEvents,
  deviceEvents,
  memberEvents,
  taskEvents,
  uploadArtifact,
  authEvents,
} from '../lib/socket';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('artifactUploadUrl', () => {
  it('builds a backend authenticated upload URL', () => {
    expect(artifactUploadUrl('team one/x')).toBe('http://localhost:4000/api/teams/team%20one%2Fx/artifacts/upload?token=');
  });

  it('keeps the same-origin proxy as an upload fallback', () => {
    expect(artifactUploadProxyUrl('team one/x')).toBe('/api/teams/team%20one%2Fx/artifacts/upload?token=');
    expect(artifactUploadFallbackUrls('team one/x')).toEqual([
      'http://localhost:4000/api/teams/team%20one%2Fx/artifacts/upload?token=',
      '/api/teams/team%20one%2Fx/artifacts/upload?token=',
    ]);
  });

  it('falls back to the same-origin proxy if the direct upload cannot be fetched', async () => {
    const fetchMock = vi.spyOn(globalThis, 'fetch')
      .mockRejectedValueOnce(new Error('Failed to fetch'))
      .mockResolvedValueOnce(new Response(JSON.stringify({
        id: 'artifact-1',
        filename: 'hello.txt',
        mimeType: 'text/plain',
        sizeBytes: 5,
        createdAt: 1,
        downloadUrl: '/download',
        previewUrl: '/preview',
      }), { status: 201, headers: { 'content-type': 'application/json' } }));

    const form = new FormData();
    form.append('channelId', 'channel-1');
    form.append('uploaderId', 'user-1');
    form.append('file', new Blob(['hello'], { type: 'text/plain' }), 'hello.txt');

    await expect(uploadArtifact('default', form)).resolves.toMatchObject({ id: 'artifact-1' });
    expect(fetchMock).toHaveBeenNthCalledWith(1, 'http://localhost:4000/api/teams/default/artifacts/upload?token=', expect.objectContaining({ method: 'POST' }));
    expect(fetchMock).toHaveBeenNthCalledWith(2, '/api/teams/default/artifacts/upload?token=', expect.objectContaining({ method: 'POST' }));
  });
});

describe('socket event payload adapters', () => {
  it('maps task page ids to server taskId payloads', async () => {
    const { socket, calls } = createAckSocket();
    const tasks = taskEvents(socket);

    await tasks.update({ id: 'task-1', title: 'Renamed' });
    expect(calls.at(-1)).toEqual({
      event: 'task:update',
      payload: { taskId: 'task-1', title: 'Renamed' },
    });

    await tasks.delete('task-1');
    expect(calls.at(-1)).toEqual({
      event: 'task:delete',
      payload: { taskId: 'task-1' },
    });

    await tasks.reorder('task-1', 42);
    expect(calls.at(-1)).toEqual({
      event: 'task:reorder',
      payload: { taskId: 'task-1', sortOrder: 42 },
    });
  });

  it('maps agent network ids to server team payloads', async () => {
    const { socket, calls } = createAckSocket();
    const agents = agentEvents(socket);

    await agents.create({
      name: 'Codex',
      adapterKind: 'codex',
      command: 'codex',
      deviceId: 'device-1',
      networkId: 'team-1',
    });
    expect(calls.at(-1)?.event).toBe('agent:create');
    expect(calls.at(-1)?.payload).toMatchObject({
      name: 'Codex',
      adapterKind: 'codex',
      command: 'codex',
      deviceId: 'device-1',
      teamId: 'team-1',
    });
    expect(calls.at(-1)?.payload).not.toHaveProperty('networkId');

    await agents.publish('agent-1', 'team-1');
    expect(calls.at(-1)).toEqual({
      event: 'agent:publish',
      payload: { agentId: 'agent-1', targetTeamId: 'team-1' },
    });

    await agents.unpublish('agent-1', 'team-1');
    expect(calls.at(-1)).toEqual({
      event: 'agent:unpublish',
      payload: { agentId: 'agent-1', targetTeamId: 'team-1' },
    });

    await agents.updateConfig({ id: 'agent-1', name: 'Codex' });
    expect(calls.at(-1)).toEqual({
      event: 'agent:update-config',
      payload: { agentId: 'agent-1', name: 'Codex' },
    });
  });

  it('maps device invite creation to server-next device invite payloads', async () => {
    const { socket, calls } = createAckSocket();
    const auth = authEvents(socket);

    await auth.inviteCreate({ networkId: 'team-1', purpose: 'device' });
    expect(calls.at(-1)).toEqual({
      event: 'device-invite:create',
      payload: { purpose: 'device', teamId: 'team-1' },
    });

    await auth.inviteCreate({ networkId: 'default', purpose: 'device' });
    expect(calls.at(-1)).toEqual({
      event: 'device-invite:create',
      payload: { purpose: 'device' },
    });
  });

  it('maps device and channel member ids to server payload names', async () => {
    const { socket, calls } = createAckSocket();

    await deviceEvents(socket).get({ id: 'device-1' });
    expect(calls.at(-1)).toEqual({
      event: 'device:get',
      payload: { deviceId: 'device-1' },
    });

    await deviceEvents(socket).agentsList('device-1', 'team-1');
    expect(calls.at(-1)).toEqual({
      event: 'device:agents:list',
      payload: { deviceId: 'device-1', teamId: 'team-1' },
    });

    await channelEvents(socket).addMember('channel-1', 'user-1');
    expect(calls.at(-1)).toEqual({
      event: 'channel:add-member',
      payload: { channelId: 'channel-1', memberUserId: 'user-1' },
    });

    await channelEvents(socket).removeMember('channel-1', 'user-1');
    expect(calls.at(-1)).toEqual({
      event: 'channel:remove-member',
      payload: { channelId: 'channel-1', memberUserId: 'user-1' },
    });
  });

  it('maps member management commands to server payload names', async () => {
    const { socket, calls } = createAckSocket();
    const members = memberEvents(socket);

    await members.updateRole({ targetUserId: 'user-2', role: 'admin' });
    expect(calls.at(-1)).toEqual({
      event: 'member:update-role',
      payload: { targetUserId: 'user-2', role: 'admin' },
    });

    await members.remove({ targetUserId: 'user-2' });
    expect(calls.at(-1)).toEqual({
      event: 'member:remove',
      payload: { targetUserId: 'user-2' },
    });

    await members.transferOwner({ targetUserId: 'user-2' });
    expect(calls.at(-1)).toEqual({
      event: 'member:transfer-owner',
      payload: { targetUserId: 'user-2' },
    });
  });

  it('sends team-scoped subscription payloads for realtime snapshots', () => {
    const { socket, calls } = createAckSocket();

    agentEvents(socket).subscribe('team-1');
    expect(calls.at(-1)).toEqual({
      event: 'agents:subscribe',
      payload: { teamId: 'team-1' },
    });

    channelEvents(socket).subscribe('team-1');
    expect(calls.at(-1)).toEqual({
      event: 'channels:subscribe',
      payload: { teamId: 'team-1' },
    });

    deviceEvents(socket).subscribe('team-1');
    expect(calls.at(-1)).toEqual({
      event: 'device:list',
      payload: { teamId: 'team-1' },
    });
  });
});

function createAckSocket(): {
  socket: Parameters<typeof taskEvents>[0];
  calls: Array<{ event: string; payload: unknown }>;
} {
  const calls: Array<{ event: string; payload: unknown }> = [];
  const socket = {
    emit: vi.fn((event: string, payload: unknown, ack?: (res: unknown) => void) => {
      calls.push({ event, payload });
      ack?.({ ok: true });
    }),
    on: vi.fn(),
    off: vi.fn(),
  };
  return { socket: socket as Parameters<typeof taskEvents>[0], calls };
}
