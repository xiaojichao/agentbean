/**
 * #1044：publish commit/begin 重新验证 Agent/Task/Device authority。
 * 权限撤销（移出频道、删除 Agent、Device 换绑、Task 跨频道漂移）必须阻止过期提交,
 * 且不留部分 revision/artifact;已 committed 的幂等查询不受撤权影响。
 * 同一组断言跑内存与 SQLite 两套仓储。
 */
import { createHash } from 'node:crypto';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, test } from 'vitest';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import {
  createServerNextUseCases,
  type ServerNextUseCases,
} from '../src/application/usecases.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };

function sha256(content: Buffer | string): string {
  return createHash('sha256').update(content).digest('hex');
}

interface Seed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  userId: string;
  teamId: string;
  channelId: string;
  otherChannelId: string;
  deviceA: { id: string; token: string };
  deviceB: { id: string; token: string };
  agentId: string;
  baselineRevisionId: string;
  close: () => void;
}

const variants: Array<{ name: string; make: () => { repositories: ServerNextRepositories; close: () => void } }> = [
  { name: 'memory', make: () => ({ repositories: createInMemoryRepositories(), close: () => undefined }) },
  {
    name: 'sqlite',
    make: () => {
      const globalDb = new Database(':memory:') as DatabaseWithClose;
      const teamDb = new Database(':memory:') as DatabaseWithClose;
      applyGlobalMigrations(globalDb);
      applyTeamMigrations(teamDb);
      return {
        repositories: createSqliteRepositories({ globalDb, teamDb }),
        close: () => {
          globalDb.close();
          teamDb.close();
        },
      };
    },
  },
];

async function seed(variant: (typeof variants)[number]): Promise<Seed> {
  const { repositories, close } = variant.make();
  let now = 100;
  let id = 0;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `id-${++id}` },
  });
  const registered = await app.registerUser({ username: 'owner', password: 'secret', teamName: 'Team' });
  if (!registered.ok) throw new Error(registered.error);
  const userId = registered.user.id;
  const teamId = registered.user.primaryTeamId!;
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility: 'public' });
  if (!channel.ok) throw new Error(channel.error);
  const other = await app.createChannel({ userId, teamId, name: 'other', visibility: 'public' });
  if (!other.ok) throw new Error(other.error);
  const helloA = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  const helloB = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-b', hostname: 'device-b' });
  if (!helloA.ok || !helloA.credentials || !helloB.ok || !helloB.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: helloA.device.id,
    agents: [{ name: 'Agent-A', adapterKind: 'hermes', category: 'agentos-hosted' }],
  });
  if (!agents.ok) throw new Error(agents.error);
  const agentId = agents.agents[0]!.id;
  const member = await app.addChannelAgentMember({ userId, teamId, channelId: channel.channel.id, agentId });
  if (!member.ok) throw new Error(member.error);
  await repositories.artifacts.create({
    id: 'seed-art', teamId, channelId: channel.channel.id, uploaderId: userId,
    filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
  });
  const workspace = await app.createProjectChannelWorkspace({
    userId, teamId, channelId: channel.channel.id,
    files: [{ path: 'base.txt', artifactId: 'seed-art' }],
  });
  if (!workspace.ok) throw new Error(workspace.error);
  return {
    repositories,
    app,
    userId,
    teamId,
    channelId: channel.channel.id,
    otherChannelId: other.channel.id,
    deviceA: { id: helloA.device.id, token: helloA.credentials.token },
    deviceB: { id: helloB.device.id, token: helloB.credentials.token },
    agentId,
    baselineRevisionId: workspace.workspace.currentRevisionId,
    close,
  };
}

const BODY = Buffer.from('publish-authority-payload');

function planFiles() {
  return [{
    path: 'out/result.txt',
    filename: 'result.txt',
    mimeType: 'text/plain',
    expectedSizeBytes: BODY.length,
    expectedSha256: sha256(BODY),
  }];
}

async function beginAndPut(seedValue: Seed, publishId: string, provenance?: { agentId: string; taskId: string; taskAttempt: number; workspaceRunId?: string; deviceId?: string }) {
  const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
    token: seedValue.deviceA.token,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    publishId,
    baselineRevisionId: seedValue.baselineRevisionId,
    files: planFiles(),
    ...(provenance ? { provenance } : {}),
  });
  return begin;
}

for (const variant of variants) {
  describe(`Workspace publish provenance authority (#1044, ${variant.name})`, () => {
    let seedValue: Seed | undefined;
    afterEach(() => {
      seedValue?.close();
      seedValue = undefined;
    });

    test('begin fail-fast：Agent 被移出频道后不能开启新 staging', async () => {
      seedValue = await seed(variant);
      const removed = await seedValue.app.removeChannelAgentMember({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, agentId: seedValue.agentId,
      });
      expect(removed.ok).toBe(true);
      const begin = await beginAndPut(seedValue, 'pub-revoked-begin', {
        agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1,
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
    });

    test('commit 权威复验：上传完成后 Agent 被移出频道 → 无 revision/artifact 残留,staging 保持 open 可诊断', async () => {
      seedValue = await seed(variant);
      const begin = await beginAndPut(seedValue, 'pub-revoked-commit', {
        agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1,
      });
      expect(begin.ok).toBe(true);
      const put = await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-revoked-commit',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      expect(put).toMatchObject({ ok: true, staging: { files: [{ complete: true }] } });

      await seedValue.app.removeChannelAgentMember({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, agentId: seedValue.agentId,
      });
      const commit = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-revoked-commit',
      });
      expect(commit).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });

      // 不产生部分 revision;暂存文件不物化为 artifact;staging 保持 open 可诊断。
      const workspace = await seedValue.app.getProjectChannelWorkspace({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(workspace).toMatchObject({ ok: true });
      if (!workspace.ok) throw new Error(workspace.error);
      expect(workspace.workspace.currentRevision.id).toBe(seedValue.baselineRevisionId);
      const artifacts = await seedValue.repositories.artifacts.listByChannel({
        teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      expect(artifacts.some((a) => a.filename === 'result.txt')).toBe(false);
      const staging = await seedValue.app.getWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-revoked-commit',
      });
      expect(staging).toMatchObject({ ok: true, staging: { status: 'open' } });
    });

    test('commit 权威复验：Agent 被删除(softDelete)→ FORBIDDEN', async () => {
      seedValue = await seed(variant);
      const begin = await beginAndPut(seedValue, 'pub-agent-deleted', {
        agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1,
      });
      expect(begin.ok).toBe(true);
      await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-agent-deleted',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      await seedValue.repositories.agents.softDelete({ agentId: seedValue.agentId, timestamp: 500 });
      const commit = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-agent-deleted',
      });
      expect(commit).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
    });

    test('commit 权威复验：device 路径要求 agent 绑定当前 Device(换绑即拒绝)', async () => {
      seedValue = await seed(variant);
      // 以 device B 的 token 携带绑定在 device A 的 agent provenance。
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceB.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-wrong-device',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance: { agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1 },
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
    });

    test('Task authority：真实 Task 属于其他频道 → FORBIDDEN;合成 fallback taskId 放行', async () => {
      seedValue = await seed(variant);
      const foreignTask = await seedValue.app.createTask({
        userId: seedValue.userId, teamId: seedValue.teamId, title: 'foreign', channelId: seedValue.otherChannelId,
      });
      expect(foreignTask.ok).toBe(true);
      if (!foreignTask.ok) throw new Error(foreignTask.error);

      const wrongChannel = await beginAndPut(seedValue, 'pub-foreign-task', {
        agentId: seedValue.agentId, taskId: foreignTask.task.id, taskAttempt: 1,
      });
      expect(wrongChannel).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'task-authority-mismatch' } });

      // daemon 合成 fallback(dispatch.id 等)不存在于 tasks 仓储 → 按 provenance 记录放行。
      const synthetic = await beginAndPut(seedValue, 'pub-synthetic-task', {
        agentId: seedValue.agentId, taskId: 'dispatch:synthetic-1', taskAttempt: 1,
      });
      expect(synthetic.ok).toBe(true);
    });

    test('已 committed 的幂等查询不受撤权影响(重复 begin/commit 收敛同一 revision)', async () => {
      seedValue = await seed(variant);
      const provenance = {
        agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1,
        workspaceRunId: 'run-1', deviceId: seedValue.deviceA.id,
      };
      const begin = await beginAndPut(seedValue, 'pub-committed-immune', provenance);
      expect(begin.ok).toBe(true);
      await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-committed-immune',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      const committed = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-committed-immune',
      });
      expect(committed).toMatchObject({ ok: true, staging: { status: 'committed' } });
      if (!committed.ok) throw new Error(committed.error);
      const committedRevisionId = committed.staging.committedRevisionId;
      expect(committedRevisionId).toBeTruthy();

      // #1041 追溯:revision provenance 固化 Device 与 WorkspaceRun。
      const workspace = await seedValue.app.getProjectChannelWorkspace({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      if (!workspace.ok) throw new Error(workspace.error);
      expect(workspace.workspace.currentRevision.provenance).toMatchObject({
        kind: 'publish',
        agentId: seedValue.agentId,
        taskId: 'task-x',
        taskAttempt: 1,
        deviceId: seedValue.deviceA.id,
        workspaceRunId: 'run-1',
        baselineRevisionId: seedValue.baselineRevisionId,
      });

      // 撤权后重复 begin/commit 仍收敛到同一 committed 结果,不重复创建 revision。
      await seedValue.app.removeChannelAgentMember({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId, agentId: seedValue.agentId,
      });
      const rebeg = await beginAndPut(seedValue, 'pub-committed-immune', provenance);
      expect(rebeg).toMatchObject({ ok: true, staging: { status: 'committed', committedRevisionId } });
      const recommit = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-committed-immune',
      });
      expect(recommit).toMatchObject({ ok: true, staging: { status: 'committed', committedRevisionId } });
      const revisions = await seedValue.app.listProjectChannelWorkspaceRevisions({
        userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
      });
      if (!revisions.ok) throw new Error(revisions.error);
      expect(revisions.revisions).toHaveLength(2);
    });

    test('commit 产物不携带审核/current/final 语义(目录名与 pathKind 只是定位信息)', async () => {
      seedValue = await seed(variant);
      const begin = await beginAndPut(seedValue, 'pub-no-review-semantics', {
        agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1,
      });
      expect(begin.ok).toBe(true);
      await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-no-review-semantics',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      const committed = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamId,
        channelId: seedValue.channelId,
        publishId: 'pub-no-review-semantics',
      });
      expect(committed).toMatchObject({ ok: true });
      if (!committed.ok) throw new Error(committed.error);
      const revisionFile = committed.workspace?.currentRevision?.files.find((f) => f.path === 'out/result.txt');
      expect(revisionFile).toBeTruthy();
      const artifact = await seedValue.repositories.artifacts.getForTeam({
        teamId: seedValue.teamId, artifactId: revisionFile!.artifactId,
      });
      expect(artifact).toMatchObject({ pathKind: 'workspace', role: 'deliverable' });
      // staging commit 不创建 ProjectArtifactVersion/OutputPackage,更不可能携带 review/current/final。
      const version = await seedValue.repositories.channelProjects.getArtifactVersionByArtifact({
        teamId: seedValue.teamId, channelId: seedValue.channelId, artifactId: revisionFile!.artifactId,
      });
      expect(version).toBeNull();
    });
  });
}
