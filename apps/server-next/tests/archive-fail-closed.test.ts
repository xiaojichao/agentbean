/**
 * #1066 归档后 fail-closed 与撤权即时生效（主 seam：memory + SQLite 双后端）。
 *
 * 覆盖：
 * - AC4：归档事务完成后，全部写 command 返回结构化 rejected/conflict，且无部分副作用
 *   （消息/document/review/package/staging 零新增、Task 状态零推进）；
 * - AC7：成员被移出 Channel 后，后续 query（含旧 cursor）与写命令立即按当前 authority
 *   fail closed，不依赖客户端已取得的数据继续授权；
 * - AC5：归档后 owner 仍可读（只读历史投影），仅写路径拒绝。
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

async function seed(variant: (typeof variants)[number], visibility: 'public' | 'private' = 'public'): Promise<Seed> {
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
  const channel = await app.createChannel({ userId, teamId, name: 'project', visibility });
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

describe('archive fail-closed (#1066)', () => {
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

      test('AC4:归档后写命令全部 fail closed 且无部分副作用', async () => {
        const s = await makeSeed();
        // 预置事实：一条消息、一个 document（若 markdownEditing 开启）、一个 package。
        await s.app.sendMessage({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, body: 'before archive',
        });
        const workspaceRevision = (await s.app.getProjectChannelWorkspace({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        })).workspace!.currentRevisionId;
        const docSave = await s.app.saveChannelDocument({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          documentId: `channel-document:seed-art`,
          baseRevisionId: workspaceRevision,
          filename: 'notes.md',
          content: '# notes',
        });
        // markdownEditing 可能未开启（NOT_FOUND）；开启时归档前保存必须成功。
        const hadDocument = docSave.ok;

        // 形成 package 供 review 命令瞄准。
        const baselineRevisionId = (await s.app.getProjectChannelWorkspace({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        })).workspace!.currentRevisionId;
        const body = Buffer.from('deliver');
        const begin = await s.app.beginWorkspacePublishStagingForDevice({
          token: s.device.token,
          teamId: s.teamId,
          channelId: s.channelId,
          publishId: 'pub-fc-1',
          baselineRevisionId,
          files: [{ path: 'docs/fc.md', filename: 'fc.md', mimeType: 'text/plain', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
          provenance: { agentId: s.agentId, taskId: 'task-fc', taskAttempt: 1 },
        });
        if (!begin.ok) throw new Error(begin.error);
        await s.app.putWorkspacePublishStagingFileForDevice({
          token: s.device.token, teamId: s.teamId, channelId: s.channelId,
          publishId: 'pub-fc-1', path: 'docs/fc.md', offset: 0, content: body,
        });
        const commit = await s.app.commitWorkspacePublishStagingForDevice({
          token: s.device.token, teamId: s.teamId, channelId: s.channelId, publishId: 'pub-fc-1',
        });
        if (!commit.ok) throw new Error(commit.error);
        const pkg = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-fc-1',
        });
        if (!pkg) throw new Error('package missing');
        const member = pkg.members[0]!;

        await archive(s);

        // 基线快照。
        const messagesBefore = await s.repositories.messages.listByChannel(s.channelId, Number.MAX_SAFE_INTEGER);
        const documentsBefore = await s.repositories.channelDocuments.listByChannel({
          teamId: s.teamId, channelId: s.channelId,
        });
        const reviewsBefore = await s.repositories.channelProjects.listArtifactReviews({
          teamId: s.teamId, channelId: s.channelId,
        });
        const taskBefore = await s.repositories.tasks.getById('task-fc');
        const taskStatusBefore = taskBefore?.status;

        // 表驱动：每个写命令返回结构化失败。
        const send = await s.app.sendMessage({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, body: 'after archive',
        });
        expect(send.ok).toBe(false);
        expect(send.error).toBeTruthy();

        // 归档后保存被拒：document 存在时归档检查先于内容提交 → FORBIDDEN（结构化拒绝且零副作用）。
        const save = await s.app.saveChannelDocument({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          documentId: `channel-document:seed-art`,
          baseRevisionId: workspaceRevision,
          filename: 'notes.md',
          content: '# edited after archive',
        });
        expect(save.ok).toBe(false);
        expect(save.error).toBeTruthy();
        if (hadDocument) {
          // 归档前保存成功 → 归档后必须命中 archivedAt 检查（FORBIDDEN），而非 NOT_FOUND。
          expect(save.error).toBe('FORBIDDEN');
        }

        const review = await s.app.submitPackageArtifactReview({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          packageId: pkg.package.packageId,
          collectionId: member.collectionId,
          versionId: member.artifactVersionId,
          decision: 'approved',
          comment: 'after archive',
          idempotencyKey: `review-fc:${member.artifactVersionId}`,
        });
        expect(review.ok).toBe(false);
        expect(review.error).toBeTruthy();

        const publish = await s.app.beginWorkspacePublishStagingForDevice({
          token: s.device.token,
          teamId: s.teamId,
          channelId: s.channelId,
          publishId: 'pub-fc-2',
          baselineRevisionId,
          files: [{ path: 'docs/fc2.md', filename: 'fc2.md', mimeType: 'text/plain', expectedSizeBytes: 1, expectedSha256: sha256('x') }],
          provenance: { agentId: s.agentId, taskId: 'task-fc', taskAttempt: 1 },
        });
        expect(publish).toMatchObject({ ok: false, error: 'FORBIDDEN' });

        // 无部分副作用：零新增、零状态推进。
        const messagesAfter = await s.repositories.messages.listByChannel(s.channelId, Number.MAX_SAFE_INTEGER);
        expect(messagesAfter).toHaveLength(messagesBefore.length);
        const documentsAfter = await s.repositories.channelDocuments.listByChannel({
          teamId: s.teamId, channelId: s.channelId,
        });
        expect(documentsAfter).toHaveLength(documentsBefore.length);
        const reviewsAfter = await s.repositories.channelProjects.listArtifactReviews({
          teamId: s.teamId, channelId: s.channelId,
        });
        expect(reviewsAfter).toHaveLength(reviewsBefore.length);
        const taskAfter = await s.repositories.tasks.getById('task-fc');
        expect(taskAfter?.status).toBe(taskStatusBefore);
        const strayStaging = await s.repositories.workspacePublishStagings.getByPublishId({
          teamId: s.teamId, publishId: 'pub-fc-2',
        });
        expect(strayStaging).toBeNull();
      });

      test('AC7:成员被移出后 query（含旧 cursor）与写命令立即 fail closed', async () => {
        // private 频道：成员是读权限边界；移出即拒绝后续 query/preview/send。
        const s = await seed(variant, 'private');
        cleanups.push(s.close);
        // 第二成员加入（team 直插，避免 registerUser 建同名 team 路径冲突）。
        const register2 = await s.app.registerUser({ username: 'member2', password: 'secret', teamName: 'Team2' });
        if (!register2.ok) throw new Error(register2.error);
        const user2 = register2.user.id;
        await s.repositories.teams.addMember({
          teamId: s.teamId, userId: user2, role: 'member', joinedAt: 100,
        });
        const join = await s.app.addChannelHumanMember({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, memberUserId: user2,
        });
        if (!join.ok) throw new Error(join.error);

        const before = await s.app.listOutputPackages({
          userId: user2, teamId: s.teamId, channelId: s.channelId, limit: 10,
        });
        expect(before.ok).toBe(true);
        if (!before.ok) return;
        const oldCursor = before.nextCursor;

        // 移除成员后：旧 cursor 请求立即 FORBIDDEN（authority 复验优先于 cursor）。
        const remove = await s.app.removeChannelHumanMember({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, memberUserId: user2,
        });
        expect(remove.ok).toBe(true);

        const withCursor = await s.app.listOutputPackages({
          userId: user2, teamId: s.teamId, channelId: s.channelId, limit: 10, ...(oldCursor ? { cursor: oldCursor } : {}),
        });
        expect(withCursor.ok).toBe(false);
        expect(withCursor.error).toBe('FORBIDDEN');

        const send = await s.app.sendMessage({
          userId: user2, teamId: s.teamId, channelId: s.channelId, body: 'should be rejected',
        });
        expect(send).toMatchObject({ ok: false, error: 'FORBIDDEN' });
      });

      test('AC5:归档后 owner 仍可读（只读历史），写路径拒绝', async () => {
        const s = await makeSeed();
        await s.app.sendMessage({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, body: 'history message',
        });
        await archive(s);

        const list = await s.app.listOutputPackages({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(list.ok).toBe(true);
        const messages = await s.app.listChannelMessages({ channelId: s.channelId, limit: 10 });
        expect(messages.ok).toBe(true);
        if (!messages.ok) return;
        expect(messages.messages.length).toBeGreaterThan(0);
      });
    });
  }
});
