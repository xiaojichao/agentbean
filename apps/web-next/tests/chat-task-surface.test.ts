import { readFileSync } from 'node:fs';
import { describe, expect, test } from 'vitest';

describe('chat task surface', () => {
  test('keeps task-linked messages as compact timeline badges', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain('function ChatTaskBadge');
    expect(source).not.toContain('data-smoke="chat-task-card"');
    expect(source).not.toContain('function ChatTaskCard');
  });

  test('opens the status menu from the whole task badge instead of task detail', () => {
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
  });

  test('聊天、Activity 与消息搜索共用 chat-view 投影，TaskDetail 从原始消息恢复状态历史', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source.match(/projectChatViewMessages\(/g)?.length).toBeGreaterThanOrEqual(3);
    expect(source).toContain('taskStatusMessagesForTask(messages, taskDetailTaskId)');
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

  test('频道任务详情复用 Server Task DAG 投影', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function TaskDetailPanel');
    const end = source.indexOf('function ThreadPanel', start);
    const detailPanel = source.slice(start, end);

    expect(detailPanel).toContain('taskEvents().getDag(detailTaskId)');
    expect(detailPanel).toContain('acceptTaskDagSnapshot(current, result.dag)');
    expect(detailPanel).toContain('<TaskDagPanel');
    expect(detailPanel).toContain('const showTaskDag = Boolean(');
    expect(detailPanel).toContain('const showTaskDelivery = Boolean(');
    expect(detailPanel).toContain('尚未产生 Task DAG；阶段责任、交付与审核事实见下方。');
    expect(detailPanel).toContain('w-[min(720px,46vw)]');
    expect(detailPanel).toContain("workspaceEntry?.governance.mode === 'managed'");
    expect(detailPanel).toContain('仅显示当前可用的具名流程操作');
    expect(detailPanel).toContain('data-smoke="task-detail-readonly"');
    expect(detailPanel).toContain('频道已归档，任务状态只读。');
    expect(source).toContain('readOnly={Boolean(activeChannelObj?.archivedAt)}');
    expect(source).toContain('if (activeChannelObj?.archivedAt)');
  });

  test('有关联消息的任务深链保留显式 Tasks / Files 主区', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('const nextTaskMessageId = parseScopedMessageId(taskParam, activeChannel);');
    const end = source.indexOf('}, [activeChannel, chatTabParam, taskParam]);', start);
    expect(start).toBeGreaterThan(-1);
    expect(end).toBeGreaterThan(start);

    const taskParamEffect = source.slice(start, end);
    expect(taskParamEffect).toContain("if (chatTabParam !== 'tasks' && chatTabParam !== 'files') setTab('chat');");
  });

  test('公开频道任务投影补齐当前用户，并让任务详情复用同一参与者集合', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    expect(source).toContain("!channelMembers.some((member) => member.kind === 'human' && member.id === currentUser.id)");
    expect(source).toContain('channelMembers={taskParticipants}');
  });

  test('普通任务按负责人筛选，只在已有 Server 事实时渲染项目摘要', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain("(task.assigneeId ?? 'unassigned') !== assigneeFilter");
    expect(source).toContain('全部负责人');
    expect(source).toContain('负责人 / 已有关联事实');
    expect(source).toContain('channelTaskHasProjectFacts(entry)');
    expect(source.match(/<ChannelTaskFactSummary/g)?.length).toBeGreaterThanOrEqual(1);
  });

  test('普通任务是辅助状态视图且默认使用紧凑列表，项目工作台承载阶段审核主路径', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');

    expect(source).toContain("useState<TaskViewMode>('list')");
    expect(source).toContain('项目工作台');
    expect(source).toContain('阶段推进 · 交付审核 · final');
    expect(source).toContain('辅助视图：普通任务状态 + 负责人');
    expect(source).toContain('未进入阶段流程的任务');
    expect(source).toContain('项目责任、审核和 final 以项目工作台的 Server 投影为准');
  });

  test('#1179 项目阶段配置只在独立设置面，并用 revision 保护与 createStage 追加阶段', () => {
    const source = readFileSync(new URL('../app/[teamPath]/chat/page.tsx', import.meta.url), 'utf8');
    const start = source.indexOf('function ConversationTasks');
    const end = source.indexOf('function TaskFilterMenu', start);
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

    const progressStart = panel.indexOf('subview === \'project\'');
    const progressEnd = panel.indexOf('loadError ?', progressStart);
    const progressBranch = panel.slice(progressStart, progressEnd);
    expect(progressBranch).toContain('<ChannelProjectProgress');
    expect(progressBranch).not.toContain('<ChannelProjectOverview');
    expect(progressBranch).not.toContain('onCreateEdge');
    expect(progressBranch).not.toContain('createInitialProjectStage');
  });
});
