import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index.js';

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

describe('#1043 Server Device workspace snapshot', () => {
  test('current resolves to a concrete artifactVersionId and remains frozen after current moves', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 100 }, ids: { nextId: (() => { let n = 0; return () => `id-${++n}`; })() } });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({ userId: registered.user.id, teamId, name: 'project', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const hello = await app.deviceHello({ teamId, ownerId: registered.user.id, machineId: 'machine-1', hostname: 'device-1' });
    if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
    const discovered = await app.registerDiscoveredAgents({ teamId, deviceId: hello.device.id, agents: [{ name: 'agent', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    if (!discovered.ok) throw new Error(discovered.error);
    const agentId = discovered.agents[0]!.id;
    const member = await app.addChannelAgentMember({ userId: registered.user.id, teamId, channelId: channel.channel.id, agentId });
    if (!member.ok) throw new Error(member.error);
    const task = await repositories.tasks.create({ id: 'task-1', teamId, channelId: channel.channel.id, title: 'task', status: 'todo', creatorId: registered.user.id, assigneeId: registered.user.id, tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
    const stage = await app.createInitialProjectStage({
      userId: registered.user.id, teamId, channelId: channel.channel.id, expectedRevision: 0, idempotencyKey: 'stage-1', projectLeadId: registered.user.id,
      defaultReviewerIds: [registered.user.id], stage: { name: 'stage', goal: 'goal', ownerId: registered.user.id, reviewerIds: [registered.user.id], acceptanceCriteria: ['ok'], taskId: task.id },
    });
    if (!stage.ok) throw new Error(stage.error);
    const stageId = stage.overview.stages[0]!.id;
    const artifact1 = await repositories.artifacts.create({ id: 'artifact-1', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'a.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: sha256('first'), pathKind: 'upload', role: 'attachment', createdAt: 1 });
    const promoted1 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-1', artifactId: artifact1.id, stageId, collection: { name: 'files', kind: 'bundle' } });
    if (!promoted1.ok) throw new Error(promoted1.error);
    const snapshot = await app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 1, workspaceRunId: 'run-1', selections: [{ kind: 'current', collectionId: promoted1.collection.id }],
    });
    expect(snapshot).toMatchObject({ ok: true, snapshot: { immutable: true, inputSet: { items: [{ artifactVersionId: promoted1.version.id, artifactId: 'artifact-1' }] } } });
    if (!snapshot.ok) throw new Error(snapshot.error);
    await expect(app.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: true });
    const restarted = createServerNextUseCases({ repositories, clock: { now: () => 101 }, ids: { nextId: (() => { let n = 100; return () => `id-${++n}`; })() } });
    await expect(restarted.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: true, snapshot: { id: snapshot.snapshot.id } });
    await expect(app.getArtifactFileForDevice({
      token: hello.credentials.token,
      teamId,
      artifactId: 'artifact-1',
      expectedArtifactVersionId: promoted1.version.id,
    })).resolves.toMatchObject({ ok: true });
    await expect(app.getArtifactFileForDevice({
      token: hello.credentials.token,
      teamId,
      artifactId: 'artifact-1',
      expectedArtifactVersionId: 'version-from-another-snapshot',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });

    const artifact2 = await repositories.artifacts.create({ id: 'artifact-2', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'b.txt', mimeType: 'text/plain', sizeBytes: 6, sha256: sha256('second'), pathKind: 'upload', role: 'attachment', createdAt: 2 });
    const promoted2 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-2', artifactId: artifact2.id, stageId, collectionId: promoted1.collection.id, expectedCollectionRevision: 1 });
    expect(promoted2).toMatchObject({ ok: true, collection: { currentVersionId: expect.not.stringMatching(promoted1.version.id) } });
    expect(snapshot.snapshot.inputSet.items[0]!.artifactVersionId).toBe(promoted1.version.id);
    const artifact3 = await repositories.artifacts.create({ id: 'artifact-3', teamId, channelId: channel.channel.id, uploaderId: registered.user.id, filename: 'c.txt', mimeType: 'text/plain', sizeBytes: 5, sha256: sha256('third'), pathKind: 'upload', role: 'attachment', createdAt: 3 });
    const promoted3 = await app.promoteArtifactToProjectVersion({ userId: registered.user.id, teamId, channelId: channel.channel.id, idempotencyKey: 'promote-3', artifactId: artifact3.id, stageId, collection: { name: 'other-files', kind: 'bundle' } });
    if (!promoted3.ok) throw new Error(promoted3.error);
    const packageSnapshot = await app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 2, workspaceRunId: 'run-package', selections: [{ kind: 'file_package', collectionId: promoted1.collection.id, memberCollectionIds: [promoted1.collection.id, promoted3.collection.id] }],
    });
    expect(packageSnapshot.ok).toBe(true);
    if (!packageSnapshot.ok) throw new Error(packageSnapshot.error);
    expect(packageSnapshot.snapshot.inputSet.items.map((item) => item.artifactId)).toEqual(['artifact-2', 'artifact-3']);
    expect(packageSnapshot.snapshot.inputSet.items.map((item) => item.artifactVersionId)).toEqual([promoted2.version.id, promoted3.version.id]);
    await expect(app.createDeviceWorkspaceSnapshot({
      token: hello.credentials.token, teamId, channelId: channel.channel.id, agentId, taskId: task.id, taskAttempt: 2, workspaceRunId: 'run-2', selections: [{ kind: 'final', collectionId: promoted1.collection.id }],
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
    await repositories.agents.softDelete({ agentId, timestamp: 200 });
    await expect(app.getDeviceWorkspaceSnapshot({ token: hello.credentials.token, teamId, channelId: channel.channel.id, snapshotId: snapshot.snapshot.id })).resolves.toMatchObject({ ok: false, error: 'FORBIDDEN' });
  });
});
