import { describe, expect, test } from 'vitest';
import { mergedStandalonePackageCardIds, shouldHideSystemMessage } from '../lib/system-messages';
import type { ChatMessage } from '../lib/schema';

function message(overrides: Partial<ChatMessage>): ChatMessage {
  return {
    id: 'msg-1',
    channelId: 'channel-1',
    senderKind: 'system',
    senderId: null,
    body: '',
    createdAt: 1,
    ...overrides,
  };
}

describe('shouldHideSystemMessage — 既有去重规则', () => {
  test('hides task-created noise because the task message/card already represents it', () => {
    expect(shouldHideSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'task-created' }),
    }))).toBe(true);
    expect(shouldHideSystemMessage(message({
      meta: { kind: 'task-created' },
      metaJson: null,
    }))).toBe(true);
  });

  test('keeps task-status-updated events visible in the channel flow', () => {
    expect(shouldHideSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'task-status-updated', status: 'done', taskNumber: 3 }),
    }))).toBe(false);
  });

  test('hides artifact-version-revision (file state belongs to Files/Task, not chat)', () => {
    expect(shouldHideSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'artifact-version-revision', versionId: 'v-1' }),
    }))).toBe(true);
    expect(shouldHideSystemMessage(message({
      meta: { kind: 'artifact-version-revision', versionId: 'v-1' },
      metaJson: null,
    }))).toBe(true);
  });

  test('keeps non-task and malformed system messages visible', () => {
    expect(shouldHideSystemMessage(message({
      metaJson: JSON.stringify({ kind: 'message-edit-fail' }),
    }))).toBe(false);
    expect(shouldHideSystemMessage(message({ metaJson: 'null' }))).toBe(false);
    expect(shouldHideSystemMessage(message({ metaJson: '{' }))).toBe(false);
    expect(shouldHideSystemMessage(message({ senderKind: 'human', senderId: 'user-1' }))).toBe(false);
  });
});

// ADR-0066：PI Manager 是内部编排运行时，不以成员/头像/聊天气泡/typing 出现。
// 其输出不得泄漏进用户可见 Thread，也不得计入回复数；但 management-question/delivery
// 是需用户回应/验收的内容，保留可见。
describe('PI Manager 系统消息可见性（ADR-0066）', () => {
  test('隐藏 PI 协调「PI 建议」系统消息（meta.coordination，无 meta.kind）', () => {
    expect(shouldHideSystemMessage(message({
      id: 'pi-1',
      senderId: 'pi-coordinator',
      threadId: 'root-1',
      body: 'PI 建议（自动协调未开启，需确认后执行）：做某事',
      meta: { coordination: { jobId: 'job-1', action: 'suggest', riskLevel: 'low' } },
      metaJson: null,
    }))).toBe(true);

    // 经 metaJson 落库的形态同样必须隐藏。
    expect(shouldHideSystemMessage(message({
      id: 'pi-2',
      senderId: 'pi-coordinator',
      threadId: 'root-1',
      body: '已创建跟踪任务：做某事',
      metaJson: JSON.stringify({ coordination: { jobId: 'job-2', action: 'tracked_task' } }),
    }))).toBe(true);
  });

  test('隐藏 PI 运行时状态更新 management-status（瞬态编排噪音）', () => {
    expect(shouldHideSystemMessage(message({
      id: 'ms-1',
      senderId: 'system',
      threadId: 'root-1',
      body: 'running',
      meta: { kind: 'management-status', managementRunId: 'run-1', managementCommandId: 'cmd-1' },
      metaJson: null,
    }))).toBe(true);
  });

  test('保留 management-question 可见（PI 向用户提问，需回应）', () => {
    expect(shouldHideSystemMessage(message({
      id: 'mq-1',
      senderId: 'system',
      threadId: 'root-1',
      body: '请确认目标 Agent',
      meta: { kind: 'management-question', managementRunId: 'run-1', managementCommandId: 'cmd-1' },
      metaJson: null,
    }))).toBe(false);
  });

  test('保留 management-delivery 可见（PI 提交的交付物，需验收）', () => {
    expect(shouldHideSystemMessage(message({
      id: 'md-1',
      senderId: 'system',
      threadId: 'root-1',
      body: '交付正文…',
      meta: {
        kind: 'management-delivery',
        managementRunId: 'run-1',
        managementCommandId: 'cmd-1',
        taskId: 'task-1',
        contributingInvocationIds: ['inv-1'],
      },
      metaJson: null,
    }))).toBe(false);
  });

  test('被隐藏的 PI 系统消息不计入 Thread 回复数（从 visibleMessages 派生）', () => {
    const root = message({
      id: 'root-1', senderKind: 'human', senderId: 'user-1',
      threadId: 'root-1', body: '原始问题',
    });
    const piSuggest = message({
      id: 'pi-a', senderId: 'pi-coordinator', threadId: 'root-1',
      body: 'PI 建议：方案 A', meta: { coordination: { action: 'suggest' } }, metaJson: null,
    });
    const piStatus = message({
      id: 'ms-a', senderId: 'system', threadId: 'root-1',
      body: 'running', meta: { kind: 'management-status' }, metaJson: null,
    });
    const piQuestion = message({
      id: 'mq-a', senderId: 'system', threadId: 'root-1',
      body: '请确认', meta: { kind: 'management-question' }, metaJson: null,
    });
    const messages = [root, piSuggest, piStatus, piQuestion];

    // 与 chat/page.tsx 一致：visibleMessages 过滤后再派生 threadReplies；
    // system 消息的 parent = 其 threadId（非 agent，不走顶层特判）。
    const visible = messages.filter((m) => !shouldHideSystemMessage(m));
    const replies = visible.filter((m) => m.id !== root.id && m.threadId === root.id);

    // coordination 与 management-status 被隐藏；management-question 保留为可见回复。
    expect(replies.map((m) => m.id)).toEqual(['mq-a']);
  });
});

describe('mergedStandalonePackageCardIds — #1111 内嵌吸收', () => {
  const cardMeta = {
    kind: 'output-package',
    packageId: 'pkg-1',
    memberCount: 1,
    members: [{ shortLabel: 'F1', filename: 'a.md', artifactVersionId: 'v1', collectionId: 'c1' }],
    workspaceRevisionId: 'rev-1',
    publishId: 'pub-1',
  };

  test('回复内嵌同 packageId 时,独立卡片隐藏(无论先后顺序)', () => {
    const card = message({ id: 'card-1', meta: cardMeta });
    const reply = message({
      id: 'reply-1',
      senderKind: 'agent',
      meta: { dispatchId: 'd-1', outputPackageCard: cardMeta },
    });
    // 实时窗口:卡片先到(commit),回复后到(result)——两种顺序都隐藏。
    expect(mergedStandalonePackageCardIds([card, reply]).has('card-1')).toBe(true);
    expect(mergedStandalonePackageCardIds([reply, card]).has('card-1')).toBe(true);
    // 回复本身不隐藏。
    expect(mergedStandalonePackageCardIds([card, reply]).has('reply-1')).toBe(false);
  });

  test('无内嵌回复时独立卡片保留(旧 daemon / 结果未达兜底)', () => {
    const card = message({ id: 'card-1', meta: cardMeta });
    expect(mergedStandalonePackageCardIds([card]).size).toBe(0);
  });

  test('metaJson 形态(未解析)同样生效', () => {
    const card = message({ id: 'card-1', metaJson: JSON.stringify(cardMeta), meta: undefined });
    const reply = message({
      id: 'reply-1',
      senderKind: 'agent',
      metaJson: JSON.stringify({ dispatchId: 'd-1', outputPackageCard: cardMeta }),
      meta: undefined,
    });
    expect(mergedStandalonePackageCardIds([card, reply]).has('card-1')).toBe(true);
  });
});
