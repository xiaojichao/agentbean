import { describe, expect, test } from 'vitest';
import { createInMemoryRepositories, createServerNextUseCases } from '../src/index';

function createIds(ids: string[]) {
  let index = 0;
  return () => {
    const id = ids[index];
    index += 1;
    if (!id) throw new Error('Test id sequence exhausted');
    return id;
  };
}

// ADR-0066：PI Manager 是内部编排运行时，不以聊天气泡/成员出现。
// 服务端在序列化边界（enrichMessagesWithArtifacts）过滤 PI 系统消息，使前端不再收到它们。
// management-question / management-delivery 保留可见（前者需回应，后者需验收）。
describe('PI 系统消息服务端过滤（ADR-0066）', () => {
  test('listChannelMessages 过滤 coordination / management-status，保留 question 与人类消息', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1', 'message-1', 'x-1', 'x-2', 'x-3', 'x-4']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await app.sendMessage({ userId: 'user-1', teamId: 'team-1', channelId: 'channel-1', body: '人类消息' });

    // PI 协调输出（channel-coordination-coordinator 写入形态：senderId='pi-coordinator', meta.coordination）
    await repositories.messages.append({
      id: 'pi-coord-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'message-1',
      senderKind: 'system', senderId: 'pi-coordinator', body: 'PI 建议：xxx',
      createdAt: 100, meta: { coordination: { action: 'suggest' } },
    });
    // PI 运行时状态（management-tool-executor 写入形态：meta.kind='management-status'）
    await repositories.messages.append({
      id: 'pi-status-1', teamId: 'team-1', channelId: 'channel-1',
      senderKind: 'system', senderId: 'system', body: 'running',
      createdAt: 100, meta: { kind: 'management-status', managementRunId: 'run-1', managementCommandId: 'cmd-1' },
    });
    // management-question 必须保留可见（PI 向用户提问，需回应）
    await repositories.messages.append({
      id: 'pi-question-1', teamId: 'team-1', channelId: 'channel-1',
      senderKind: 'system', senderId: 'system', body: '请确认目标',
      createdAt: 100, meta: { kind: 'management-question', managementRunId: 'run-1', managementCommandId: 'cmd-2' },
    });

    const ack = await app.listChannelMessages({ channelId: 'channel-1', limit: 50 });
    expect(ack.ok).toBe(true);
    if (!ack.ok) throw new Error('expected listChannelMessages to succeed');
    const ids = ack.messages.map((m) => m.id);

    // PI 协调与状态被服务端过滤，不发给前端
    expect(ids).not.toContain('pi-coord-1');
    expect(ids).not.toContain('pi-status-1');
    // management-question 保留可见
    expect(ids).toContain('pi-question-1');
    // 人类消息保留
    const humanMessages = ack.messages.filter((m) => m.senderKind === 'human');
    expect(humanMessages.length).toBe(1);
    expect(humanMessages[0].body).toBe('人类消息');
    // 不应有任何 coordination / management-status 系统消息泄漏
    expect(ack.messages.filter((m) => m.meta?.kind === 'management-status').length).toBe(0);
    expect(ack.messages.filter((m) => m.meta?.coordination !== undefined).length).toBe(0);
  });

  test('在 LIMIT 前过滤隐藏消息，避免历史窗口被噪音占满', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.messages.append({
      id: 'visible-1', teamId: 'team-1', channelId: 'channel-1', threadId: 'visible-1',
      senderKind: 'human', senderId: 'user-1', body: '较早可见 1', createdAt: 100,
    });
    await repositories.messages.append({
      id: 'visible-2', teamId: 'team-1', channelId: 'channel-1', threadId: 'visible-2',
      senderKind: 'human', senderId: 'user-1', body: '较早可见 2', createdAt: 200,
    });
    for (let index = 1; index <= 3; index += 1) {
      await repositories.messages.append({
        id: `hidden-${index}`, teamId: 'team-1', channelId: 'channel-1', threadId: `hidden-${index}`,
        senderKind: 'system', senderId: 'system', body: `保存了新版本 ${index}`, createdAt: 200 + index,
        meta: { kind: 'artifact-version-revision' },
      });
    }

    const ack = await app.listChannelMessages({ channelId: 'channel-1', limit: 2 });
    expect(ack).toMatchObject({ ok: true, messages: [{ id: 'visible-1' }, { id: 'visible-2' }] });
  });

  test('隐藏历史 root 时把既有回复提升为可达消息，并移除失效 thread 上下文', async () => {
    const repositories = createInMemoryRepositories();
    const app = createServerNextUseCases({
      repositories,
      clock: { now: () => 100 },
      ids: { nextId: createIds(['user-1', 'team-1', 'channel-1']) },
    });
    await app.registerUser({ username: 'shaw', password: 'secret', teamName: 'AgentBean' });
    await repositories.messages.append({
      id: 'revision-root', teamId: 'team-1', channelId: 'channel-1', threadId: 'revision-root',
      senderKind: 'system', senderId: 'system', body: '保存了新版本', createdAt: 100,
      meta: { kind: 'artifact-version-revision' },
    });
    await repositories.messages.append({
      id: 'human-reply', teamId: 'team-1', channelId: 'channel-1', threadId: 'revision-root',
      senderKind: 'human', senderId: 'user-1', body: '这条历史回复仍应可见', createdAt: 200,
      meta: { parentMessageId: 'revision-root' },
    });

    const history = await app.listChannelMessages({ channelId: 'channel-1', limit: 10 });
    expect(history).toMatchObject({ ok: true, messages: [{ id: 'human-reply', body: '这条历史回复仍应可见' }] });
    if (!history.ok) throw new Error('expected listChannelMessages to succeed');
    expect(history.messages[0]).not.toHaveProperty('threadId');
    expect(history.messages[0]?.meta).not.toHaveProperty('parentMessageId');

    const context = await app.getMessageContext({
      userId: 'user-1', teamId: 'team-1', messageId: 'human-reply',
    });
    expect(context).toMatchObject({ ok: true, targetMessageId: 'human-reply', messages: [{ id: 'human-reply' }] });
    expect(context).not.toHaveProperty('threadRootId');
    await expect(app.getMessageContext({
      userId: 'user-1', teamId: 'team-1', messageId: 'revision-root',
    })).resolves.toMatchObject({ ok: false, error: 'NOT_FOUND' });
  });
});
