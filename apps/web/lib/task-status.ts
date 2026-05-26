export type TaskStatus = 'todo' | 'in_progress' | 'in_review' | 'done' | 'closed';

export const TASK_STATUS_COLUMNS: {
  id: TaskStatus;
  label: string;
  menuLabel: string;
  empty: string;
  badge: string;
  dot: string;
  collapsedByDefault?: boolean;
}[] = [
  { id: 'todo', label: '待办', menuLabel: '待办', empty: '暂无待办任务。', badge: 'border-orange-200 bg-orange-100 text-orange-700', dot: 'bg-orange-500' },
  { id: 'in_progress', label: '进行中', menuLabel: '进行中', empty: '暂无进行中任务。', badge: 'border-cyan-200 bg-cyan-100 text-cyan-700', dot: 'bg-cyan-500' },
  { id: 'in_review', label: '待审核', menuLabel: '待审核', empty: '暂无待审核任务。', badge: 'border-purple-200 bg-purple-100 text-purple-700', dot: 'bg-purple-500' },
  { id: 'done', label: '已完成', menuLabel: '已完成', empty: '暂无已完成任务。', badge: 'border-emerald-200 bg-emerald-100 text-emerald-700', dot: 'bg-emerald-500', collapsedByDefault: true },
  { id: 'closed', label: '已关闭', menuLabel: '已关闭', empty: '暂无已关闭任务。', badge: 'border-neutral-300 bg-neutral-100 text-neutral-600', dot: 'bg-neutral-500', collapsedByDefault: true },
];

export const TASK_STATUS_BY_ID = Object.fromEntries(TASK_STATUS_COLUMNS.map((column) => [column.id, column])) as Record<TaskStatus, typeof TASK_STATUS_COLUMNS[number]>;

export function isTaskStatus(value: unknown): value is TaskStatus {
  return value === 'todo' || value === 'in_progress' || value === 'in_review' || value === 'done' || value === 'closed';
}

export function taskStatusText(status: TaskStatus): string {
  return TASK_STATUS_BY_ID[status]?.label ?? status;
}

export function taskStatusDotClass(status: TaskStatus): string {
  return TASK_STATUS_BY_ID[status]?.dot ?? TASK_STATUS_BY_ID.todo.dot;
}
