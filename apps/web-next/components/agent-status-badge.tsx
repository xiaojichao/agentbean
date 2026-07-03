import type { AgentStatus } from '@/lib/schema';

const LABEL: Record<AgentStatus, string> = {
  connecting: '连接中',
  online: '在线',
  busy: '忙碌',
  offline: '离线',
  error: '异常',
};

const STYLE: Record<AgentStatus, string> = {
  connecting: 'bg-amber-100 text-amber-800',
  online: 'bg-emerald-100 text-emerald-800',
  busy: 'bg-amber-50 text-amber-700',
  offline: 'bg-neutral-200 text-neutral-700',
  error: 'bg-rose-100 text-rose-800',
};

export function AgentStatusBadge({ status }: { status: AgentStatus }) {
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-xs font-medium ${STYLE[status]}`}>
      {LABEL[status]}
    </span>
  );
}
