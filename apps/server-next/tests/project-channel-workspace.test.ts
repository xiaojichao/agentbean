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
    await expect(app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'C:/outside/secret.txt', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'C:outside\\secret.txt', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    created.workspace.currentRevision.files[0]!.path = 'tampered';
    await repositories.channels.update({ channelId: 'channel-2', changes: { archivedAt: 200 } });
    await expect(app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'README.md', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    const reread = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' });
    expect(reread).toMatchObject({ ok: true, workspace: { currentRevision: { files: [{ path: 'README.md' }] } } });
  });

  // #964: Device-initiated import with provenance
  test('设备导入创建 Workspace revision 并记录最小 provenance', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'workspace-1', 'revision-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;

    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'test-device' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');

    await repositories.artifacts.create({
      id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1',
      filename: 'index.ts', mimeType: 'text/typescript', sizeBytes: 100, pathKind: 'workspace', createdAt: 90,
    });

    const imported = await app.importProjectChannelWorkspace({
      token: hello.credentials.token, teamId: 'team-1', channelId: cid,
      files: [{ path: 'src/index.ts', artifactId: 'artifact-1' }],
    });
    expect(imported).toMatchObject({
      ok: true,
      workspace: { currentRevision: { revision: 1, files: [{ path: 'src/index.ts', artifactId: 'artifact-1', filename: 'index.ts' }] } },
    });
    if (!imported.ok) throw new Error(imported.error);

    expect(imported.workspace.currentRevision.provenance).toBeDefined();
    expect(imported.workspace.currentRevision.provenance!.sourceDeviceId).toBe('device-1');
    expect(imported.workspace.currentRevision.provenance!.importedAt).toBe(100);
    const provenance = imported.workspace.currentRevision.provenance!;
    expect(Object.keys(provenance)).not.toContain('sourcePath');
    expect(Object.keys(provenance)).not.toContain('absolutePath');

    const read = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid });
    expect(read).toMatchObject({ ok: true });
    if (!read.ok) throw new Error(read.error);
    expect(read.workspace.currentRevision.provenance).toBeDefined();
  });

  // #964: Import rejects invalid device tokens
  test('设备导入拒绝无效 token', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 100 }, ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1']) } });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    await expect(app.importProjectChannelWorkspace({
      token: 'abn_device.invalid.signature', teamId: 'team-1', channelId: 'channel-1',
      files: [{ path: 'README.md', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
  });

  // #964: Import validates paths
  test('设备导入拒绝非法路径（绝对路径、遍历、重复、空）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'artifact-1', 'artifact-2']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;

    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'test-device' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    const token = hello.credentials.token;

    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await repositories.artifacts.create({ id: 'artifact-2', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });

    await expect(app.importProjectChannelWorkspace({ token, teamId: 'team-1', channelId: cid, files: [{ path: '/etc/secret.txt', artifactId: 'artifact-1' }] })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.importProjectChannelWorkspace({ token, teamId: 'team-1', channelId: cid, files: [{ path: 'C:\\Users\\secret.txt', artifactId: 'artifact-1' }] })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.importProjectChannelWorkspace({ token, teamId: 'team-1', channelId: cid, files: [{ path: '../outside/secret.txt', artifactId: 'artifact-1' }] })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.importProjectChannelWorkspace({ token, teamId: 'team-1', channelId: cid, files: [{ path: 'same.txt', artifactId: 'artifact-1' }, { path: 'same.txt', artifactId: 'artifact-2' }] })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
    await expect(app.importProjectChannelWorkspace({ token, teamId: 'team-1', channelId: cid, files: [] })).resolves.toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });
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
    await repositories.channels.update({ channelId: privateChannel.channel.id, changes: { humanMemberIds: ['user-1'] } });
    await expect(app.deleteChannel({ userId: 'user-1', teamId: 'team-1', channelId: privateChannel.channel.id })).resolves.toMatchObject({ ok: true });
    await expect(repositories.projectChannelWorkspaces.getForTeam({ teamId: 'team-1', channelId: privateChannel.channel.id })).resolves.toBeNull();
  });
});

function createIds(values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}
