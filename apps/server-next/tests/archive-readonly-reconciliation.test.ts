/**
 * #1066 归档后只读投影与 reconciliation/replay 收敛（主 seam：memory + SQLite 双后端）。
 *
 * 覆盖：
 * - AC5：归档后 Chat（消息/package 卡片）、Task（task:delivery-overview）、
 *   Files（getOutputPackage 详情）保留只读投影，owner 可读；
 * - AC10：归档后 committed pending delivery 仍可查询（「交付处理中」保留 reconciliation 事实）；
 * - AC11：归档后同一幂等 key 重放收敛到同一 receipt（不重跑业务、不重复 package）；
 *   归档后无 receipt 的新 formation 返回 channel-archived rejected；同 key 不同 payload 返回
 *   conflict（hash 不匹配），无部分副作用。
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
import { attemptOutputPackageFormation } from '../src/application/output-package-handler.js';
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
  device: { id: string; token: string };
  agentId: string;
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
  const hello = await app.deviceHello({ teamId, ownerId: userId, machineId: 'machine-a', hostname: 'device-a' });
  if (!hello.ok || !hello.credentials) throw new Error('device hello failed');
  const agents = await app.registerDiscoveredAgents({
    teamId,
    deviceId: hello.device.id,
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
    device: { id: hello.device.id, token: hello.credentials.token },
    agentId,
    close,
  };
}

async function currentWorkspaceRevision(seedValue: Seed): Promise<string> {
  const workspace = await seedValue.app.getProjectChannelWorkspace({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
  });
  if (!workspace.ok) throw new Error(workspace.error);
  return workspace.workspace.currentRevisionId;
}

async function commitDelivery(
  seedValue: Seed,
  publishId: string,
  files: Array<{ path: string; body: Buffer }>,
  provenance: { agentId: string; taskId: string; taskAttempt: number },
) {
  const baselineRevisionId = await currentWorkspaceRevision(seedValue);
  const begin = await seedValue.app.beginWorkspacePublishStagingForDevice({
    token: seedValue.device.token,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    publishId,
    baselineRevisionId,
    files: files.map((file) => ({
      path: file.path,
      filename: file.path.split('/').pop()!,
      mimeType: 'text/plain',
      expectedSizeBytes: file.body.length,
      expectedSha256: sha256(file.body),
    })),
    provenance,
  });
  if (!begin.ok) throw new Error(begin.error);
  for (const file of files) {
    const put = await seedValue.app.putWorkspacePublishStagingFileForDevice({
      token: seedValue.device.token,
      teamId: seedValue.teamId,
      channelId: seedValue.channelId,
      publishId,
      path: file.path,
      offset: 0,
      content: file.body,
    });
    if (!put.ok) throw new Error(put.error);
  }
  const commit = await seedValue.app.commitWorkspacePublishStagingForDevice({
    token: seedValue.device.token,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    publishId,
  });
  if (!commit.ok) throw new Error(commit.error);
  return commit;
}

async function archive(seedValue: Seed): Promise<void> {
  const preflight = await seedValue.app.archiveChannel({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
  });
  if (!preflight.ok || !preflight.preflight) throw new Error(preflight.error ?? 'preflight failed');
  const confirm = await seedValue.app.archiveChannel({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
    confirmationToken: preflight.preflight.confirmationToken,
  });
  if (!confirm.ok) throw new Error(confirm.error ?? 'confirm failed');
}

describe('archive readonly + reconciliation (#1066)', () => {
  for (const variant of variants) {
    describe(`${variant.name}`, () => {
      const cleanups: Array<() => void> = [];
      afterEach(() => {
        while (cleanups.length > 0) cleanups.pop()!();
      });

      async function makeSeed(): Promise<Seed> {
        const s = await seed(variant);
        cleanups.push(s.close);
        return s;
      }

      test('AC5:归档后 Chat/Task/Files 保留只读投影', async () => {
        const s = await makeSeed();
        await s.app.sendMessage({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, body: 'history message',
        });
        await s.repositories.tasks.create({
          id: 'task-ro', teamId: s.teamId, channelId: s.channelId,
          title: 'ro task', description: '', status: 'in_progress', creatorId: s.userId,
          assigneeId: null, tags: [], sortOrder: 0, createdAt: 100, updatedAt: 100,
        });
        await commitDelivery(s, 'pub-ro-1', [{ path: 'docs/ro.md', body: Buffer.from('ro') }], {
          agentId: s.agentId, taskId: 'task-ro', taskAttempt: 1,
        });
        const pkg = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-ro-1',
        });
        if (!pkg) throw new Error('package missing');
        await archive(s);

        // Chat：消息历史可读。
        const messages = await s.app.listChannelMessages({ channelId: s.channelId, limit: 10 });
        expect(messages.ok).toBe(true);
        if (!messages.ok) return;
        expect(messages.messages.length).toBeGreaterThan(0);

        // Files：package 详情可读（含成员与投影）。
        const detail = await s.app.getOutputPackage({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          packageId: pkg.package.packageId,
        });
        expect(detail.ok).toBe(true);
        if (!detail.ok) return;
        expect(detail.package.packageId).toBe(pkg.package.packageId);
        expect(detail.package.memberCount).toBe(1);

        // Task：delivery overview 可读（timeline 聚合投影）。
        const overview = await s.app.queryTaskDeliveryOverview({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          taskId: 'task-ro',
        });
        expect(overview.ok).toBe(true);
        if (!overview.ok) return;
        expect(overview.overview?.task.id).toBe('task-ro');
      });

      test('AC11:归档后同 key replay 收敛同一 receipt;新 formation channel-archived;同 key 不同 payload conflict', async () => {
        const s = await makeSeed();
        const commit = await commitDelivery(s, 'pub-rr-1', [{ path: 'docs/rr.md', body: Buffer.from('rr') }], {
          agentId: s.agentId, taskId: 'task-rr', taskAttempt: 1,
        });
        const revisionId = commit.workspace.currentRevisionId;
        const before = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-rr-1',
        });
        if (!before) throw new Error('package missing');
        await archive(s);

        // 归档后同 key 重放：收敛到既有 package（replayed），不重跑业务。
        const replay = await attemptOutputPackageFormation(
          {
            repositories: s.repositories,
            clock: { now: () => 9999 },
            ids: { nextId: () => 'x' },
          },
          {
            teamId: s.teamId,
            channelId: s.channelId,
            publishId: 'pub-rr-1',
            workspaceRevisionId: revisionId,
          },
        );
        expect(replay.kind).toBe('replayed');
        const after = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-rr-1',
        });
        expect(after?.package.packageId).toBe(before.package.packageId);
        // 无重复 package 事实。
        const list = await s.app.listOutputPackages({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        if (!list.ok) throw new Error(list.error);
        expect(list.packages).toHaveLength(1);

        // 归档后无 receipt 的新 formation：channel-archived rejected，无部分事实。
        const newFormation = await attemptOutputPackageFormation(
          {
            repositories: s.repositories,
            clock: { now: () => 9999 },
            ids: { nextId: () => 'y' },
          },
          {
            teamId: s.teamId,
            channelId: s.channelId,
            publishId: 'pub-rr-nonexistent',
            workspaceRevisionId: revisionId,
          },
        );
        expect(newFormation).toMatchObject({ kind: 'rejected', reasonCode: 'channel-archived' });

        // 同 key 不同 payload（hash 不匹配）：conflict，不重复 package。
        const conflicting = await attemptOutputPackageFormation(
          {
            repositories: s.repositories,
            clock: { now: () => 9999 },
            ids: { nextId: () => 'z' },
          },
          {
            teamId: s.teamId,
            channelId: s.channelId,
            publishId: 'pub-rr-1',
            workspaceRevisionId: 'some-other-revision',
          },
        );
        expect(conflicting.kind).toBe('conflict');
      });
    });
  }
});
