import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

/**
 * #1064 AC1/AC2：Task 页「交给 Agent 处理」只导航到关联 Thread 并预填引用，
 * 未发送前不创建 Message/Offer/claim/Invocation/负责人事实。
 *
 * TasksPage/ChatPage 为单体页面，无法整页渲染，按仓库惯例用源码扫描断言
 * 关键行为；「预填不创建事实」的 Server 侧证明在 server-next 集成测试。
 */
describe('Task 页「交给 Agent 处理」预填导航（#1064）', () => {
  const taskSource = readFileSync(new URL('../app/[teamPath]/tasks/page.tsx', import.meta.url), 'utf8');
  const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

  test('Task 讨论串面板提供「交给 Agent 处理」按钮，无交付包时不可用', () => {
    expect(taskSource).toContain('data-smoke="task-delegate-to-agent"');
    expect(taskSource).toContain('交给 Agent 处理');
    // 按钮引用具体交付包（delegatePackageId），为空即禁用——预填必须指向具体 package。
    expect(taskSource).toContain('!delegatePackageId');
  });

  test('导航只携带 thread + compose 参数（text + package_projection delivered），不含发送动作', () => {
    // compose 载荷：说明文本 + 最近交付包的 delivered 投影选择。
    expect(taskSource).toContain("kind: 'package_projection'");
    expect(taskSource).toContain("policy: 'delivered'");
    expect(taskSource).toContain('compose=');
    expect(taskSource).toContain('?thread=');
    // 预填段不得出现消息发送调用（getWebSocket().emit）。
    const delegateRegion = taskSource.slice(
      taskSource.indexOf('handleDelegateToAgent'),
      taskSource.indexOf('useEffect(() => {', taskSource.indexOf('handleDelegateToAgent')),
    );
    expect(delegateRegion).not.toContain('getWebSocket().emit');
  });

  test('compose 参数解析后只写本地 state（input + selections + 焦点），不触发任何发送', () => {
    const prefillStart = chatSource.indexOf('// #1064 AC1/AC2：Task 页');
    const prefillRegion = chatSource.slice(
      prefillStart,
      chatSource.indexOf('}, [activeChannel, composeParam, threadRootId]);', prefillStart),
    );
    expect(prefillRegion).toContain('JSON.parse(composeParam)');
    expect(prefillRegion).toContain('setThreadInput');
    expect(prefillRegion).toContain('setThreadSelections');
    expect(prefillRegion).toContain('threadTextareaRef.current?.focus');
    expect(prefillRegion).not.toContain('getWebSocket().emit');
    expect(prefillRegion).not.toContain('message.send');
  });

  test('compose 参数消费一次后从 URL 移除（刷新/回退不重复填充）', () => {
    expect(chatSource).toContain("params.delete('compose')");
    expect(chatSource).toContain('history.replaceState') || expect(chatSource).toContain('router.replace');
  });

  test('线程 composer 渲染引用 chips（预填即显示，可逐个移除）', () => {
    const threadPanelStart = chatSource.indexOf('function ThreadPanel');
    const threadPanel = chatSource.slice(threadPanelStart, chatSource.indexOf('function ProfilePanel', threadPanelStart));
    expect(threadPanel).toContain('data-smoke="thread-reference-composer-chips"');
    expect(threadPanel).toContain('onRemoveSelection');
  });

  test('线程消息发送携带 selections，成功后清空；纯引用消息可发送', () => {
    const sendThreadRegion = chatSource.slice(
      chatSource.indexOf('const sendThreadMessage'),
      chatSource.indexOf('const messages = activeChannel'),
    );
    expect(sendThreadRegion).toContain('selections: threadSelections');
    expect(sendThreadRegion).toContain('setThreadSelections([])');
    // 发送前置条件包含 selections（无文本+无附件+有引用也可发送）。
    expect(sendThreadRegion).toContain('threadSelections.length === 0');
  });

  test('线程状态清理点同步清空引用选择（关闭/切换线程不残留预填）', () => {
    const closeThread = chatSource.slice(
      chatSource.indexOf('const closeThread'),
      chatSource.indexOf('const openProfile', chatSource.indexOf('const closeThread')),
    );
    expect(closeThread).toContain('setThreadSelections([])');
  });

  test('发送失败保留草稿与引用，仅成功路径清空（AC11）', () => {
    const sendThread = chatSource.slice(
      chatSource.indexOf('const sendThreadMessage'),
      chatSource.indexOf('const messages = activeChannel'),
    );
    // 清空只发生在 res.ok 分支内。
    const successStart = sendThread.indexOf('if (res?.ok)');
    const failureStart = sendThread.indexOf('id: `local-thread-error-', successStart);
    const okRegion = sendThread.slice(
      successStart,
      failureStart,
    );
    expect(okRegion).toContain('setThreadInput(');
    expect(okRegion).toContain('setThreadSelections([])');
    // emit 回调之外（乐观清空区）不再有清空调用——失败时草稿与引用保留。
    const afterCallback = sendThread.slice(sendThread.lastIndexOf('});'));
    expect(afterCallback).not.toContain('setThreadInput');
    expect(afterCallback).not.toContain('setThreadSelections');
  });
});
