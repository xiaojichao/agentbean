'use client';

import type { TaskDagNodeViewDto, TaskDagResultRefDto, TaskDagViewDto } from '@agentbean/contracts';
import { CheckCircle2, CircleDashed, GitBranch, UserRound } from 'lucide-react';
import { orderedTaskDagNodes } from '@/lib/task-dag';

const STATUS_LABELS: Record<TaskDagNodeViewDto['task']['status'], string> = {
  todo: '待处理',
  in_progress: '进行中',
  in_review: '待审核',
  done: '已完成',
  closed: '已关闭',
};

export function TaskDagPanel({ dag, teamPath }: { dag: TaskDagViewDto; teamPath: string }) {
  const ordered = orderedTaskDagNodes(dag);
  return (
    <section className="rounded-md border border-violet-200 bg-violet-50/40 p-3" data-smoke="task-dag-panel" data-graph-revision={dag.graphRevision}>
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 text-xs font-semibold text-violet-900">
          <GitBranch size={14} />
          Task DAG
        </div>
        <span className="text-[10px] text-violet-500">rev {dag.graphRevision}</span>
      </div>
      <div className="mt-3 space-y-2">
        {ordered.map((node) => (
          <TaskDagNode key={node.task.id} node={node} teamPath={teamPath} />
        ))}
      </div>
      {(dag.handoffs?.length ?? 0) > 0 && (
        <details className="mt-3 border-t border-violet-100 pt-2" data-smoke="task-dag-handoffs">
          <summary className="cursor-pointer text-[11px] font-medium text-violet-700">
            协作轨迹（默认折叠，{dag.handoffs!.length}）
          </summary>
          <div className="mt-2 space-y-1.5 text-[10px] text-neutral-600">
            {dag.handoffs!.map((handoff) => (
              <div key={handoff.id} className="rounded border border-violet-100 bg-white px-2 py-1.5">
                <div className="font-medium text-neutral-700">
                  {handoff.fromAgentId ?? 'Manager'} → {handoff.toAgentId}
                </div>
                <div className="mt-0.5 text-neutral-500">
                  {handoff.kind} · {handoff.status} · {handoff.objective}
                </div>
              </div>
            ))}
          </div>
        </details>
      )}
      <details className="mt-3 border-t border-violet-100 pt-2" data-smoke="task-dag-events">
        <summary className="cursor-pointer text-[11px] font-medium text-violet-700">管理事件（默认折叠，{dag.events.length}）</summary>
        <div className="mt-2 space-y-1 text-[10px] text-neutral-500">
          {dag.events.map((event) => <div key={event.sequence}>#{event.sequence} · {event.type}</div>)}
        </div>
      </details>
    </section>
  );
}

function TaskDagNode({ node, teamPath }: { node: TaskDagNodeViewDto; teamPath: string }) {
  const depth = node.coordination.nodeKind === 'root' ? 0 : 1;
  return (
    <div className="rounded border border-neutral-200 bg-white p-2.5" style={{ marginLeft: depth * 14 }} data-smoke="task-dag-node" data-task-id={node.task.id} data-task-revision={node.taskRevision}>
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 text-xs font-semibold text-neutral-900">
            {node.task.status === 'done' ? <CheckCircle2 size={12} className="text-emerald-600" /> : <CircleDashed size={12} className="text-neutral-400" />}
            <span className="truncate">{node.task.title}</span>
          </div>
          <div className="mt-1 text-[10px] text-neutral-400">
            {node.coordination.nodeKind === 'root' ? '根任务' : '子任务'} · {STATUS_LABELS[node.task.status]} · attempt {node.coordination.attempt}/{node.coordination.maxAttempts}
          </div>
        </div>
        <span className="shrink-0 text-[10px] text-neutral-400">r{node.taskRevision}</span>
      </div>
      {node.coordination.dependencyTaskIds.length > 0 && (
        <div className="mt-2 text-[10px] text-neutral-500">依赖：{node.coordination.dependencyTaskIds.join('、')}</div>
      )}
      {(node.claim || node.task.assigneeId) && (
        <div className="mt-2 flex items-center gap-1 text-[10px] text-neutral-600">
          <UserRound size={11} />
          {node.claim?.agentId ?? node.task.assigneeId} · {node.claim?.status ?? 'assigned'}
        </div>
      )}
      {node.canonicalAcceptance && (
        <div className="mt-2 text-[10px] text-neutral-600">验收：{node.canonicalAcceptance.decision} · {node.canonicalAcceptance.reason}</div>
      )}
      {node.latestDelivery && <div className="mt-2 text-[11px] leading-5 text-neutral-700">{node.latestDelivery.summary}</div>}
      {node.resultRefs.length > 0 && (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {node.resultRefs.map((ref) => <ResultLink key={`${ref.kind}:${ref.id}`} refValue={ref} node={node} teamPath={teamPath} />)}
        </div>
      )}
    </div>
  );
}

function ResultLink({ refValue, node, teamPath }: { refValue: TaskDagResultRefDto; node: TaskDagNodeViewDto; teamPath: string }) {
  const href = resultHref(refValue, node, teamPath);
  const label = refValue.kind === 'message' ? '原始回复' : refValue.kind === 'workspace-run' ? 'Workspace Run' : refValue.kind === 'artifact' ? 'Artifact' : 'Invocation';
  return href
    ? <a href={href} className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-sky-700 hover:bg-sky-50">{label}</a>
    : <span className="rounded border border-neutral-200 px-1.5 py-0.5 text-[10px] text-neutral-500" title={refValue.id}>{label}</span>;
}

function resultHref(refValue: TaskDagResultRefDto, node: TaskDagNodeViewDto, teamPath: string): string | null {
  if (refValue.kind !== 'message' || !node.task.channelId) return null;
  const target = encodeURIComponent(`${node.task.channelId}:${refValue.id}`);
  return `/${teamPath}/channel/${node.task.channelId}?message=${target}`;
}
