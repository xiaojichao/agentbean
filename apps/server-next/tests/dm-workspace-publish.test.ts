import { createHash } from 'node:crypto';
import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { createServerNextUseCases } from '../src/application/usecases.js';

const sha256 = (b: Buffer) => createHash('sha256').update(b).digest('hex');

/**
 * 产品决策(2026-08-07):DM(私聊)频道支持文件包卡片。
 *
 * 修前 ensureUserCanViewProjectWorkspace / ensureSnapshotChannelAccess /
 * ensureWorkspacePublishChannelAccess 三处对 kind==='direct' 硬拒 NOT_FOUND,
 * daemon fetchProjectChannelWorkspaceCurrent 拿 {ok:false} → baselineRevisionId 空
 * → staging 静默跳过 → DM 永不 publish → 无卡片。
 *
 * 本测试验证删三处硬拒后,DM 频道首次 publish 走通(access 通过 → bootstrap 建 ws →
 * OutputPackage 形成),与普通频道首次 publish 完全对称(参照 workspace-publish-bootstrap-commit)。
 */
describe('DM 频道 workspace publish(产品决策:DM 支持文件包)', () => {
  test('DM 频道首次 publish 不被 access 拒绝,自动建 workspace 并形成 OutputPackage', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 1 },
      ids: { nextId: () => `id-${Math.random().toString(36).slice(2)}` },
    });
    const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
    if (!registered.ok) throw new Error(registered.error);
    const userId = registered.user.id;
    const teamId = registered.user.primaryTeamId!;

    const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'm-a', hostname: 'd-a' });
    if (!hello.ok) throw new Error('device hello failed');
    const agents = await app.registerDiscoveredAgents({
      teamId,
      deviceId: hello.device.id,
      agents: [{ name: 'Hermes-Agent', adapterKind: 'hermes', category: 'agentos-hosted' }],
    });
    if (!agents.ok) throw new Error(agents.error);
    const agentId = agents.agents[0]!.id;

    // 创建 DM 频道(私聊 agent)。修前三处 access 对 kind==='direct' 硬拒。
    const channelId = 'dm-1';
    await repositories.channels.create({
      id: channelId,
      teamId,
      kind: 'direct',
      name: `dm-${agentId}`,
      visibility: 'private',
      humanMemberIds: [userId],
      agentMemberIds: [agentId],
      createdAt: 1,
    });

    const device = { id: hello.device.id, token: hello.credentials!.token };

    // DM 频道尚无 workspace(首次 publish 前)
    const wsBefore = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(wsBefore.ok).toBe(false);

    const publishId = 'pub-dm-first';
    const body = Buffer.from('# DM 产出\n...');
    const begin = await app.beginWorkspacePublishStagingForDevice({
      token: device.token,
      teamId,
      channelId,
      publishId,
      baselineRevisionId: '', // 首次发布:空 baseline
      files: [{ path: 'note.md', filename: 'note.md', mimeType: 'text/markdown', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
      provenance: { agentId, taskId: 't1', taskAttempt: 1 },
    });
    expect(begin.ok).toBe(true);
    if (!begin.ok) return;

    const put = await app.putWorkspacePublishStagingFileForDevice({
      token: device.token, teamId, channelId, publishId, path: 'note.md', offset: 0, content: body,
    });
    expect(put.ok).toBe(true);

    const commit = await app.commitWorkspacePublishStagingForDevice({ token: device.token, teamId, channelId, publishId });
    if (!commit.ok) throw new Error(`commit failed: ${commit.error}`);
    expect(commit.ok).toBe(true);

    // DM workspace 被 bootstrap
    const wsAfter = await app.getProjectChannelWorkspace({ userId, teamId, channelId });
    expect(wsAfter.ok).toBe(true);
    if (!wsAfter.ok) return;
    expect(wsAfter.workspace.currentRevision.revision).toBe(1);

    // OutputPackage 形成(DM 卡片数据源)
    const pkgs = await app.listOutputPackages({ userId, teamId, channelId, currentDeviceId: device.id });
    expect(pkgs.ok).toBe(true);
    if (!pkgs.ok) return;
    expect(pkgs.packages.length).toBe(1);
  });
});
