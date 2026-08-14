import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * #1178：阶段工作区交接入口（交给智能体处理/要求修改后继续）在 chat 页的
 * 预填接线。ChatPage 为单体页面，无法整页渲染，按仓库惯例用源码扫描断言
 * 关键行为（对标 task-delegate-prefill.test.ts）；「预填不创建事实」的
 * Server 侧证明在 server-next 集成测试。
 */
describe('chat 页阶段交接预填接线（#1178，源码扫描）', () => {
  const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

  test('onStageHandoff 预填意图文案 + @ + 引用选择 + 焦点恢复，全程不触达 socket（AC3）', () => {
    const start = chatSource.indexOf('onStageHandoff={(handoff)');
    expect(start).toBeGreaterThan(-1);
    const region = chatSource.slice(start, chatSource.indexOf('\n        />', start));
    // 意图文案保持尾部 @ 触发成员/智能体选择器交互。
    expect(region).toContain('请继续处理任务当前文件包：@');
    expect(region).toContain('请基于已交付版本继续修改：@');
    expect(region).toContain('openThread(');
    expect(region).toContain('setThreadInput(');
    expect(region).toContain('setThreadSelections(');
    expect(region).toContain('threadTextareaRef.current?.focus');
    // 无绑定 Thread（普通阶段任务）回落主 composer，仅预填 @。
    expect(region).toContain("setInput('@')");
    expect(region).toContain('textareaRef.current?.focus');
    // 预填只写本地 state：不得出现任何发送/emit。
    expect(region).not.toContain('getWebSocket().emit');
    expect(region).not.toContain('message.send');
    expect(region).not.toContain('message:send');
  });

  test('TaskDetailPanel 把 onStageHandoff 透传给阶段工作区', () => {
    expect(chatSource).toContain('onStageHandoff={onStageHandoff}');
  });

  test('#1198 文件审核退回前从 Server 拉回原 Thread，成功后只写本地草稿与稳定选择', () => {
    const prepareStart = chatSource.indexOf('prepareReturnThread={async (threadRootMessageId)');
    expect(prepareStart).toBeGreaterThan(-1);
    const prepareRegion = chatSource.slice(prepareStart, chatSource.indexOf('onReturnToThread={(handoff)', prepareStart));
    expect(prepareRegion).toContain('messageReactionEvents().context(threadRootMessageId)');
    expect(prepareRegion).toContain('upsertMessages(context.messages.map(markContextLoadedMessage))');
    expect(prepareRegion).toContain('(context.threadRootId ?? context.targetMessageId) === threadRootMessageId');

    const start = chatSource.indexOf('onReturnToThread={(handoff)');
    expect(start).toBeGreaterThan(-1);
    const region = chatSource.slice(start, chatSource.indexOf('\n        />', start));
    expect(region).toContain('buildPackageReturnComposerDraft');
    expect(region).toContain('openThread(handoff.threadRootMessageId)');
    expect(region).toContain('setThreadInput(draft.text)');
    expect(region).toContain('setThreadSelections([draft.selection])');
    expect(region).toContain('threadTextareaRef.current?.focus');
    expect(region).not.toContain('sendMessage(');
    expect(region).not.toContain('message:send');
  });

  test('打开 thread 保留 task-only 阶段详情深链，stage/chatTab/tasksView 参数不动（AC1）', () => {
    const start = chatSource.indexOf('const setThreadUrl');
    expect(start).toBeGreaterThan(-1);
    const region = chatSource.slice(start, chatSource.indexOf('}, [activeChannel, router, searchParams]);', start));
    expect(region).toContain("params.set('thread'");
    // task=task:<taskId> 深链与 thread 共存；消息型 task 深链仍互斥清除。
    expect(region).toContain("startsWith('task:')");
    expect(region).not.toContain("params.delete('stage')");
    expect(region).not.toContain("params.delete('chatTab')");
    expect(region).not.toContain("params.delete('tasksView')");
  });

  test('thread composer 引用非空时渲染「发送时冻结」提示行（AC2）', () => {
    const hintStart = chatSource.indexOf('data-smoke="thread-reference-freeze-hint"');
    expect(hintStart).toBeGreaterThan(-1);
    const hintRegion = chatSource.slice(hintStart - 200, hintStart + 300);
    expect(hintRegion).toContain('selections.length > 0');
    expect(hintRegion).toContain('发送时将按策略冻结为具体版本，冻结后不随后续更新漂移');
  });

  test('非阶段路径的 delegate-to-agent 原行为保留（TaskDeliveryOverview 直通）', () => {
    expect(chatSource).toContain("action === 'delegate-to-agent'");
    expect(chatSource).toContain("setThreadInput('@')");
  });
});
