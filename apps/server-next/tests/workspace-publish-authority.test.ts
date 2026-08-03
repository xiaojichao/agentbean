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

const variants: Array<{ name: string; make: () => { repositories: ServerNextRepositories; close: () => void; globalDb?: DatabaseWithClose } }> = [
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
        globalDb,
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

/**
 * #1056：跨 Team 可见 Agent 的 Workspace publish staging。device token 只证明
 * home Team 身份；目标 Team 的 begin/put/get/commit 由 Agent visibleTeamIds +
 * Channel membership + device 绑定授权，不再要求 primaryTeamId === targetTeamId
 * 或 device owner 是目标 Team 成员。撤权场景继续 fail closed。
 * 同一组断言跑内存与 SQLite 两套仓储。
 */
interface CrossTeamSeed {
  repositories: ServerNextRepositories;
  app: ServerNextUseCases;
  ownerA: string;
  ownerB: string;
  teamA: string;
  teamB: string;
  channelId: string;
  deviceA: { id: string; token: string };
  agentId: string;
  baselineRevisionId: string;
  close: () => void;
}

async function seedCrossTeam(variant: (typeof variants)[number]): Promise<CrossTeamSeed> {
  const { repositories, close, globalDb } = variant.make();
  let now = 100;
  let id = 0;
  const app = createServerNextUseCases({
    repositories,
    clock: { now: () => ++now },
    ids: { nextId: () => `id-${++id}` },
  });
  const registeredA = await app.registerUser({ username: 'owner-a', password: 'secret', teamName: 'TeamA' });
  if (!registeredA.ok) throw new Error(registeredA.error);
  const teamA = registeredA.user.primaryTeamId!;
  const registeredB = await app.registerUser({ username: 'owner-b', password: 'secret', teamName: 'TeamB' });
  if (!registeredB.ok) throw new Error(registeredB.error);
  const teamB = registeredB.user.primaryTeamId!;
  const channelB = await app.createChannel({ userId: registeredB.user.id, teamId: teamB, name: 'project', visibility: 'public' });
  if (!channelB.ok) throw new Error(channelB.error);
  const helloA = await app.deviceHello({ teamId: teamA, ownerId: registeredA.user.id, machineId: 'machine-a', hostname: 'device-a' });
  if (!helloA.ok || !helloA.credentials) throw new Error('device hello failed');
  // primary Team A 的 agent；跨 Team 可见性按仓储实现分别构造：
  // memory 直接 upsert 带 [A,B]（新 agent 取输入值）；sqlite 的可见性派生自
  // agent_publications（upsert 对非 primary 团队的 published_by=agent.id 会撞
  // users 外键），直接插发布行，published_by 用真实用户。
  const agentId = 'agent-cross-publish';
  await repositories.agents.upsert({
    id: agentId, primaryTeamId: teamA,
    visibleTeamIds: globalDb ? [teamA] : [teamA, teamB],
    name: 'cross-agent', source: 'discovered', category: 'agentos-hosted',
    adapterKind: 'hermes', ownerId: registeredA.user.id, deviceId: helloA.device.id,
    status: 'online', lastSeenAt: 1000,
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  } as any);
  globalDb?.prepare(
    'INSERT OR IGNORE INTO agent_publications (agent_id, team_id, published_by, published_at) VALUES (?, ?, ?, ?)',
  ).run(agentId, teamB, registeredA.user.id, 1);
  const member = await app.addChannelAgentMember({
    userId: registeredB.user.id, teamId: teamB, channelId: channelB.channel.id, agentId,
  });
  if (!member.ok) throw new Error(member.error);
  await repositories.artifacts.create({
    id: 'seed-art-b', teamId: teamB, channelId: channelB.channel.id, uploaderId: registeredB.user.id,
    filename: 'base.txt', mimeType: 'text/plain', sizeBytes: 4, pathKind: 'workspace', createdAt: 1,
  });
  const workspace = await app.createProjectChannelWorkspace({
    userId: registeredB.user.id, teamId: teamB, channelId: channelB.channel.id,
    files: [{ path: 'base.txt', artifactId: 'seed-art-b' }],
  });
  if (!workspace.ok) throw new Error(workspace.error);
  return {
    repositories,
    app,
    ownerA: registeredA.user.id,
    ownerB: registeredB.user.id,
    teamA,
    teamB,
    channelId: channelB.channel.id,
    deviceA: { id: helloA.device.id, token: helloA.credentials.token },
    agentId,
    baselineRevisionId: workspace.workspace.currentRevisionId,
    close,
  };
}

for (const variant of variants) {
  describe(`跨 Team 可见 Agent 的 Workspace publish staging (#1056, ${variant.name})`, () => {
    let seedValue: CrossTeamSeed | undefined;
    afterEach(() => {
      seedValue?.close();
      seedValue = undefined;
    });

    test('跨 Team 全链路 begin→put→get→commit 成功并生成目标 Team 的 revision', async () => {
      seedValue = await seedCrossTeam(variant);
      const provenance = { agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 2, workspaceRunId: 'run-x' };
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-1',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance,
      });
      expect(begin).toMatchObject({ ok: true, staging: { status: 'open' } });
      const put = await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-1',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      expect(put).toMatchObject({ ok: true, staging: { files: [{ complete: true }] } });
      const progress = await seedValue.app.getWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-1',
      });
      expect(progress).toMatchObject({ ok: true, staging: { status: 'open' } });
      const committed = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-1',
      });
      expect(committed).toMatchObject({ ok: true, staging: { status: 'committed' } });
      if (!committed.ok) throw new Error(committed.error);
      expect(committed.workspace?.currentRevision?.files.some((f) => f.path === 'out/result.txt')).toBe(true);
      // legacy upload（非投影产物）跨 Team 同样放行。
      const uploaded = await seedValue.app.uploadArtifactForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        filename: 'note.md',
        mimeType: 'text/markdown',
        sizeBytes: 3,
        storagePath: 'x/note.md',
      });
      expect(uploaded).toMatchObject({ ok: true });
    });

    test('begin 无 provenance 的跨 Team device publish fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-noprov',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });

    test('Agent 不可见目标 Team 时 begin fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      await seedValue.repositories.agents.upsert({
        id: 'agent-cross-hidden-pub', primaryTeamId: seedValue.teamA, visibleTeamIds: [seedValue.teamA],
        name: 'hidden-agent', source: 'discovered', category: 'agentos-hosted',
        adapterKind: 'hermes', ownerId: seedValue.ownerA, deviceId: seedValue.deviceA.id,
        status: 'online', lastSeenAt: 1000,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any);
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-hidden',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance: { agentId: 'agent-cross-hidden-pub', taskId: 'task-x', taskAttempt: 1 },
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
    });

    test('membership 移除后 commit fail closed 且无 revision 残留', async () => {
      seedValue = await seedCrossTeam(variant);
      const provenance = { agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1 };
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-revoke',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance,
      });
      expect(begin.ok).toBe(true);
      await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-revoke',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      const removed = await seedValue.app.removeChannelAgentMember({
        userId: seedValue.ownerB, teamId: seedValue.teamB, channelId: seedValue.channelId, agentId: seedValue.agentId,
      });
      expect(removed.ok).toBe(true);
      const commit = await seedValue.app.commitWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-revoke',
      });
      expect(commit).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
      const workspace = await seedValue.app.getProjectChannelWorkspace({
        userId: seedValue.ownerB, teamId: seedValue.teamB, channelId: seedValue.channelId,
      });
      if (!workspace.ok) throw new Error(workspace.error);
      expect(workspace.workspace.currentRevision.id).toBe(seedValue.baselineRevisionId);
    });

    test('Channel archive 后 begin fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      // sqlite 的 channels.update 不写 archived_at（归档走独立 archive 方法），
      // 两种仓储统一用 archive 接口置归档态。
      await seedValue.repositories.channels.archive({ channelId: seedValue.channelId, timestamp: 200 });
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-archived',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance: { agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1 },
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });

    test('Agent/Device 换绑（另一台 device 的 token）fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      const other = await seedValue.app.deviceHello({
        teamId: seedValue.teamA, ownerId: seedValue.ownerA, machineId: 'machine-a2', hostname: 'device-a2',
      });
      if (!other.ok || !other.credentials) throw new Error('other device hello failed');
      const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
        token: other.credentials.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-rebind',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        provenance: { agentId: seedValue.agentId, taskId: 'task-x', taskAttempt: 1 },
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN', details: { reason: 'agent-authority-revoked' } });
    });

    test('无 provenance staging 的跨 Team put/get fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      // ownerB 是 Team B 成员，走人类路径开无 provenance staging（纯用户手工发布）。
      const begin = await seedValue.app.beginWorkspacePublishStaging({
        userId: seedValue.ownerB,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-manual',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
      });
      expect(begin.ok).toBe(true);
      const put = await seedValue.app.putWorkspacePublishStagingFileForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-manual',
        path: 'out/result.txt',
        offset: 0,
        content: BODY,
      });
      expect(put).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      const progress = await seedValue.app.getWorkspacePublishStagingForDevice({
        token: seedValue.deviceA.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-manual',
      });
      expect(progress).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });

    test('跨 Team legacy upload 对未授权 device fail closed', async () => {
      seedValue = await seedCrossTeam(variant);
      const other = await seedValue.app.deviceHello({
        teamId: seedValue.teamA, ownerId: seedValue.ownerA, machineId: 'machine-a3', hostname: 'device-a3',
      });
      if (!other.ok || !other.credentials) throw new Error('other device hello failed');
      const uploaded = await seedValue.app.uploadArtifactForDevice({
        token: other.credentials.token,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        filename: 'note.md',
        mimeType: 'text/markdown',
        sizeBytes: 3,
        storagePath: 'x/note.md',
      });
      expect(uploaded).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      const bad = await seedValue.app.uploadArtifactForDevice({
        token: 'abn_device.garbage.sig',
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        filename: 'note.md',
        mimeType: 'text/markdown',
        sizeBytes: 3,
        storagePath: 'x/note.md',
      });
      expect(bad).toMatchObject({ ok: false, error: 'UNAUTHENTICATED' });
    });

    test('伪造 deviceActorToken 不能绕过成员检查（socket/HTTP payload 注入防线）', async () => {
      seedValue = await seedCrossTeam(variant);
      // ownerA 不是 Team B 成员；模拟恶意 socket 客户端在 payload 里注入
      // deviceActorToken 试图走跨 Team 旁路——验签失败，全部 FORBIDDEN。
      const forged = 'abn_device.forged.sig';
      const begin = await seedValue.app.beginWorkspacePublishStaging({
        userId: seedValue.ownerA,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-forged',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
        deviceActorToken: forged,
      });
      expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      const upload = await seedValue.app.uploadArtifact({
        userId: seedValue.ownerA,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        filename: 'note.md',
        mimeType: 'text/markdown',
        sizeBytes: 3,
        storagePath: 'x/note.md',
        deviceActorToken: forged,
      });
      expect(upload).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      // 不带 token 的人类非成员调用维持原有 FORBIDDEN（行为未变）。
      const plain = await seedValue.app.beginWorkspacePublishStaging({
        userId: seedValue.ownerA,
        teamId: seedValue.teamB,
        channelId: seedValue.channelId,
        publishId: 'pub-xteam-plain',
        baselineRevisionId: seedValue.baselineRevisionId,
        files: planFiles(),
      });
      expect(plain).toMatchObject({ ok: false, error: 'FORBIDDEN' });
    });
  });
}
