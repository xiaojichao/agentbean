import { createRequire } from 'node:module';
import { afterEach, beforeEach, describe, expect, test } from 'vitest';

import { createServerNextUseCases, type ServerNextUseCases } from '../src/application/usecases.js';
import { parseChannelFileRolloutConfig } from '../src/application/channel-file-rollout.js';
import {
  DEFAULT_PROJECT_DOCUMENT_ROLLOUT,
  parseProjectDocumentRolloutConfig,
} from '../src/application/project-document-rollout.js';
import { createProjectDocumentBundleBackfill } from '../src/application/project-document-bundle-backfill.js';
import {
  applyGlobalMigrations,
  applyTeamMigrations,
  createSqliteRepositories,
  type SqliteDatabase,
} from '../src/infra/sqlite/repositories.js';
import type { ServerNextRepositories } from '../src/application/repositories.js';

type DatabaseWithClose = SqliteDatabase & { close(): void };
type DatabaseConstructor = new (filename: string) => DatabaseWithClose;
const Database = createRequire(import.meta.url)('better-sqlite3') as DatabaseConstructor;

const MARKDOWN_ROLLOUT = parseChannelFileRolloutConfig({
  AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING: 'on',
});

const SOURCE_ROOT = { id: 'root-output', kind: 'run_output' as const, label: '运行输出' };

/**
 * #830：回填的验收面是「哪些历史 Run 被分组、哪些保持未分组、原因是什么」。
 * 因此测试一律跑真实 SQLite —— 候选发现与成员事实都是原始 SQL，用内存仓储会把
 * 这两段查询整个跳过。
 */
describe('#830 保守回填历史 Markdown 文档包', () => {
  let globalDb: DatabaseWithClose;
  let teamDb: DatabaseWithClose;
  let repositories: ServerNextRepositories;
  let app: ServerNextUseCases;
  let now = 1_000;
  let id = 0;

  const createBackfill = (input: {
    mode?: 'dry_run' | 'apply';
    batchSize?: number;
    backfillId?: string;
    repositories?: ServerNextRepositories;
  } = {}) => createProjectDocumentBundleBackfill({
    repositories: input.repositories ?? repositories,
    app,
    clock: { now: () => ++now },
    mode: input.mode ?? 'apply',
    ...(input.batchSize !== undefined ? { batchSize: input.batchSize } : {}),
    ...(input.backfillId ? { backfillId: input.backfillId } : {}),
  });

  const deriveDocument = async (input: {
    artifactId: string;
    filename: string;
  }): Promise<{ documentId: string; revisionId: string }> => {
    const result = await app.deriveChannelDocument({
      userId: 'owner-1',
      teamId: 'team-1',
      channelId: 'channel-1',
      sourceArtifactId: input.artifactId,
      filename: input.filename,
      content: `# ${input.filename}\n`,
    });
    if (!result.ok) throw new Error(`derive failed: ${result.error} ${result.message ?? ''}`);
    return { documentId: result.document.id, revisionId: result.document.currentRevisionId };
  };

  const listBundles = async () => {
    const listed = await app.listProjectDocumentBundles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    if (!listed.ok) throw new Error('bundle list failed');
    return listed.bundles;
  };

  beforeEach(async () => {
    globalDb = new Database(':memory:');
    teamDb = new Database(':memory:');
    globalDb.exec('PRAGMA foreign_keys = ON;');
    teamDb.exec('PRAGMA foreign_keys = ON;');
    applyGlobalMigrations(globalDb);
    applyTeamMigrations(teamDb);
    repositories = createSqliteRepositories({ globalDb, teamDb });
    app = createServerNextUseCases({
      repositories,
      clock: { now: () => ++now },
      ids: { nextId: () => `generated-id-${++id}` },
      messageIngestionMode: 'legacy',
      channelFileRollout: MARKDOWN_ROLLOUT,
    });

    for (const user of [
      { id: 'owner-1', username: 'owner' },
      { id: 'member-1', username: 'member' },
    ]) {
      await repositories.users.create({
        ...user, passwordHash: 'hash', role: 'user', createdAt: now, updatedAt: now,
      });
    }
    await repositories.teams.create({
      id: 'team-1', name: '项目团队', path: 'project-team',
      visibility: 'private', ownerId: 'owner-1', createdAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'owner-1', username: 'owner', role: 'owner', joinedAt: now,
    });
    await repositories.teams.addMember({
      teamId: 'team-1', userId: 'member-1', username: 'member', role: 'member', joinedAt: now,
    });
    await repositories.channels.create({
      id: 'channel-1', teamId: 'team-1', kind: 'channel', name: 'launch',
      visibility: 'private', createdBy: 'owner-1',
      humanMemberIds: ['owner-1', 'member-1'], agentMemberIds: ['agent-1'],
      createdAt: now, updatedAt: now, archivedAt: null, revision: 1,
    });

    // 三次运行：run-1 产出两份 Markdown，run-2 产出一份，run-3 事后被标为内部 handoff。
    for (const run of [
      { runId: 'run-1', dispatchId: 'dispatch-1', createdAt: 1_100 },
      { runId: 'run-2', dispatchId: 'dispatch-2', createdAt: 1_200 },
      { runId: 'run-3', dispatchId: 'dispatch-3', createdAt: 1_300 },
    ]) {
      await repositories.dispatches.create({
        id: run.dispatchId, teamId: 'team-1', channelId: 'channel-1',
        messageId: `message-${run.runId}`, agentId: 'agent-1', status: 'succeeded',
        requestId: `request-${run.runId}`, prompt: '生成文档',
        createdAt: run.createdAt, updatedAt: run.createdAt,
      });
      await repositories.workspaceRuns.create({
        id: run.runId, teamId: 'team-1', channelId: 'channel-1', dispatchId: run.dispatchId,
        agentId: 'agent-1', status: 'succeeded',
        createdAt: run.createdAt, updatedAt: run.createdAt, artifactIds: [],
      });
    }

    for (const artifact of [
      { id: 'artifact-plan', filename: 'plan.md', relativePath: 'docs/plan.md', workspaceRunId: 'run-1', dispatchId: 'dispatch-1' },
      { id: 'artifact-spec', filename: 'spec.md', relativePath: 'docs/spec.md', workspaceRunId: 'run-1', dispatchId: 'dispatch-1' },
      { id: 'artifact-solo', filename: 'solo.md', relativePath: 'docs/solo.md', workspaceRunId: 'run-2', dispatchId: 'dispatch-2' },
      { id: 'artifact-internal-a', filename: 'internal-a.md', relativePath: 'docs/internal-a.md', workspaceRunId: 'run-3', dispatchId: 'dispatch-3' },
      { id: 'artifact-internal-b', filename: 'internal-b.md', relativePath: 'docs/internal-b.md', workspaceRunId: 'run-3', dispatchId: 'dispatch-3' },
    ]) {
      await repositories.artifacts.create({
        ...artifact, teamId: 'team-1', channelId: 'channel-1',
        mimeType: 'text/markdown', uploaderId: 'agent-1', sizeBytes: 32,
        sourceRoot: SOURCE_ROOT, pathKind: 'generated', role: 'run_output', createdAt: now,
      });
    }
  });

  afterEach(() => {
    globalDb.close();
    teamDb.close();
  });

  /** 事后把 run-3 变成内部 handoff：文档必须先在公开状态下建立，否则根本不会存在。 */
  const makeRunInternal = async () => {
    await repositories.management.runs.create({
      schemaVersion: 1, id: 'management-run-1', teamId: 'team-1', channelId: 'channel-1',
      rootMessageId: 'message-run-3', mode: 'managed', status: 'running',
      placementPolicy: { placement: 'device', allowServerContext: false, requireLocalModelCredentials: true },
      checkpointRevision: 0, budget: { maxSubtasks: 20, maxDepth: 3, maxExternalInvocations: 20 },
      createdAt: now, updatedAt: now,
    });
    await repositories.management.invocations.create({
      schemaVersion: 1, id: 'invocation-internal', managementRunId: 'management-run-1',
      intent: {
        schemaVersion: 1, teamId: 'team-1', channelId: 'channel-1', targetAgentId: 'agent-1',
        targetKind: 'custom', objective: '内部咨询', acceptanceCriteria: [],
        dependencyResults: [], attachmentIds: [],
      },
      intentHash: 'sha256:internal', idempotencyKey: 'internal-invocation', createdAt: now,
    });
    await repositories.management.dispatchAttempts.create({
      id: 'attempt-internal', invocationId: 'invocation-internal', dispatchId: 'dispatch-3',
      attemptNumber: 1, status: 'succeeded', startedAt: now, completedAt: now,
    });
    await repositories.management.handoffs.create({
      schemaVersion: 1, id: 'handoff-internal', managementRunId: 'management-run-1',
      invocationId: 'invocation-internal',
      intent: {
        schemaVersion: 1, managementRunId: 'management-run-1', toAgentId: 'agent-1',
        kind: 'consult', objective: '内部咨询', reason: '私有子调用', contextRefs: [],
        dependencyResults: [], acceptanceCriteria: [], attachmentIds: [],
        returnMode: 'return_to_manager',
      },
      intentHash: 'sha256:internal-handoff', idempotencyKey: 'internal-handoff',
      status: 'returned', createdAt: now, updatedAt: now,
    });
  };

  test('空库：没有候选就直接完成，报告全零且不建任何 Bundle', async () => {
    const emptyGlobalDb = new Database(':memory:');
    const emptyTeamDb = new Database(':memory:');
    applyGlobalMigrations(emptyGlobalDb);
    applyTeamMigrations(emptyTeamDb);
    const emptyRepositories = createSqliteRepositories({
      globalDb: emptyGlobalDb, teamDb: emptyTeamDb,
    });

    const result = await createBackfill({ repositories: emptyRepositories }).runBatch();

    expect(result).toMatchObject({ processed: 0, completed: true });
    expect(result.report).toMatchObject({
      mode: 'apply', completed: true, candidates: 0, backfillable: 0,
      created: 0, existing: 0, ambiguous: 0, skipped: 0, failed: 0, reasons: {},
    });
    emptyGlobalDb.close();
    emptyTeamDb.close();
  });

  test('旧库：没有 derivationSource 的历史文档不构成候选', async () => {
    // 纯上传件（无 workspace_run_id）derive 出的文档来源不指向任何 Run。
    await repositories.artifacts.create({
      id: 'artifact-upload', teamId: 'team-1', channelId: 'channel-1',
      messageId: 'message-upload', uploaderId: 'owner-1',
      filename: 'legacy.md', mimeType: 'text/markdown', sizeBytes: 8,
      relativePath: 'legacy.md', role: 'attachment', createdAt: now,
    });
    await repositories.messages.append({
      id: 'message-upload', teamId: 'team-1', channelId: 'channel-1',
      senderKind: 'human', senderId: 'owner-1', body: '上传', createdAt: now,
    });

    const result = await createBackfill().runBatch();

    expect(result.report.candidates).toBe(0);
    expect(await listBundles()).toHaveLength(0);
  });

  test('同一次公开 Run 的多份 Markdown 成组，成员按创建时间冻结', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const spec = await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({
      mode: 'apply', completed: true, backfillable: 1, created: 1, ambiguous: 0,
    });
    const bundles = await listBundles();
    expect(bundles).toHaveLength(1);
    expect(bundles[0]).toMatchObject({
      memberCount: 2,
      source: { kind: 'workspace_run', workspaceRunId: 'run-1', agentId: 'agent-1' },
      createdBy: 'owner-1',
    });

    const detail = await app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1', bundleId: bundles[0]!.id,
    });
    if (!detail.ok) throw new Error('bundle read failed');
    expect(detail.bundle.members.map((member) => member.documentId))
      .toEqual([plan.documentId, spec.documentId]);
    expect(detail.bundle.members.map((member) => member.initialRevisionId))
      .toEqual([plan.revisionId, spec.revisionId]);
  });

  test('单份输出的 Run 不成包，且给出 single_document 原因码', async () => {
    await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({ candidates: 1, backfillable: 0, skipped: 1 });
    expect(result.report.reasons).toMatchObject({ single_document: 1 });
    expect(await listBundles()).toHaveLength(0);
  });

  test('成员漂移的 Run 判为歧义并保持未分组', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    // 人工编辑让 plan 的当前 revision 不再是 run-1 的产物。
    const saved = await app.saveChannelDocument({
      userId: 'member-1', teamId: 'team-1', channelId: 'channel-1',
      documentId: plan.documentId, baseRevisionId: plan.revisionId,
      content: '# 人工修订\n',
    });
    if (!saved.ok) throw new Error('save failed');

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({ candidates: 1, backfillable: 0, ambiguous: 1, skipped: 0 });
    expect(result.report.reasons).toMatchObject({ member_drifted: 1 });
    expect(await listBundles()).toHaveLength(0);
  });

  test('归档频道的候选保持未分组', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({ backfillable: 0, skipped: 1 });
    expect(result.report.reasons).toMatchObject({ channel_archived: 1 });
    expect(await listBundles()).toHaveLength(0);
  });

  test('内部 Invocation 的输出保持未分组', async () => {
    await deriveDocument({ artifactId: 'artifact-internal-a', filename: 'internal-a.md' });
    await deriveDocument({ artifactId: 'artifact-internal-b', filename: 'internal-b.md' });
    await makeRunInternal();

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({ backfillable: 0, skipped: 1 });
    expect(result.report.reasons).toMatchObject({ run_not_public: 1 });
    expect(await listBundles()).toHaveLength(0);
  });

  test('dry-run 只裁决不写库，且结论与 apply 一致', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });

    const dryRun = await createBackfill({ mode: 'dry_run' }).runBatch();

    expect(dryRun.report).toMatchObject({
      mode: 'dry_run', completed: true, candidates: 2, backfillable: 1, created: 0, skipped: 1,
    });
    expect(await listBundles()).toHaveLength(0);

    const applied = await createBackfill({ backfillId: 'apply-pass' }).runBatch();
    expect(applied.report).toMatchObject({ candidates: 2, backfillable: 1, created: 1, skipped: 1 });
    expect(applied.report.reasons).toEqual(dryRun.report.reasons);
  });

  test('重复运行幂等：既有 Bundle 只被计为 existing，不再新建', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });

    const first = await createBackfill().runBatch();
    expect(first.report.created).toBe(1);

    const second = await createBackfill({ backfillId: 'second-pass' }).runBatch();

    expect(second.report).toMatchObject({ candidates: 1, created: 0, existing: 1, backfillable: 0 });
    expect(await listBundles()).toHaveLength(1);
  });

  test('不改变人工创建的 Bundle', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    const manual = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'manual-key', name: '人工整理',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!manual.ok) throw new Error('manual bundle failed');

    const result = await createBackfill().runBatch();

    expect(result.report).toMatchObject({ created: 0, existing: 1 });
    const reread = await app.getProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1', bundleId: manual.bundle.id,
    });
    if (!reread.ok) throw new Error('bundle read failed');
    expect(reread.bundle.name).toBe('人工整理');
    expect(reread.bundle.memberCount).toBe(1);
    expect(reread.bundle.members.map((member) => member.documentId)).toEqual([plan.documentId]);
    expect(await listBundles()).toHaveLength(1);
  });

  test('分批执行可暂停与恢复：游标续跑而不重复建包', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });
    const backfill = createBackfill({ batchSize: 1 });

    const firstBatch = await backfill.runBatch();
    expect(firstBatch).toMatchObject({ processed: 1, completed: false });
    expect(firstBatch.report).toMatchObject({ candidates: 1, created: 1 });

    const secondBatch = await backfill.runBatch();
    expect(secondBatch).toMatchObject({ processed: 1, completed: true });
    expect(secondBatch.report).toMatchObject({ candidates: 2, created: 1, skipped: 1 });

    // 已完成后再跑是空转，不会重复裁决也不会重复建包。
    const thirdBatch = await backfill.runBatch();
    expect(thirdBatch).toMatchObject({ processed: 0, completed: true });
    expect(await listBundles()).toHaveLength(1);
  });

  test('部分失败：游标停在出错的候选，修复后下一批继续', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });

    let failRun2 = true;
    const flakyRepositories: ServerNextRepositories = {
      ...repositories,
      projectDocumentBundleBackfill: {
        ...repositories.projectDocumentBundleBackfill,
        async listRunDocumentFacts(input) {
          if (failRun2 && input.workspaceRunId === 'run-2') throw new Error('injected failure');
          return repositories.projectDocumentBundleBackfill.listRunDocumentFacts(input);
        },
      },
    };
    const backfill = createBackfill({ repositories: flakyRepositories });

    const failing = await backfill.runBatch();
    expect(failing).toMatchObject({ processed: 1, completed: false });
    expect(failing.report).toMatchObject({ created: 1, failed: 1 });
    expect(failing.report.reasons).toMatchObject({ unexpected_error: 1 });

    failRun2 = false;
    const recovered = await backfill.runBatch();

    expect(recovered).toMatchObject({ processed: 1, completed: true });
    // 出错的候选被重新裁决并覆盖掉 failed，run-1 不会被二次建包。
    expect(recovered.report).toMatchObject({ candidates: 2, created: 1, skipped: 1, failed: 0 });
    expect(await listBundles()).toHaveLength(1);
  });

  test('报告只含计数与原因码，不泄露正文、文件名或路径', async () => {
    await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    await deriveDocument({ artifactId: 'artifact-spec', filename: 'spec.md' });
    await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });

    const serialized = JSON.stringify((await createBackfill().runBatch()).report);

    for (const leaked of ['plan.md', 'spec.md', 'solo.md', 'docs/', '# ']) {
      expect(serialized).not.toContain(leaked);
    }
  });

  test('建包失败带结构化原因码，回填据此归因而不解析 message', async () => {
    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const solo = await deriveDocument({ artifactId: 'artifact-solo', filename: 'solo.md' });

    // 成员来自另一次 Run：逐成员原因码必须原样回传。
    const mismatched = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'key-mismatch', name: '混包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId, solo.documentId],
    });
    expect(mismatched).toMatchObject({
      ok: false,
      error: 'VALIDATION_ERROR',
      details: {
        reason: 'members_ineligible',
        rejections: [{ documentId: solo.documentId, code: 'source_mismatch' }],
      },
    });

    await repositories.channels.archive({ channelId: 'channel-1', timestamp: ++now });
    const archived = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'key-archived', name: '归档后建包',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    expect(archived).toMatchObject({
      ok: false, error: 'CONFLICT', details: { reason: 'channel_archived' },
    });
  });

  test('回填默认关闭；关闭时既有 Bundle 与频道文件读路径不受影响', async () => {
    expect(DEFAULT_PROJECT_DOCUMENT_ROLLOUT).toEqual({
      bundleBackfill: false, bundleBackfillDryRun: true,
    });
    expect(parseProjectDocumentRolloutConfig({})).toEqual(DEFAULT_PROJECT_DOCUMENT_ROLLOUT);
    // 打开开关本身仍是 dry-run，必须再显式关掉 dry-run 才会写库。
    expect(parseProjectDocumentRolloutConfig({
      AGENTBEAN_PROJECT_DOCUMENT_BUNDLE_BACKFILL: 'on',
    })).toEqual({ bundleBackfill: true, bundleBackfillDryRun: true });

    const plan = await deriveDocument({ artifactId: 'artifact-plan', filename: 'plan.md' });
    const manual = await app.createProjectDocumentBundle({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
      idempotencyKey: 'manual-key', name: '人工整理',
      workspaceRunId: 'run-1', documentIds: [plan.documentId],
    });
    if (!manual.ok) throw new Error('manual bundle failed');

    // 从不构造回填实例，读路径照常工作。
    expect(await listBundles()).toHaveLength(1);
    const files = await app.listChannelFiles({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    expect(files.ok).toBe(true);
    const documents = await app.listChannelDocuments({
      userId: 'owner-1', teamId: 'team-1', channelId: 'channel-1',
    });
    if (!documents.ok) throw new Error('document list failed');
    expect(documents.documents.map((document) => document.id)).toContain(plan.documentId);
  });
});
