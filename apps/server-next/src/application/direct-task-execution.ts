import type { TaskResponsibilityFocusV1 } from '../../../../packages/contracts/src/task-delivery-overview.js';
import type { DispatchRecord, MessageRecord, ServerNextRepositories, TaskRecord } from './repositories.js';
import type { TaskCoordinationTransactionRepositories } from './task-coordination-unit-of-work.js';

function isResultMessage(message: MessageRecord, dispatch: DispatchRecord): boolean {
  return message.teamId === dispatch.teamId && message.channelId === dispatch.channelId
    && message.senderKind === 'agent' && message.senderId === dispatch.agentId
    && message.meta?.dispatchId === dispatch.id
    // 旧回报可能没有 fingerprint；领取通知/协调消息不能被当作交付。
    && (typeof message.meta?.dispatchResultFingerprint === 'string' || message.meta?.kind === undefined);
}

/** 成功 Dispatch 只能推进自己当前关联的普通 Task；不覆盖终态或受管生命周期。 */
export async function markDirectTaskInReview(
  repositories: ServerNextRepositories,
  origin: MessageRecord | null,
  dispatch: DispatchRecord,
  now: number,
): Promise<TaskRecord | null> {
  return repositories.taskCoordinationUnitOfWork.run((transaction) =>
    markDirectTaskInReviewInTransaction(transaction, origin, dispatch, now));
}

async function markDirectTaskInReviewInTransaction(
  repositories: TaskCoordinationTransactionRepositories,
  origin: MessageRecord | null,
  dispatch: DispatchRecord,
  now: number,
): Promise<TaskRecord | null> {
  const taskId = typeof origin?.meta?.taskId === 'string' ? origin.meta.taskId : null;
  if (!taskId || !origin || origin.id !== dispatch.messageId || origin.teamId !== dispatch.teamId
    || origin.channelId !== dispatch.channelId || dispatch.status !== 'succeeded') return null;
  const task = await repositories.tasks.getById(taskId);
  if (!task || task.teamId !== dispatch.teamId || task.channelId !== dispatch.channelId
    || !['todo', 'in_progress'].includes(task.status)) return null;
  // 历史 direct Dispatch 没有冻结 revision 的协议；只能兼容初始 revision，不能猜测新 revision。
  if (task.revision !== 1 || task.createdAt > dispatch.createdAt
    || (task.assigneeId && task.assigneeId !== dispatch.agentId)) return null;
  const [coordination, run] = await Promise.all([
    repositories.coordination.coordinations.getByTaskId(taskId),
    repositories.management.runs.getByRootTaskId(taskId),
  ]);
  if (run || coordination) return null;
  const related = await repositories.dispatches.listByTaskOrigin({ teamId: task.teamId, channelId: dispatch.channelId, taskId });
  // 旧回报或补偿重放不得覆盖较新的一轮执行。
  if (related[0]?.id !== dispatch.id) return null;
  const replies = (await repositories.messages.listByDispatch(dispatch.id)).filter((reply) => isResultMessage(reply, dispatch));
  let hasEvidence = false;
  for (const reply of replies) {
    const artifacts = await repositories.artifacts.listByMessage(reply.id);
    const files = artifacts.filter((artifact) => artifact.filename !== 'workspace-run.log');
    const publishId = reply.meta?.outputPackagePublishId;
    if (typeof publishId === 'string') {
      const published = await repositories.outputPackages.getPackageByPublishId({ teamId: task.teamId, publishId });
      if (!published || published.package.taskId !== taskId || published.package.channelId !== dispatch.channelId
        || published.package.taskRevision !== task.revision || published.members.length === 0) continue;
      hasEvidence = true;
    } else if (reply.body.trim() || files.length > 0) {
      hasEvidence = true;
    }
  }
  if (!hasEvidence) return null;
  // 在确认内容存在后复验状态，避免迟到结果复活已经取消/关闭的任务。
  const current = await repositories.tasks.getById(taskId);
  if (!current || current.revision !== task.revision || !['todo', 'in_progress'].includes(current.status)) return null;
  return repositories.tasks.update({ taskId, changes: { status: 'in_review', updatedAt: now } });
}

/** 只描述已存事实，不由成功回复推导任务完成，也不把状态标签当作 Agent 心跳。 */
export async function describeDirectTaskExecution(
  repositories: ServerNextRepositories,
  input: { task: TaskRecord; channelId: string; packageCount: number; pendingCount: number },
): Promise<TaskResponsibilityFocusV1> {
  const { task } = input;
  if (['done', 'cancelled', 'closed'].includes(task.status)) return { kind: 'none', detail: '任务已结束' };
  if (task.status === 'in_review' && input.pendingCount > 0) {
    return { kind: 'review_wait', detail: '交付文件仍在发布，请等待发布完成后审核' };
  }
  if (task.status === 'in_review' && input.packageCount > 0) {
    return { kind: 'review_wait', detail: '等待文件审核与交付验收' };
  }
  const dispatches = await repositories.dispatches.listByTaskOrigin({
    teamId: task.teamId, channelId: input.channelId, taskId: task.id,
  });
  const active = dispatches.find((dispatch) => ['queued', 'accepted', 'running'].includes(dispatch.status));
  if (active) return { kind: 'none', detail: active.status === 'running'
    ? '存在执行中的派发记录，请在讨论串核对最新进展'
    : '已派发，等待 Agent 开始执行' };
  const latest = dispatches[0];
  if (task.status === 'in_progress') {
    return { kind: 'none', detail: latest
      ? '原执行已结束，当前没有活动执行；请确认是否继续'
      : '暂无关联的执行记录；进行中状态不代表 Agent 正在运行' };
  }
  if (task.status === 'in_review') {
    const replies = latest?.status === 'succeeded'
      ? (await repositories.messages.listByDispatch(latest.id)).filter((reply) => isResultMessage(reply, latest))
      : [];
    return { kind: 'review_wait', detail: replies.some((reply) => reply.body.trim())
      ? 'Agent 已回复，暂无交付文件包；请核对原回复及交付要求'
      : '暂无交付文件包，也未找到可核对的结果回报；请检查原讨论串' };
  }
  if (latest && ['failed', 'timed_out', 'cancelled'].includes(latest.status)) {
    const label = latest.status === 'failed' ? '失败' : latest.status === 'timed_out' ? '超时' : '取消';
    return { kind: 'none', detail: `上次执行已${label}，等待处理；不会因处于待办而自动重跑` };
  }
  return { kind: 'none', detail: latest?.status === 'succeeded'
    ? '已有成功回报，但任务仍为待办；请核对后续状态操作'
    : '暂无关联的执行记录；请确认是否仍需安排' };
}
