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

  // #966: Atomic publish creates next revision with publish provenance
  test('原子发布：基线匹配则整体创建下一 revision 并记录 publish provenance', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 200 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'channel-2', 'ws-1', 'rev-1', 'rev-2', 'rev-3']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await repositories.artifacts.create({ id: 'artifact-2', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });

    const created = await app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'a.txt', artifactId: 'artifact-1' }],
    });
    if (!created.ok) throw new Error(created.error);
    const baselineRevisionId = created.workspace.currentRevision.id;

    const published = await app.publishProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', baselineRevisionId,
      files: [{ path: 'a.txt', artifactId: 'artifact-1' }, { path: 'b.txt', artifactId: 'artifact-2' }],
      provenance: { agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1 },
    });
    expect(published).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 2 } } });
    if (!published.ok) throw new Error(published.error);
    expect(published.workspace.currentRevision.files.map((f) => f.path).sort()).toEqual(['a.txt', 'b.txt']);
    const provenance = published.workspace.currentRevision.provenance;
    expect(provenance?.kind).toBe('publish');
    if (provenance?.kind === 'publish') {
      expect(provenance).toMatchObject({ agentId: 'agent-1', taskId: 'task-1', taskAttempt: 1, baselineRevisionId });
    }
    // 旧 revision 仍可按 id 读取（不可变）
    const oldRevision = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', revisionId: baselineRevisionId });
    expect(oldRevision).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 1 } } });
  });

  // #966: Baseline mismatch returns current version + conflict paths, no partial write
  test('冲突反馈：基线落后返回当前版本与冲突路径，不写、不合 publish', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 300 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'channel-2', 'ws-1', 'rev-1', 'rev-2', 'rev-3', 'rev-4']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await repositories.artifacts.create({ id: 'artifact-2', teamId: 'team-1', channelId: 'channel-2', uploaderId: 'user-1', filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });

    const created = await app.createProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', files: [{ path: 'a.txt', artifactId: 'artifact-1' }],
    });
    if (!created.ok) throw new Error(created.error);
    const staleBaseline = created.workspace.currentRevision.id;

    // 第一次发布成功（current → rev2），staleBaseline 仍是 rev1
    const first = await app.publishProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', baselineRevisionId: staleBaseline,
      files: [{ path: 'a.txt', artifactId: 'artifact-2' }],
    });
    expect(first).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 2 } } });

    // 用过时的 rev1 基线再发布 → 冲突，current 已是 rev2
    const conflict = await app.publishProjectChannelWorkspace({
      userId: 'user-1', teamId: 'team-1', channelId: 'channel-2', baselineRevisionId: staleBaseline,
      files: [{ path: 'a.txt', artifactId: 'artifact-1' }],
    });
    expect(conflict).toMatchObject({ ok: false, error: 'CONFLICT' });
    if (conflict.ok) throw new Error('expected conflict');
    expect(conflict.details).toMatchObject({ currentRevision: 2 });
    expect((conflict.details as { conflictingPaths: string[] }).conflictingPaths).toEqual(['a.txt']);
    // 冲突不写：current 仍为 rev2
    const reread = await app.getProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-2' });
    expect(reread).toMatchObject({ ok: true, workspace: { currentRevision: { revision: 2 } } });
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

  // #968 materialize: apply a published revision back to a local directory.
  test('materialize 由非导入设备发起仍返回清单 —— 来源 Device 无关（AC#1/#4）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'device-2', 'workspace-1', 'revision-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;

    const hello1 = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'dev-1' });
    const hello2 = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-2', hostname: 'dev-2' });
    if (!hello1.ok || !hello2.ok || !hello1.credentials || !hello2.credentials) throw new Error('device hello failed');

    await repositories.artifacts.create({
      id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1',
      filename: 'index.ts', mimeType: 'text/typescript', sizeBytes: 100, pathKind: 'workspace', createdAt: 90,
    });

    // device-1 imports → provenance.sourceDeviceId = device-1
    const imported = await app.importProjectChannelWorkspace({
      token: hello1.credentials.token, teamId: 'team-1', channelId: cid,
      files: [{ path: 'src/index.ts', artifactId: 'artifact-1' }],
    });
    if (!imported.ok) throw new Error(imported.error);
    expect(imported.workspace.currentRevision.provenance?.sourceDeviceId).toBe('device-1');
    // 清单不含本地绝对路径（AC#3 / #964 provenance 设计）
    const provenanceKeys = Object.keys(imported.workspace.currentRevision.provenance ?? {});
    expect(provenanceKeys).not.toContain('sourcePath');

    // device-2（≠ 导入设备 device-1）materialize 同一 revision —— 来源 Device 无关（AC#4）
    const materialized = await app.materializeProjectChannelWorkspace({
      token: hello2.credentials.token, teamId: 'team-1', channelId: cid,
    });
    expect(materialized).toMatchObject({
      ok: true,
      workspace: { currentRevision: { revision: 1, files: [{ path: 'src/index.ts', artifactId: 'artifact-1', filename: 'index.ts' }] } },
    });
  });

  test('materialize 拒绝无效 device token —— 远程 Agent 不可发起（AC#1）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    await expect(app.materializeProjectChannelWorkspace({
      token: 'abn_device.invalid.signature', teamId: 'team-1', channelId: 'channel-1',
    })).resolves.toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
  });

  test('materialize 对无权查看的私有频道拒绝（AC#3）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'workspace-1', 'revision-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'private', humanMemberIds: ['user-1'] });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'dev-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');

    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    const imported = await app.importProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'artifact-1' }] });
    if (!imported.ok) throw new Error(imported.error);

    // 移除 owner 的频道成员资格 → materialize 拒绝
    await repositories.channels.update({ channelId: cid, changes: { humanMemberIds: [] } });
    await expect(app.materializeProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  test('materialize 归档频道仍可读取清单（归档只读，发布才拒绝）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'workspace-1', 'revision-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'dev-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await app.importProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'artifact-1' }] });

    // 归档后 materialize（读清单）仍允许 —— 归档冻结发布，不冻结读取已发布成果。
    await repositories.channels.update({ channelId: cid, changes: { archivedAt: 200 } });
    await expect(app.materializeProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid })).resolves.toMatchObject({ ok: true });
  });

  test('materialize 指定不存在的 revisionId 返回 NOT_FOUND', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories, clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'workspace-1', 'revision-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'dev-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await app.importProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'artifact-1' }] });

    await expect(app.materializeProjectChannelWorkspace({ token: hello.credentials.token, teamId: 'team-1', channelId: cid, revisionId: 'no-such-revision' })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });
  test('频道治理者导出封存清单：含最后 revision 与 deliverable，排除非交付物，只读', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 500 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'revision-1', 'workspace-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;

    await repositories.artifacts.create({ id: 'art-deliv', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'final.zip', mimeType: 'application/zip', sizeBytes: 256, pathKind: 'workspace', role: 'deliverable', sha256: 'abc123', workspaceRunId: 'run-1', createdAt: 200 });
    await repositories.artifacts.create({ id: 'art-inter', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'scratch.tmp', mimeType: 'application/octet-stream', sizeBytes: 10, pathKind: 'workspace', role: 'intermediate', createdAt: 201 });

    const created = await app.createProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid, files: [{ path: 'final.zip', artifactId: 'art-deliv' }] });
    if (!created.ok) throw new Error(created.error);

    const exported = await app.exportProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid });
    expect(exported).toMatchObject({ ok: true, manifest: { teamId: 'team-1', channelId: cid, exportedByUserId: 'user-1', exportedAt: 500 } });
    if (!exported.ok) throw new Error(exported.error);
    expect(exported.manifest.revision.revision).toBe(1);
    // 只有 deliverable 进入清单；intermediate 被排除。
    expect(exported.manifest.deliverables).toHaveLength(1);
    expect(exported.manifest.deliverables[0]).toMatchObject({ artifactId: 'art-deliv', role: 'deliverable', sha256: 'abc123', workspaceRunId: 'run-1' });
    // 只读：导出未改变频道状态（未归档）。
    expect((await repositories.channels.getById(cid))?.archivedAt ?? null).toBeNull();
  });

  // #969 AC#4：非治理者（非创建者成员）被拒绝；治理者仍可导出。
  test('非频道创建者成员导出被拒绝 FORBIDDEN', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 500 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'revision-1', 'workspace-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    await repositories.artifacts.create({ id: 'art-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', role: 'deliverable', createdAt: 1 });
    await app.createProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'art-1' }] });

    // user-2 是团队成员但非频道创建者。
    await repositories.users.create({ id: 'user-2', username: 'bob', role: 'user', passwordHash: 'x', createdAt: 1, updatedAt: 1 });
    await repositories.teams.addMember({ teamId: 'team-1', userId: 'user-2', username: 'bob', role: 'member', joinedAt: 1 });

    await expect(app.exportProjectChannelWorkspace({ userId: 'user-2', teamId: 'team-1', channelId: cid })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
    await expect(app.exportProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid })).resolves.toMatchObject({ ok: true });
  });

  // #969 AC#4：导出不依赖归档状态，也不恢复频道——归档频道仍可被治理者导出且导出后仍归档。
  test('归档频道仍可被治理者导出（导出不恢复频道）', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 500 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'revision-1', 'workspace-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    await repositories.artifacts.create({ id: 'art-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', role: 'deliverable', createdAt: 1 });
    await app.createProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'art-1' }] });
    await repositories.channels.update({ channelId: cid, changes: { archivedAt: 400 } });

    const exported = await app.exportProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid });
    expect(exported).toMatchObject({ ok: true });
    // 导出不恢复频道：仍处于归档。
    expect((await repositories.channels.getById(cid))?.archivedAt).toBe(400);
  });

  // #969 AC#2：列出 workspace 全部 revision（最新在前），按授权读取。
  test('列出 workspace revision 历史（最新在前），非成员拒绝', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 500 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'revision-1', 'workspace-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    await repositories.artifacts.create({ id: 'art-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await app.createProjectChannelWorkspace({ userId: 'user-1', teamId: 'team-1', channelId: cid, files: [{ path: 'a.txt', artifactId: 'art-1' }] });

    const list = await app.listProjectChannelWorkspaceRevisions({ userId: 'user-1', teamId: 'team-1', channelId: cid });
    expect(list).toMatchObject({ ok: true });
    if (!list.ok) throw new Error(list.error);
    expect(list.revisions.map((r) => r.revision)).toEqual([1]);
    expect(list.revisions[0]).toMatchObject({ files: [{ path: 'a.txt', artifactId: 'art-1' }] });

    // 非成员拒绝。
    await expect(app.listProjectChannelWorkspaceRevisions({ userId: 'outsider', teamId: 'team-1', channelId: cid })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });

  // #969 AC#1 回归：归档后拒绝 workspace 写入（create），历史仍按授权只读（已在首测覆盖 create；
  // 此处显式锁定 import 路径同样归档即拒）。
  test('归档后拒绝 import（本地应用）写入', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 500 },
      ids: { nextId: createIds(['user-1', 'team-1', 'all-1', 'channel-1', 'device-1', 'artifact-1']) },
    });
    await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    const channel = await app.createChannel({ userId: 'user-1', teamId: 'team-1', name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const cid = channel.channel.id;
    const hello = await app.deviceHello({ teamId: 'team-1', ownerId: 'user-1', machineId: 'machine-1', hostname: 'test-device' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    await repositories.artifacts.create({ id: 'artifact-1', teamId: 'team-1', channelId: cid, uploaderId: 'user-1', filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 1, pathKind: 'workspace', createdAt: 1 });
    await repositories.channels.update({ channelId: cid, changes: { archivedAt: 400 } });

    await expect(app.importProjectChannelWorkspace({
      token: hello.credentials.token, teamId: 'team-1', channelId: cid,
      files: [{ path: 'a.txt', artifactId: 'artifact-1' }],
    })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});

function createIds(values: string[]) {
  let index = 0;
  return () => values[index++] ?? `generated-${index}`;
}
