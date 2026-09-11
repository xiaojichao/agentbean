import { createRequire } from 'node:module';
import { describe, expect, test } from 'vitest';
import { describeDirectTaskExecution, markDirectTaskInReview } from '../src/application/direct-task-execution.js';
import { createOrReuseMessageTask } from '../src/application/message-task-link.js';
import { resolveDirectDispatchTask } from '../src/application/direct-dispatch-task.js';
import { createInMemoryRepositories } from '../src/infra/memory/repositories.js';
import { applyGlobalMigrations, applyTeamMigrations, createSqliteRepositories, type SqliteDatabase } from '../src/infra/sqlite/repositories.js';
import type { TaskStatus } from '../../../packages/contracts/src/task.js';

const Database = createRequire(import.meta.url)('better-sqlite3') as new (path: string) => SqliteDatabase & { close(): void };
const { readTaskStateReport, classifyTask } = createRequire(import.meta.url)('../../../scripts/report-task-state.cjs');

async function fixture(sqlite: boolean) {
  const globalDb = sqlite ? new Database(':memory:') : undefined;
  const teamDb = sqlite ? new Database(':memory:') : undefined;
  if (globalDb && teamDb) { applyGlobalMigrations(globalDb); applyTeamMigrations(teamDb); }
  const repositories = globalDb && teamDb ? createSqliteRepositories({ globalDb, teamDb }) : createInMemoryRepositories();
  await repositories.channels.create({ id: 'channel', teamId: 'team', name: 'project', kind: 'channel',
    visibility: 'public', humanMemberIds: ['user'], agentMemberIds: ['agent'], createdAt: 1 });
  const task = await repositories.tasks.create({ id: 'task', teamId: 'team', channelId: 'channel',
    title: '交付结果', creatorId: 'user', assigneeId: 'agent', status: 'in_progress', tags: [], sortOrder: 1, createdAt: 1, updatedAt: 1 });
  const origin = await repositories.messages.append({ id: 'origin', teamId: 'team', channelId: 'channel',
    senderKind: 'human', senderId: 'user', body: '交付结果', createdAt: 1, meta: { taskId: task.id } });
  const dispatch = await repositories.dispatches.create({ id: 'dispatch', teamId: 'team', channelId: 'channel',
    messageId: origin.id, agentId: 'agent', status: 'succeeded', prompt: '交付结果', requestId: 'request', createdAt: 2, updatedAt: 3 });
  const reply = await repositories.messages.append({ id: 'reply', teamId: 'team', channelId: 'channel',
    senderKind: 'agent', senderId: 'agent', body: '文字答复', createdAt: 3,
    meta: { dispatchId: dispatch.id, dispatchResultFingerprint: 'fingerprint' } });
  return { repositories, task, origin, dispatch, reply, globalDb, teamDb, close: () => { teamDb?.close(); globalDb?.close(); } };
}

test('只读诊断按 Team 隔离，缺失 Team 不返回数据，SQLite query_only 下也能生成清单', async () => {
  const h = await fixture(true);
  try {
    await h.repositories.users.create({ id: 'user', username: 'user', passwordHash: 'never-export-this', role: 'user',
      primaryTeamId: 'team', createdAt: 1, updatedAt: 1 });
    await h.repositories.teams.create({ id: 'team', ownerId: 'user', name: 'Team', path: 'testsns', visibility: 'private', createdAt: 1 });
    await h.repositories.tasks.create({ ...h.task, id: 'foreign-task', teamId: 'other', title: 'private-other-team' });
    await h.repositories.tasks.create({ ...h.task, id: 'orphan', status: 'todo', assigneeId: undefined });
    h.globalDb!.exec('PRAGMA query_only = ON');
    h.teamDb!.exec('PRAGMA query_only = ON');
    const report = readTaskStateReport({ globalDb: h.globalDb, teamDb: h.teamDb, teamPath: 'testsns', now: 5 });
    expect(report.readOnly).toBe(true);
    expect(report.tasks).toHaveLength(2);
    expect(report.tasks.find((row: { id: string }) => row.id === 'orphan').classification).toBe('no_execution_lineage');
    expect(report.tasks.find((row: { id: string }) => row.id === 'task').classification).toBe('progress_without_active_execution');
    expect(JSON.stringify(report)).not.toContain('never-export-this');
    expect(JSON.stringify(report)).not.toContain('private-other-team');
    expect(() => readTaskStateReport({ globalDb: h.globalDb, teamDb: h.teamDb, teamPath: 'missing' })).toThrow('TEAM_NOT_FOUND');
    expect(await h.repositories.tasks.getById('task')).toMatchObject({ status: 'in_progress', updatedAt: 1 });
  } finally { h.close(); }
});

describe.each([false, true])('direct Task evidence (sqlite=%s)', (sqlite) => {
  test('线程补交继承唯一原任务并冻结到当前消息，后来的其他任务不改变关联', async () => {
    const h = await fixture(sqlite);
    try {
      const followup = await h.repositories.messages.append({ ...h.origin, id: 'followup', threadId: 'origin',
        body: '补交原文件', createdAt: 10, meta: {} });
      const dispatch = { ...h.dispatch, messageId: followup.id };
      expect(await resolveDirectDispatchTask(h.repositories, dispatch, followup)).toMatchObject({ id: 'task' });
      const frozen = await h.repositories.messages.getById(followup.id);
      expect(frozen?.meta?.taskId).toBe('task');
      await h.repositories.messages.append({ ...h.origin, id: 'later-task', threadId: 'origin', createdAt: 11, meta: { taskId: 'other' } });
      expect(await resolveDirectDispatchTask(h.repositories, dispatch, frozen)).toMatchObject({ id: 'task' });
    } finally { h.close(); }
  });

  test('多任务线程不能把补交绑到最近的另一个任务', async () => {
    const h = await fixture(sqlite);
    try {
      await h.repositories.tasks.create({ ...h.task, id: 'other', title: '配置切换' });
      await h.repositories.messages.append({ ...h.origin, id: 'other-origin', threadId: 'origin', createdAt: 5, meta: { taskId: 'other' } });
      const followup = await h.repositories.messages.append({ ...h.origin, id: 'followup', threadId: 'origin', createdAt: 10, meta: {} });
      expect(await resolveDirectDispatchTask(h.repositories, { ...h.dispatch, messageId: followup.id }, followup)).toBeNull();
      expect((await h.repositories.messages.getById(followup.id))?.meta?.taskId).toBeUndefined();
    } finally { h.close(); }
  });

  test.each(['done', 'closed', 'cancelled'] as TaskStatus[])('线程补交不得继承终态任务 %s', async (status) => {
    const h = await fixture(sqlite);
    try {
      await h.repositories.tasks.update({ taskId: h.task.id, changes: { status } });
      const followup = await h.repositories.messages.append({ ...h.origin, id: 'followup', threadId: 'origin', createdAt: 10, meta: {} });
      expect(await resolveDirectDispatchTask(h.repositories, { ...h.dispatch, messageId: followup.id }, followup)).toBeNull();
    } finally { h.close(); }
  });

  test.each(['team', 'channel', 'agent'])('线程继承不跨越 %s 边界', async (boundary) => {
    const h = await fixture(sqlite);
    try {
      const followup = await h.repositories.messages.append({ ...h.origin, id: 'followup', threadId: 'origin', createdAt: 10, meta: {} });
      const dispatch = { ...h.dispatch, messageId: followup.id,
        ...(boundary === 'team' ? { teamId: 'other' } : {}),
        ...(boundary === 'channel' ? { channelId: 'other' } : {}),
        ...(boundary === 'agent' ? { agentId: 'other' } : {}) };
      expect(await resolveDirectDispatchTask(h.repositories, dispatch, followup)).toBeNull();
    } finally { h.close(); }
  });

  test('已发送但尚未接受的派发仍属于活动执行', async () => {
    const h = await fixture(sqlite);
    try {
      await h.repositories.dispatches.create({ ...h.dispatch, id: 'sent', requestId: 'sent', status: 'sent', createdAt: 4 });
      expect(await describeDirectTaskExecution(h.repositories, { task: h.task, channelId: 'channel', packageCount: 0, pendingCount: 0 }))
        .toMatchObject({ detail: '已派发，等待 Agent 开始执行' });
      const row = { ...h.task, claims: [], sourceMessageIds: ['origin'], dispatches: [{ status: 'sent' }] };
      expect(classifyTask(row, 5)).toBe('execution_record_active');
      expect(classifyTask({ ...row, status: 'todo' }, 5)).toBe('dispatch_pending');
    } finally { h.close(); }
  });

  test('合法文字回复进入审核，摘要不伪造文件包或自动验收', async () => {
    const h = await fixture(sqlite);
    try {
      expect(await markDirectTaskInReview(h.repositories, h.origin, h.dispatch, 4)).toMatchObject({ status: 'in_review' });
      const task = (await h.repositories.tasks.getById('task'))!;
      expect(await describeDirectTaskExecution(h.repositories, { task, channelId: 'channel', packageCount: 0, pendingCount: 0 }))
        .toMatchObject({ kind: 'review_wait', detail: expect.stringContaining('暂无交付文件包') });
    } finally { h.close(); }
  });

  test.each(['empty', 'claim', 'missing-package', 'wrong-channel', 'wrong-agent'] as const)('%s 不能充当有效交付', async (kind) => {
    const h = await fixture(sqlite);
    try {
      if (kind === 'empty') await h.repositories.messages.edit({ messageId: h.reply.id, body: '  ', meta: h.reply.meta });
      if (kind === 'claim') await h.repositories.messages.updateMeta({ messageId: h.reply.id, meta: { dispatchId: h.dispatch.id, kind: 'task-claim-confirmed' } });
      if (kind === 'missing-package') await h.repositories.messages.updateMeta({ messageId: h.reply.id, meta: { ...h.reply.meta, outputPackagePublishId: 'missing' } });
      const origin = kind === 'wrong-channel' ? { ...h.origin, channelId: 'other' } : h.origin;
      const dispatch = kind === 'wrong-agent' ? { ...h.dispatch, agentId: 'other' } : h.dispatch;
      expect(await markDirectTaskInReview(h.repositories, origin, dispatch, 4)).toBeNull();
      expect(await h.repositories.tasks.getById('task')).toMatchObject({ status: 'in_progress' });
    } finally { h.close(); }
  });

  test.each(['cancelled', 'closed', 'done'] as TaskStatus[])('迟到成功结果不能复活 %s 任务', async (status) => {
    const h = await fixture(sqlite);
    try {
      await h.repositories.tasks.update({ taskId: 'task', changes: { status, updatedAt: 4 } });
      expect(await markDirectTaskInReview(h.repositories, h.origin, h.dispatch, 5)).toBeNull();
      expect(await h.repositories.tasks.getById('task')).toMatchObject({ status });
    } finally { h.close(); }
  });

  test('旧执行成功不能覆盖新一轮派发，跨 Team/Channel 的同名来源不能混入', async () => {
    const h = await fixture(sqlite);
    try {
      await h.repositories.dispatches.create({ ...h.dispatch, id: 'new', requestId: 'new', status: 'running', createdAt: 10, updatedAt: 10 });
      await h.repositories.dispatches.create({ ...h.dispatch, id: 'foreign', requestId: 'foreign', teamId: 'other', createdAt: 20 });
      expect((await h.repositories.dispatches.listByTaskOrigin({ teamId: 'team', channelId: 'channel', taskId: 'task' })).map((d) => d.id))
        .toEqual(['new', 'dispatch']);
      expect(await markDirectTaskInReview(h.repositories, h.origin, h.dispatch, 11)).toBeNull();
    } finally { h.close(); }
  });

  test('复用原消息的 Task，不留下第二条待办或覆盖原状态', async () => {
    const h = await fixture(sqlite);
    try {
      const linked = await createOrReuseMessageTask(h.repositories, h.origin.id, { ...h.task, id: 'candidate', title: '改写后的目标', status: 'todo' });
      expect(linked.id).toBe(h.task.id);
      expect(await h.repositories.tasks.getById('candidate')).toBeNull();
      expect(await h.repositories.tasks.getById(h.task.id)).toMatchObject({ status: 'in_progress', title: '交付结果' });
    } finally { h.close(); }
  });

  test('不存在/跨作用域的消息关联失败关闭，不创建孤立候选', async () => {
    const h = await fixture(sqlite);
    try {
      await expect(createOrReuseMessageTask(h.repositories, h.origin.id, { ...h.task, id: 'candidate', teamId: 'other' }))
        .rejects.toThrow('MESSAGE_TASK_SCOPE_CONFLICT');
      await h.repositories.messages.updateMeta({ messageId: h.origin.id, meta: { taskId: 'missing' } });
      await expect(createOrReuseMessageTask(h.repositories, h.origin.id, { ...h.task, id: 'candidate' }))
        .rejects.toThrow('MESSAGE_TASK_LINK_CONFLICT');
      expect(await h.repositories.tasks.getById('candidate')).toBeNull();
    } finally { h.close(); }
  });
});
