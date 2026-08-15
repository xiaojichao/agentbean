import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const tasksSource = readFileSync(new URL('../app/[teamPath]/tasks/page.tsx', import.meta.url), 'utf8');
const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const socketSource = readFileSync(new URL('../lib/socket.ts', import.meta.url), 'utf8');

describe('#1200 终态 Task 后续任务前端链路', () => {
  test('Task 页只导航并预填 Server basis，不在用户发送前创建任务', () => {
    expect(tasksSource).toContain("action.action === 'create-continuation'");
    expect(tasksSource).toContain('continuationBasis: basis');
    expect(tasksSource).toContain('router.push(');
    expect(tasksSource).not.toContain("commandName: 'create-task-continuation'");
  });

  test('Chat 先发送 thread human message，再用该消息 ID 显式创建后续任务', () => {
    const sendIndex = chatSource.indexOf('getWebSocket().emit(WEB_EVENTS.message.send');
    const sourceMessageIndex = chatSource.indexOf('const sourceMessageId = res.message');
    const continuationIndex = chatSource.indexOf('await createContinuation(sourceMessageId, body)');
    expect(sendIndex).toBeGreaterThan(-1);
    expect(sourceMessageIndex).toBeGreaterThan(sendIndex);
    expect(continuationIndex).toBeGreaterThan(sourceMessageIndex);
    expect(chatSource).toContain('setPendingThreadContinuation({ sourceMessageId, clientMessageId, objective })');
    expect(chatSource).toContain('if (pendingThreadContinuation && threadContinuationBasis)');
    expect(chatSource).toContain('taskContinuationSource: {');
    expect(chatSource).toContain('sourceTaskRevision: threadContinuationBasis.sourceTaskRevision');
  });

  test('两阶段提交使用同步锁，消息与 continuation 完成前不可重复触发', () => {
    expect(chatSource).toContain('if (threadContinuationSubmittingRef.current) return');
    expect(chatSource).toContain('threadContinuationSubmittingRef.current = true');
    expect(chatSource).toContain('finally(releaseContinuationLock)');
    expect(chatSource).toContain('submitting={threadContinuationSubmitting}');
    expect(chatSource).toContain('disabled={submitting || uploading');
  });

  test('仅不确定响应复用原 key，业务拒绝重读 Server basis 后使用新 key', () => {
    expect(chatSource).toContain('const retrySameKey = transportUncertain');
    expect(chatSource).toContain("continuation.response?.retryDirective === 'same_key'");
    expect(chatSource).toContain('queryTaskDeliveryOverview({');
    expect(chatSource).toContain("createClientMessageId('task-continuation-retry')");
    expect(chatSource).toContain("'请返回 Task 重新发起'");
  });

  test('显式 command 使用固定幂等键；普通 message:send 不携带 promotion command', () => {
    expect(socketSource).toContain("commandName: 'create-task-continuation'");
    expect(socketSource).toContain('WEB_EVENTS.promotion.command');
    expect(chatSource).toContain('`task-continuation:${clientMessageId}`');
  });
});
