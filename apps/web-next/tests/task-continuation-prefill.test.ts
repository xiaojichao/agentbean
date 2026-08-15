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
  });

  test('显式 command 使用固定幂等键；普通 message:send 不携带 promotion command', () => {
    expect(socketSource).toContain("commandName: 'create-task-continuation'");
    expect(socketSource).toContain('WEB_EVENTS.promotion.command');
    expect(chatSource).toContain('`task-continuation:${clientMessageId}`');
  });
});
