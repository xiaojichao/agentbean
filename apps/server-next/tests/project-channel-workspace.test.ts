import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';

describe('Project Channel Workspace', () => {
  test('普通频道创建不可变 revision，并在归档后继续按权限读取', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'channel-2', 'workspace-1', 'revision-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    await repositories.artifacts.create({
      id: 'artifact-1', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1',
      filename: 'README.md', mimeType: 'text/markdown', sizeBytes: 10, pathKind: 'workspace', createdAt: 90,
    });

    const created = await app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'README.md', artifactId: 'artifact-1' }],
    });
    expect(created).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 1, files: [{ path: 'README.md', artifactId: 'artifact-1' }] } } });
    if (!created.ok) throw new Error(created.error);
    created.workspace.currentRevision.files[0]!.path = 'tampered';
    await repositories.channels.update({ channelId: 'channel-2', changes: { archivedAt: 200 } });
    await expect(app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'README.md', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    const reread = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' });
    expect(reread).toMatchObject({ ok: true, workspace: { currentRevision: { files: [{ path: 'README.md' }] } } });
  });

  test('#all、DM、私有频道成员移除均拒绝且不暴露 Workspace 文件', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 100 }, ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'channel-2', 'channel-3']) } });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const all = await repositories.channels.getDefaultChannel('team-1');
    expect(all).toBeTruthy();
    await repositories.channels.create({ id: 'dm-1', teamId: 'team-1', kind: 'direct', name: 'dm', visibility: 'private', humanMemberIds: ['user-1'], agentMemberIds: [], createdAt: 1 });
    await expect(app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: all!.id })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await expect(app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: 'dm-1' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const privateChannel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'private', visibility: 'private', humanMemberIds: ['user-1'] });
    if (!privateChannel.ok) throw new Error(privateChannel.error);
    await repositories.artifacts.create({ id: 'private-artifact', teamId: 'team-1', channelId: privateChannel.channel.id, uploaderId: 'user-1', filename: 'secret.txt', mimeType: 'text/plain', sizeBytes: 6, pathKind: 'workspace', createdAt: 1 });
    await expect(app.createProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: privateChannel.channel.id, files: [{ path: 'secret.txt', artifactId: 'private-artifact' }] })).resolves.toMatchObject({ ok: true });
    await repositories.channels.update({ channelId: privateChannel.channel.id, changes: { humanMemberIds: [] } });
    await expect(app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: privateChannel.channel.id })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});

function createIds(values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}
