import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

const chatSource = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
const appShellSource = readFileSync(new URL('../components/app-shell.tsx', import.meta.url), 'utf8');
const sidebarSource = readFileSync(new URL('../components/sidebar.tsx', import.meta.url), 'utf8');
const settingsSource = readFileSync(new URL('../app/[teamPath]/settings/page.tsx', import.meta.url), 'utf8');
const searchPageSource = readFileSync(new URL('../app/[teamPath]/search/page.tsx', import.meta.url), 'utf8');
const activityPageSource = readFileSync(new URL('../app/[teamPath]/activity/page.tsx', import.meta.url), 'utf8');

describe('chat task surface', () => {
  test('keeps task-linked messages as compact timeline badges', () => {
    const source = chatSource;

    expect(source).toContain('function ChatTaskBadge');
    expect(source).not.toContain('data-smoke="chat-task-card"');
    expect(source).not.toContain('function ChatTaskCard');
  });

  test('全局侧栏对齐 Raft 单列入口，搜索与活动离开聊天侧栏成为独立页面', () => {
    expect(appShellSource).toContain('flex min-w-0 flex-1 flex-col overflow-hidden');
    expect(sidebarSource).toContain('w-16 shrink-0');
    expect(sidebarSource).not.toContain('md:w-52');
    expect(sidebarSource).toContain('<span className="sr-only">{label}</span>');
    expect(sidebarSource).not.toContain('<Bot');
    expect(sidebarSource).toContain('href={`/${np}/search`}');
    expect(sidebarSource).toContain('href={`/${np}/activity`}');
    expect(sidebarSource.indexOf('label="搜索"')).toBeLessThan(sidebarSource.indexOf('label="聊天"'));
    expect(sidebarSource.indexOf('label="聊天"')).toBeLessThan(sidebarSource.indexOf('label="活动"'));
    expect(sidebarSource.indexOf('label="活动"')).toBeLessThan(sidebarSource.indexOf('label="任务"'));
    expect(sidebarSource).toContain('label="提醒"');
    expect(sidebarSource).toContain('label="帮助和资源"');
    expect(sidebarSource).toContain('label="设置"');
    expect(chatSource).toContain("activeChannel && !mobileConversationListOpen ? 'hidden md:flex md:w-60' : 'flex w-full md:w-60'");
    expect(chatSource).toContain('{!standalone && (');
    expect(chatSource).toContain('data-smoke="channel-mobile-list-back"');
    expect(chatSource).toContain('onClick={() => setMobileConversationListOpen(true)}');
    expect(chatSource).toContain('setMobileConversationListOpen(false); setActiveChannel(ch.id)');
    expect(chatSource).toContain("setMobileConversationListOpen(false); setSidebarView(sidebarView === 'saved' ? 'channels' : 'saved')");
    expect(chatSource).toContain("setMobileConversationListOpen(false); setSidebarView(sidebarView === 'pinned' ? 'channels' : 'pinned')");
    expect(chatSource).not.toContain('data-smoke="channel-search-open"');
    expect(chatSource).not.toContain('openActiveConversationSearch');
    expect(chatSource).toContain("pathname.endsWith('/search')");
    expect(chatSource).toContain("pathname.endsWith('/activity')");
    expect(searchPageSource).toContain('<ChatPage />');
    expect(activityPageSource).toContain('<ChatPage />');
    expect(chatSource).toContain('className="flex min-w-0 flex-1 overflow-hidden"');
    expect(sidebarSource).toContain('切换团队，当前团队：');
    expect(sidebarSource).toContain('创建团队');
    expect(sidebarSource).not.toContain('切换或创建团队');
    expect(sidebarSource).toContain('h-14 shrink-0 items-center justify-center border-b border-neutral-200');
    expect(sidebarSource).toContain('bg-[#F7F7F5]');
    expect(sidebarSource).toContain('rounded-bl-none');
    expect(sidebarSource).not.toContain('gap-1 border-t border-neutral-900/20');
    expect(sidebarSource).toContain('data-smoke="notifications-menu"');
    expect(sidebarSource).toContain('data-smoke="help-resources-menu"');
    expect(settingsSource).not.toContain('data-smoke="settings-admin-console-link"');
    expect(settingsSource).not.toContain('管理后台');
  });

  test('普通任务从整枚徽标打开完整状态菜单，受管任务只保留取消与关闭', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ChatTaskBadge');
    const end = source.indexOf('function taskBadgeIcon', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const badge = source.slice(start, end);
    expect(badge).toContain("if (canChange) onOpen?.(!open);");
    expect(badge).not.toContain('onOpenDetail');
    expect(badge).not.toContain('rounded-l-full');
    expect(badge).not.toContain('rounded-r-full');
    expect(source).toContain('taskStatusOptions={task');
    expect(source).toContain("if (entry.governance.mode === 'managed') return ['cancelled', 'closed'];");
    expect(badge).toContain('TASK_COLUMNS.filter((status) => statusOptions.includes(status.id))');
  });

  test('聊天、Activity 与消息搜索共用 chat-view 投影，TaskDetail 从原始消息恢复状态历史', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source.match(/projectChatViewMessages\(/g)?.length).toBeGreaterThanOrEqual(3);
    // 原型对齐（R4）：任务详情侧边栏不再渲染消息上下文区块（状态历史/最新结果/环境信息/附件）。
    expect(source).not.toContain('taskStatusMessagesForTask(messages, taskDetailTaskId)');
    expect(source).toContain('taskIdForStatusMessageDeepLink(messages, targetMessageId)');
  });

  test('隐藏状态消息深链只重写 Task URL，不复制 TaskDetail 本地状态', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const linkedTaskId = taskIdForStatusMessageDeepLink');
    const end = source.indexOf("setTab('chat');", start);
    const redirectBranch = source.slice(start, end);

    expect(redirectBranch).toContain("params.set('task'");
    expect(redirectBranch).not.toContain('setTaskDetailMessageId');
    expect(redirectBranch).not.toContain('setTaskDetailOnlyTaskId');
  });

  test('ThreadPanel 只把根消息解析出的 Task id 交给既有活动卡 section', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ThreadPanel');
    const end = source.indexOf('function ProfilePanel', start);
    const threadPanel = source.slice(start, end);

    expect(threadPanel).toContain('const rootTaskId = metaTaskId(root);');
    expect(threadPanel).toContain('<TaskThreadActivitySection');
    expect(threadPanel).toContain('taskId={rootTaskId}');
    expect(threadPanel).toContain('threadId={root.id}');
  });

  test('任务详情保留交付视图与治理事实，原型外区块已移除', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function TaskDetailPanel');
    const end = source.indexOf('function ThreadPanel', start);
    const detailPanel = source.slice(start, end);

    // 原型对齐（R4）：交付视图与任务治理保留；Task DAG/任务消息/最新结果/环境信息/附件区块移除。
    expect(detailPanel).toContain('const showTaskDelivery = Boolean(');
    expect(detailPanel).toContain('onOverviewChange={setTaskDeliveryOverview}');
    expect(detailPanel).toContain("taskDeliveryOverview?.governance?.mode === 'managed'");
    expect(detailPanel).toContain('const managedTask =');
    expect(detailPanel).toContain('const taskGovernancePending = Boolean(');
    expect(detailPanel).toContain('!taskDeliveryOverview?.governance');
    expect(detailPanel).toContain('正在读取 Server 任务治理状态');
    expect(detailPanel).not.toContain('taskEvents().getDag(detailTaskId)');
    expect(detailPanel).not.toContain('<TaskDagPanel');
    expect(detailPanel).not.toContain('条 agent 回复');
    expect(detailPanel).not.toContain('环境信息');
    expect(detailPanel).not.toContain('任务消息');
    expect(detailPanel).toContain('w-[min(720px,46vw)]');
    expect(detailPanel).toContain("workspaceEntry?.governance.mode === 'managed'");
    expect(detailPanel).toContain('仅显示当前可用的具名流程操作');
    expect(detailPanel).toContain('data-smoke="task-detail-readonly"');
    expect(detailPanel).toContain('频道已归档，任务状态只读。');
    expect(source).toContain('readOnly={Boolean(activeChannelObj?.archivedAt)}');
    expect(source).toContain('if (activeChannelObj?.archivedAt)');
  });

  test('有关联消息的任务深链保留显式 Tasks / Files 主区，task-only 深链回落卡片定位', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const nextTaskMessageId = parseScopedMessageId(taskParam, activeChannel);');
    const end = source.indexOf('}, [activeChannel, chatTabParam, taskParam, searchParams, router]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const taskParamEffect = source.slice(start, end);
    expect(taskParamEffect).toContain("if (chatTabParam !== 'tasks' && chatTabParam !== 'files') setTab('chat');");
    // 原型对齐（R3/AC6）：task:<taskId> 深链不再打开侧边栏——切任务页、滚动定位卡片并清参数。
    expect(taskParamEffect).toContain("taskParam?.startsWith('task:')");
    expect(taskParamEffect).toContain("setTab('tasks')");
    expect(taskParamEffect).toContain('[data-task-id=');
    expect(taskParamEffect).toContain("params.delete('task')");
  });

  test('公开频道任务投影补齐当前用户，并让任务详情复用同一参与者集合', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    expect(source).toContain("!channelMembers.some((member) => member.kind === 'human' && member.id === currentUser.id)");
    expect(source).toContain('channelMembers={taskParticipants}');
  });

  test('普通任务工作台已移除；任务详情只在已有 Server 事实时展示交付视图', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    // plain 工作台（筛选/看板/列表/新建表单）全站不再渲染。
    expect(source).not.toContain('channel-plain-task-workspace');
    expect(source).not.toContain('新建普通任务');
    expect(source).not.toContain('未进入阶段流程的任务');
    expect(source).not.toContain('useState<TaskViewMode>');
    // Server 事实判定仍服务任务详情侧栏。
    expect(source).toContain('channelTaskHasProjectFacts(workspaceEntry)');
  });

  test('项目工作台是任务 tab 唯一视图，无子视图切换 UI', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain('<ChannelProjectProgress');
    // 微调对齐原型：子视图 tablist 整行移除（频道级锁定后无切换 UI）。
    expect(source).not.toContain('频道任务子视图');
    expect(source).not.toContain('阶段推进 · 交付审核 · final');
    expect(source).not.toContain('channel-tasks-view-project');
    expect(source).not.toContain('channel-tasks-view-plain');
  });

  test('#1179 项目阶段配置只在独立设置面，并用 revision 保护与 createStage 追加阶段', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ConversationTasks');
    const end = source.indexOf('function TaskDetailPanel', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);
    const panel = source.slice(start, end);

    expect(panel).toContain('showProjectSettings');
    expect(panel).toContain('data-smoke="channel-project-settings-dialog"');
    expect(panel).toContain('acceptChannelProjectOverview');
    expect(panel).toContain('onCreateStage={workspaceReadOnly ? undefined : createProjectStage}');
    expect(panel).toContain("projectEvents().createStage({");
    expect(panel).toContain('closeProjectSettings');
    expect(panel).toContain('void refreshProjectOverview()');

    const progressStart = panel.indexOf('<ChannelProjectProgress');
    const progressEnd = panel.indexOf('onOpenSettings', progressStart);
    const progressBranch = panel.slice(progressStart, progressEnd);
    expect(progressBranch).not.toContain('<ChannelProjectOverview');
    expect(progressBranch).not.toContain('onCreateEdge');
    expect(progressBranch).not.toContain('createInitialProjectStage');
  });

  test('频道级子视图统一：所有频道（含 #all 与私聊）一律渲染项目工作台', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    // 锁定派生已收敛为常量：不再区分 isDm / 默认频道。
    expect(source).not.toContain('lockedTasksSubview');
    expect(source).not.toContain("isDefaultPublicChannel ? 'plain'");
    expect(source).not.toContain('tasksViewParam');
    // 渲染无条件分支：项目工作台是唯一路径。
    expect(source).not.toContain("subview === 'project'");
    expect(source).not.toContain('channel-plain-task-workspace');
    expect(source).not.toContain('channel-tasks-view-project');
    expect(source).not.toContain('channel-tasks-view-plain');
  });
});
