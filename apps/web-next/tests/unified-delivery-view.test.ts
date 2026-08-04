import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * #1065 AC2/AC3/AC4 贯通视图源码扫描。
 *
 * TasksPage/ChatPage 为单体页面，无法整页渲染，按仓库惯例用源码扫描断言关键接线：
 * - Chat 卡片入口（打开审核 Task / 继续 @Agent）已注入回调；
 * - 「继续 @Agent」只写本地 composer state（未发送不创建任何事实）；
 * - Task 面板已接入交付视图投影（focus/acceptance/timeline/actions 全部来自 Server）。
 */
describe('贯通 Chat/Task/Files 一致交付视图（#1065）', () => {
  const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
  const taskSource = readFileSync(new URL('../app/[teamPath]/tasks/page.tsx', import.meta.url), 'utf8');
  const cardSource = readFileSync(new URL('../components/OutputPackageCard.tsx', import.meta.url), 'utf8');
  const overviewSource = readFileSync(new URL('../components/TaskDeliveryOverview.tsx', import.meta.url), 'utf8');
  const socketSource = readFileSync(new URL('../lib/socket.ts', import.meta.url), 'utf8');

  test('Chat 卡片注入「打开审核 Task」与「继续 @Agent」回调', () => {
    expect(cardSource).toContain('data-smoke="output-package-open-task"');
    expect(cardSource).toContain('data-smoke="output-package-continue-agent"');
    expect(chatSource).toContain('onOpenTask={onOpenTaskDetailById}');
    expect(chatSource).toContain('onContinueWithAgent={continueWithAgentFromCard}');
  });

  test('「继续 @Agent」回调只写本地 composer state（input + selections + 焦点），不触发发送', () => {
    const start = chatSource.indexOf('const continueWithAgentFromCard');
    expect(start).toBeGreaterThan(-1);
    const region = chatSource.slice(start, chatSource.indexOf('}, [setProjectReferenceSelections]);', start));
    // 预填 delivered 整包引用 + 说明文本 + 移焦。
    expect(region).toContain("kind: 'package_projection'");
    expect(region).toContain("policy: 'delivered'");
    expect(region).toContain('setInput(');
    expect(region).toContain('textareaRef.current?.focus()');
    // 预填段不得出现网络发送。
    expect(region).not.toContain('emit(');
    expect(region).not.toContain('sendMessage');
  });

  test('Task 面板接入交付视图（Server 单一投影:focus/acceptance/availableActions/timeline）', () => {
    expect(taskSource).toContain('TaskDeliveryOverview');
    expect(overviewSource).toContain('data-smoke="task-delivery-overview"');
    expect(overviewSource).toContain('data-smoke="task-focus"');
    expect(overviewSource).toContain('data-smoke="task-acceptance-contract"');
    expect(overviewSource).toContain('data-smoke="task-available-actions"');
    expect(overviewSource).toContain('data-smoke="task-timeline"');
  });

  test('web socket 封装暴露 task:delivery-overview 查询', () => {
    expect(socketSource).toContain('queryTaskDeliveryOverview');
    expect(socketSource).toContain('WEB_EVENTS.task.deliveryOverview');
  });

  test('AC13:Markdown conflict 场景有结构化反馈文案(#1062)', () => {
    // 基于此修改保存遇到 stale revision 时展示冲突界面:保留草稿 + 查看最新版提示。
    expect(chatSource).toContain('文档已被其他成员更新');
    expect(chatSource).toContain('请查看最新版后手工合并');
  });
});
