import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * Slice 3 端到端：新频道（无 project channel workspace）的首次 Agent 交付应能发布——
 * device 以空 baseline begin/put/commit，server publishRevision bootstrap 初始 workspace，
 * OutputPackage 形成。修前：begin 拒绝空 baseline / publishRevision 无 workspace 抛错 → 死锁。
 */
describe('workspace publish bootstrap — 首次交付（无 workspace）端到端', () => {
  test('空 baseline begin→put→commit 自动建 workspace 并形成 OutputPackage', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({ repositories, clock: { now: () => 1 }, ids: { nextId: () => `id-${Math.random().toString(36).slice(2)}` } });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;
    const channel = await app.createChannel({ userId, teamId, name: 'fresh', visibility: 'public' });
    if (!channel.ok) throw new Error(channel.error);
    const channelId = channel.channel.id;
    const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'm-a', hostname: 'd-a' });
    if (!hello.ok) throw new Error('device hello failed');
    const agents = await app.registerDiscoveredAgents({ teamId, deviceId: hello.device.id, agents: [{ name: 'A', adapterKind: 'hermes', category: 'agentos-hosted' }] });
    if (!agents.ok) throw new Error(agents.error);
    const member = await app.addChannelAgentMember({ userId, teamId, channelId, agentId: agents.agents[0]!.id });
    if (!member.ok) throw new Error(member.error);
    const device = { id: hello.device.id, token: hello.credentials!.token };
    const agentId = agents.agents[0]!.id;

    // 关键：不调 createProjectChannelWorkspace。频道尚无 workspace。
    const wsBefore = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(wsBefore.ok).toBe(false);

    const publishId = 'pub-first';
    const body = Buffer.from('# 第1集\n...');
    const begin = await app.beginWorkspacePublishStagingForDevice({
      token: device.token, teamId, channelId, publishId,
      baselineRevisionId: '', // 首次发布：空 baseline
      files: [{ path: 'ep01.md', filename: 'ep01.md', mimeType: 'text/markdown', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
      provenance: { agentId, taskId: 't1', taskAttempt: 1 },
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;

    const put = await app.putWorkspacePublishStagingFileForDevice({ token: device.token, teamId, channelId, publishId, path: 'ep01.md', offset: 0, content: body });
    expect(put.ok).toBe(true);

    const commit = await app.commitWorkspacePublishStagingForDevice({ token: device.token, teamId, channelId, publishId });
    if (!commit.ok) throw new Error(`commit failed: ${commit.error} / ${'message' in commit ? commit.message : ''}`);
    expect(commit.ok).toBe(true);

    // workspace 被 bootstrap
    const wsAfter = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(wsAfter.ok).toBe(true);
    if (!wsAfter.ok) return;
    expect(wsAfter.workspace.currentRevision.revision).toBe(1);

    // OutputPackage 形成
    const pkgs = await app.listOutputPackages({ userId, teamId, channelId, currentDeviceId: device.id });
    expect(pkgs.ok).toBe(true);
    if (!pkgs.ok) return;
    expect(pkgs.packages.length).toBe(1);
  });
});
