/**
 * #1066 归档 Channel 并收口撤权、恢复与只读历史（主 seam：memory + SQLite 双后端）。
 *
 * 覆盖：
 * - AC1：archive preflight 列出 package 级待审核 delivery（#1061 reviews 聚合非 approved）
 *   与尚未收敛的 package projection（pendingDeliveries 差集），confirm 事务内复验；
 * - AC2：归档事务把频道内 open/failed publish staging 显式收口为 terminal failed
 *   （Device 不能自行宣布已收口）；committed staging 保留（reconciliation 只读数据源）；
 * - AC4：归档后并发新 publish / 消息发送 fail closed（结构化错误，无部分副作用）；
 * - AC5/AC10：归档后 pendingDeliveries 投影仍可读（「交付处理中」不消失）；
 * - AC12：归档审计记录（actor/authority basis/revision/outcome/受影响清单/时间）。
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

/** managed Task + coordination 的最小 seed（含 management run FK，双后端字段齐全）。 */
async function seedManagedTask(seedValue: Seed, taskId: string, attempt: number, runId = 'run-1') {
  await seedValue.repositories.management.runs.create({
    schemaVersion: 1,
    id: runId,
    teamId: seedValue.teamId,
    channelId: seedValue.channelId,
    rootMessageId: `msg-${runId}`,
    mode: 'managed',
    status: 'running',
    placementPolicy: { placement: 'auto', allowServerContext: false, requireLocalModelCredentials: false },
    checkpointRevision: 0,
    budget: { maxSubtasks: 4, maxDepth: 3, maxExternalInvocations: 8 },
    createdAt: 100,
    updatedAt: 100,
  });
  await seedValue.repositories.tasks.create({
    id: taskId,
    teamId: seedValue.teamId,
    title: 'deliver docs',
    status: 'in_progress',
    creatorId: seedValue.userId,
    channelId: seedValue.channelId,
    tags: [],
    sortOrder: 0,
    createdAt: 100,
    updatedAt: 100,
  });
  await seedValue.repositories.taskCoordination.coordinations.create({
    taskId,
    teamId: seedValue.teamId,
    managementRunId: runId,
    nodeKind: 'subtask',
    reviewPolicy: 'manager',
    claimPolicy: 'open',
    requiredCapabilities: [],
    acceptanceCriteria: [],
    dependencyTaskIds: [],
    attempt,
    maxAttempts: 3,
    taskRevision: 1,
    offerId: null,
    status: 'accepted',
    claimLeaseId: null,
    humanAcceptanceAuthorityIds: null,
    manifestRevision: 0,
    createdAt: 100,
    updatedAt: 100,
  });
}

async function archive(seedValue: Seed): Promise<{ preflight: import('@agentbean/contracts').ChannelArchivePreflightDto }> {
  const preflight = await seedValue.app.archiveChannel({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
  });
  if (!preflight.ok || !preflight.preflight) throw new Error(preflight.error ?? 'preflight failed');
  const confirm = await seedValue.app.archiveChannel({
    userId: seedValue.userId, teamId: seedValue.teamId, channelId: seedValue.channelId,
    confirmationToken: preflight.preflight.confirmationToken,
  });
  if (!confirm.ok || !confirm.confirmation) throw new Error(confirm.error ?? 'confirm failed');
  return { preflight: preflight.preflight };
}

describe('archive gate closeout (#1066)', () => {
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

      test('AC1/AC12:preflight 列出 pending delivery 与 package 级待审核 delivery;confirm 收口 staging 并写审计', async () => {
        const s = await makeSeed();
        const taskId = 'task-gate-1';
        await seedManagedTask(s, taskId, 2);
        // attempt=1 声明与 coordination attempt=2 漂移 → commit 成功但 formation 被 fence 拒绝
        // → 留下 committed staging（pendingDeliveries 差集数据源）。
        await commitDelivery(s, 'pub-pending-1', [{ path: 'docs/p.md', body: Buffer.from('p') }], {
          agentId: s.agentId, taskId, taskAttempt: 1,
        });
        // 正常 delivery：package 形成（成员无 review → reviewState pending）。
        await commitDelivery(s, 'pub-pkg-1', [{ path: 'docs/a.md', body: Buffer.from('a') }], {
          agentId: s.agentId, taskId: 'task-gate-2', taskAttempt: 1,
        });
        // open staging：begin 未 commit（传输中会话）。
        const body = Buffer.from('open');
        const begin = await s.app.beginWorkspacePublishStagingForDevice({
          token: s.device.token,
          teamId: s.teamId,
          channelId: s.channelId,
          publishId: 'pub-open-1',
          baselineRevisionId: await currentWorkspaceRevision(s),
          files: [{ path: 'docs/o.md', filename: 'o.md', mimeType: 'text/plain', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
          provenance: { agentId: s.agentId, taskId: 'task-gate-3', taskAttempt: 1 },
        });
        expect(begin.ok).toBe(true);

        // preflight：pendingDeliveries=1（pub-pending-1），pending_review_delivery 含 pub-pkg-1 的 package。
        const preflight = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(preflight.ok).toBe(true);
        if (!preflight.ok || !preflight.preflight) return;
        expect(preflight.preflight.summary.pendingDeliveries).toBe(1);
        expect(preflight.preflight.items.filter((item) => item.kind === 'pending_delivery')).toHaveLength(1);
        expect(preflight.preflight.items.filter((item) => item.kind === 'pending_delivery')[0]!.id).toBe('pub-pending-1');
        const reviewDeliveryItems = preflight.preflight.items.filter((item) => item.kind === 'pending_review_delivery');
        expect(reviewDeliveryItems).toHaveLength(1);

        // confirm：open staging → terminal failed；committed pending staging 保留；审计写入。
        const confirm = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
          confirmationToken: preflight.preflight.confirmationToken,
        });
        expect(confirm.ok).toBe(true);
        if (!confirm.ok || !confirm.confirmation) return;
        expect(confirm.confirmation.cancelledStagingCount).toBe(1);
        expect(confirm.confirmation.pendingReviewDeliveryIds).toContain(reviewDeliveryItems[0]!.id);

        const openAfter = await s.repositories.workspacePublishStagings.getByPublishId({
          teamId: s.teamId, publishId: 'pub-open-1',
        });
        expect(openAfter?.status).toBe('failed');
        const committedAfter = await s.repositories.workspacePublishStagings.getByPublishId({
          teamId: s.teamId, publishId: 'pub-pending-1',
        });
        expect(committedAfter?.status).toBe('committed');

        // AC12 审计：actor/authority basis/revision/outcome/受影响清单/时间。
        const archives = await s.repositories.channelArchives.listByChannel({
          teamId: s.teamId, channelId: s.channelId,
        });
        expect(archives).toHaveLength(1);
        const record = archives[0]!;
        expect(record.actorUserId).toBe(s.userId);
        expect(record.authorityBasis).toBe('channel_creator');
        expect(record.outcome).toBe('archived');
        expect(record.channelRevision).toBeGreaterThan(0);
        expect(record.pendingDeliveryCount).toBe(1);
        expect(record.cancelledStagingCount).toBe(1);
        expect(record.pendingReviewDeliveryIds).toEqual(confirm.confirmation.pendingReviewDeliveryIds);
        expect(record.archivedAt).toBeGreaterThan(0);
      });

      test('AC2/AC10:归档后并发 publish 与消息发送 fail closed;committed pending delivery 只读保留', async () => {
        const s = await makeSeed();
        const taskId = 'task-gate-2';
        await seedManagedTask(s, taskId, 2);
        await commitDelivery(s, 'pub-pending-2', [{ path: 'docs/q.md', body: Buffer.from('q') }], {
          agentId: s.agentId, taskId, taskAttempt: 1,
        });
        await archive(s);

        // 新 publish：begin fail closed（channel-archived），无 staging 残留。
        const body = Buffer.from('after');
        const begin = await s.app.beginWorkspacePublishStagingForDevice({
          token: s.device.token,
          teamId: s.teamId,
          channelId: s.channelId,
          publishId: 'pub-after-1',
          baselineRevisionId: await currentWorkspaceRevision(s),
          files: [{ path: 'docs/n.md', filename: 'n.md', mimeType: 'text/plain', expectedSizeBytes: body.length, expectedSha256: sha256(body) }],
          provenance: { agentId: s.agentId, taskId: 'task-after', taskAttempt: 1 },
        });
        expect(begin).toMatchObject({ ok: false, error: 'FORBIDDEN' });
        const afterStaging = await s.repositories.workspacePublishStagings.getByPublishId({
          teamId: s.teamId, publishId: 'pub-after-1',
        });
        expect(afterStaging).toBeNull();

        // 消息发送 fail closed。
        const send = await s.app.sendMessage({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, body: 'hello after archive',
        });
        expect(send).toMatchObject({ ok: false, error: 'VALIDATION_ERROR' });

        // AC10：已 committed 的 pending delivery 只读保留（「交付处理中」不消失）。
        const list = await s.app.listOutputPackages({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(list.ok).toBe(true);
        if (!list.ok) return;
        expect(list.packages).toHaveLength(0);
        expect(list.pendingDeliveries).toHaveLength(1);
        expect(list.pendingDeliveries[0]!.publishId).toBe('pub-pending-2');
      });

      test('AC1:review approved 后 pending review delivery 收敛,不再列入 preflight', async () => {
        const s = await makeSeed();
        await seedManagedTask(s, 'task-gate-3', 1);
        await commitDelivery(s, 'pub-pkg-2', [{ path: 'docs/r.md', body: Buffer.from('r') }], {
          agentId: s.agentId, taskId: 'task-gate-3', taskAttempt: 1,
        });
        const byPublish = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-pkg-2',
        });
        expect(byPublish).not.toBeNull();
        if (!byPublish) return;
        const member = byPublish.members[0]!;

        const preflightBefore = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(preflightBefore.ok).toBe(true);
        if (!preflightBefore.ok || !preflightBefore.preflight) return;
        expect(preflightBefore.preflight.items.some((item) => item.kind === 'pending_review_delivery')).toBe(true);

        // owner approved 后 reviewState 收敛 → 新 preflight 不再列出。
        const review = await s.app.submitPackageArtifactReview({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          packageId: byPublish.package.packageId,
          collectionId: member.collectionId,
          versionId: member.artifactVersionId,
          decision: 'approved',
          comment: '合格',
          idempotencyKey: `review-gate:${member.artifactVersionId}`,
        });
        expect(review.ok).toBe(true);

        const preflightAfter = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(preflightAfter.ok).toBe(true);
        if (!preflightAfter.ok || !preflightAfter.preflight) return;
        expect(preflightAfter.preflight.items.some((item) => item.kind === 'pending_review_delivery')).toBe(false);
      });

      test('AC1:review 终态（rejected）不进 gate——只有 pending 的待审核 delivery 列出', async () => {
        const s = await makeSeed();
        await seedManagedTask(s, 'task-gate-4', 1);
        await commitDelivery(s, 'pub-pkg-3', [{ path: 'docs/s.md', body: Buffer.from('s') }], {
          agentId: s.agentId, taskId: 'task-gate-4', taskAttempt: 1,
        });
        const byPublish = await s.repositories.outputPackages.getPackageByPublishId({
          teamId: s.teamId, publishId: 'pub-pkg-3',
        });
        if (!byPublish) throw new Error('package missing');
        const member = byPublish.members[0]!;

        const review = await s.app.submitPackageArtifactReview({
          userId: s.userId,
          teamId: s.teamId,
          channelId: s.channelId,
          packageId: byPublish.package.packageId,
          collectionId: member.collectionId,
          versionId: member.artifactVersionId,
          decision: 'rejected',
          comment: '不合格',
          idempotencyKey: `review-gate-rej:${member.artifactVersionId}`,
        });
        expect(review.ok).toBe(true);

        // rejected 是已收敛的终态审核结果：归档清单不得永久残留。
        const preflight = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(preflight.ok).toBe(true);
        if (!preflight.ok || !preflight.preflight) return;
        expect(preflight.preflight.items.some((item) => item.kind === 'pending_review_delivery')).toBe(false);
      });

      test('AC3:channel revision 变化后旧 confirmation token 失效,归档被拒', async () => {
        const s = await makeSeed();
        const preflight = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
        });
        expect(preflight.ok).toBe(true);
        if (!preflight.ok || !preflight.preflight) return;
        // 归档确认前发生真实并发写命令（channel revision 推进，与归档提交线性化）。
        const rename = await s.app.updateChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId, name: 'renamed',
        });
        expect(rename.ok).toBe(true);
        const confirm = await s.app.archiveChannel({
          userId: s.userId, teamId: s.teamId, channelId: s.channelId,
          confirmationToken: preflight.preflight.confirmationToken,
        });
        expect(confirm.ok).toBe(false);
        expect(confirm.message).toContain('modified after preflight');
        // 未归档。
        const channel = await s.repositories.channels.getById(s.channelId);
        expect(channel?.archivedAt).toBeFalsy();
      });
    });
  }
});
