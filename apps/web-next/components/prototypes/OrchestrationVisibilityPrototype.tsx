'use client';

// PROTOTYPE — #901: three visibility hierarchies on the existing Tasks route,
// switchable with ?orchestrationPrototype=A|B|C. Never ship this component.

import { useEffect } from 'react';
import { useRouter, useSearchParams } from 'next/navigation';
import {
  AlertTriangle,
  ArrowLeft,
  ArrowRight,
  Check,
  Clock3,
  ExternalLink,
  GitBranch,
  History,
  ShieldAlert,
  X,
} from 'lucide-react';

type Variant = 'A' | 'B' | 'C';

const VARIANTS: readonly Variant[] = ['A', 'B', 'C'];
const VARIANT_NAMES: Record<Variant, string> = {
  A: 'Task 驾驶舱',
  B: 'Thread 锚定卡',
  C: '责任收件箱',
};

const EVENTS = [
  { time: '10:02', title: '已创建团队 Task', body: '来源：Agent escalation；需要跨 Agent 协作并汇总结果。', tone: 'milestone' },
  { time: '10:04', title: '拆解已提交', body: '5 个子任务、4 项依赖同时生效。', tone: 'milestone' },
  { time: '10:21', title: '执行者已变更', body: '研究任务因原执行者超时，grace 结束后改派给 Data Agent。', tone: 'attention' },
  { time: '10:31', title: '等待你的决定', body: '数据范围需要扩大；自动编排已暂停。', tone: 'action' },
] as const;

export function OrchestrationVisibilityPrototype({ variant }: { variant: Variant }) {
  return (
    <aside className="relative flex w-[560px] shrink-0 flex-col border-l border-neutral-200 bg-[#f7f7f5]">
      {variant === 'A' && <TaskCockpit />}
      {variant === 'B' && <ThreadAnchor />}
      {variant === 'C' && <ResponsibilityInbox />}
      <PrototypeSwitcher current={variant} />
    </aside>
  );
}

function TaskCockpit() {
  return (
    <>
      <PrototypeHeader eyebrow="系统活动 · 非 Agent 身份" title="冻结消息与编排的 Server API 合同" />
      <div className="flex-1 space-y-4 overflow-y-auto p-5 pb-24">
        <section className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-xs font-medium text-neutral-500">权威 Task 状态</div>
              <div className="mt-1 text-lg font-semibold text-neutral-950">进行中</div>
            </div>
            <span className="rounded-full bg-blue-50 px-2.5 py-1 text-xs font-semibold text-blue-700">in_progress</span>
          </div>
          <div className="mt-4 border-t border-neutral-100 pt-4">
            <div className="text-xs font-medium text-neutral-500">当前编排进展</div>
            <div className="mt-1 flex items-center gap-2 text-sm font-medium text-neutral-900">
              <Clock3 size={15} className="text-amber-600" />
              等待数据范围授权
            </div>
            <p className="mt-1 text-xs leading-5 text-neutral-500">3/5 个子任务已完成；自动编排已释放 driver lease。</p>
          </div>
        </section>

        <ActionRequired />

        <section className="rounded-xl border border-neutral-200 bg-white p-4">
          <div className="flex items-center justify-between">
            <div className="flex items-center gap-2 text-sm font-semibold text-neutral-900">
              <GitBranch size={15} />
              子任务进度
            </div>
            <span className="text-xs text-neutral-500">3 / 5</span>
          </div>
          <div className="mt-3 h-2 overflow-hidden rounded-full bg-neutral-100">
            <div className="h-full w-3/5 rounded-full bg-emerald-500" />
          </div>
          <div className="mt-3 grid grid-cols-3 gap-2 text-center text-[11px]">
            <Metric value="3" label="已完成" tone="text-emerald-700" />
            <Metric value="1" label="等待中" tone="text-amber-700" />
            <Metric value="1" label="未开始" tone="text-neutral-500" />
          </div>
        </section>

        <section>
          <div className="mb-2 flex items-center justify-between">
            <h3 className="text-sm font-semibold text-neutral-900">活动时间线</h3>
            <button className="text-xs font-medium text-neutral-500 hover:text-neutral-900">查看审计</button>
          </div>
          <EventTimeline />
        </section>
      </div>
    </>
  );
}

function ThreadAnchor() {
  return (
    <>
      <PrototypeHeader eyebrow="讨论串 · #architecture" title="冻结消息与编排合同" />
      <div className="flex-1 space-y-4 overflow-y-auto bg-white p-5 pb-24">
        <section className="rounded-lg border border-sky-100 bg-sky-50 p-3">
          <div className="flex items-center justify-between text-xs">
            <span className="font-semibold text-sky-900">你</span>
            <span className="text-sky-600">10:01</span>
          </div>
          <p className="mt-2 text-sm leading-6 text-sky-950">请协调团队冻结 Server API、事件和幂等合同。</p>
        </section>

        <section className="overflow-hidden rounded-xl border border-neutral-300 bg-white shadow-sm">
          <div className="border-b border-neutral-100 bg-neutral-50 px-4 py-3">
            <div className="flex items-center justify-between gap-3">
              <div>
                <div className="text-[11px] font-semibold uppercase tracking-wide text-neutral-500">AgentBean 系统活动</div>
                <h3 className="mt-1 text-sm font-semibold text-neutral-950">已创建团队 Task</h3>
              </div>
              <span className="rounded-full bg-blue-50 px-2 py-1 text-[11px] font-semibold text-blue-700">进行中</span>
            </div>
          </div>
          <div className="space-y-4 p-4">
            <div>
              <div className="text-xs text-neutral-500">当前进展</div>
              <div className="mt-1 flex items-center gap-2 text-sm font-medium text-neutral-900">
                <Clock3 size={14} className="text-amber-600" />
                等待数据范围授权
              </div>
            </div>
            <div className="flex items-center gap-3">
              <div className="h-1.5 flex-1 overflow-hidden rounded-full bg-neutral-100">
                <div className="h-full w-3/5 bg-emerald-500" />
              </div>
              <span className="text-xs text-neutral-500">3/5</span>
            </div>
            <div className="rounded-lg border border-amber-200 bg-amber-50 p-3">
              <div className="flex gap-2">
                <ShieldAlert size={16} className="mt-0.5 shrink-0 text-amber-700" />
                <div>
                  <div className="text-xs font-semibold text-amber-950">需要你的决定</div>
                  <p className="mt-1 text-xs leading-5 text-amber-800">一个子任务需要扩大数据范围，编排已暂停。</p>
                </div>
              </div>
            </div>
            <div className="flex items-center justify-between border-t border-neutral-100 pt-3">
              <button className="inline-flex items-center gap-1 text-xs font-semibold text-neutral-700">
                最近 4 项进展 <History size={13} />
              </button>
              <button className="inline-flex items-center gap-1 rounded-md bg-neutral-900 px-3 py-1.5 text-xs font-semibold text-white">
                查看 Task <ExternalLink size={12} />
              </button>
            </div>
          </div>
        </section>

        <div className="border-t border-neutral-100 pt-4 text-center text-[11px] text-neutral-400">
          系统活动不会以 PI Manager 聊天气泡出现
        </div>
      </div>
    </>
  );
}

function ResponsibilityInbox() {
  return (
    <>
      <PrototypeHeader eyebrow="待处理 · 1 项责任" title="需要你的决定" />
      <div className="grid min-h-0 flex-1 grid-cols-[190px_1fr] pb-20">
        <nav className="border-r border-neutral-200 bg-white p-3">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">责任收件箱</div>
          <button className="w-full rounded-lg border border-amber-200 bg-amber-50 p-3 text-left">
            <div className="flex items-center gap-2 text-xs font-semibold text-amber-950">
              <ShieldAlert size={14} />
              范围授权
            </div>
            <div className="mt-1 line-clamp-2 text-[11px] leading-4 text-amber-800">冻结消息与编排的 Server API 合同</div>
            <div className="mt-2 text-[10px] text-amber-700">7 分钟前 · 未处理</div>
          </button>
          <div className="mt-4 text-[11px] font-semibold uppercase tracking-wide text-neutral-400">普通通知</div>
          <div className="mt-2 rounded-lg px-3 py-2 text-xs text-neutral-500">
            拆解已提交
            <div className="mt-1 text-[10px] text-neutral-400">已读 · 27 分钟前</div>
          </div>
        </nav>

        <main className="overflow-y-auto p-5">
          <div className="inline-flex items-center gap-1.5 rounded-full bg-amber-100 px-2.5 py-1 text-[11px] font-semibold text-amber-800">
            <AlertTriangle size={12} />
            action_required
          </div>
          <h3 className="mt-3 text-lg font-semibold text-neutral-950">是否允许扩大数据范围？</h3>
          <p className="mt-2 text-sm leading-6 text-neutral-600">当前子任务需要读取额外的历史审计记录。此权限不包含在原 promotion authorization 中。</p>

          <dl className="mt-5 space-y-3 rounded-lg border border-neutral-200 bg-white p-4 text-xs">
            <Fact label="关联 Task" value="冻结消息与编排的 Server API 合同" />
            <Fact label="提出原因" value="现有数据不足以验证兼容性边界" />
            <Fact label="当前影响" value="自动编排暂停；其他已完成结果保留" />
            <Fact label="授权版本" value="Task rev. 4 · DAG rev. 2" />
          </dl>

          <div className="mt-5 space-y-2">
            <button className="w-full rounded-lg bg-neutral-900 px-4 py-2.5 text-sm font-semibold text-white">批准扩大范围</button>
            <button className="w-full rounded-lg border border-neutral-300 bg-white px-4 py-2.5 text-sm font-semibold text-neutral-700">保持原范围并重新规划</button>
          </div>
          <p className="mt-3 text-center text-[11px] leading-4 text-neutral-400">查看通知只清除未读；此责任会保留到合法命令成功。</p>
        </main>
      </div>
    </>
  );
}

function PrototypeHeader({ eyebrow, title }: { eyebrow: string; title: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const close = () => {
    const params = new URLSearchParams(searchParams.toString());
    params.delete('orchestrationPrototype');
    router.replace(`?${params.toString()}`, { scroll: false });
  };
  return (
    <header className="flex h-16 shrink-0 items-center justify-between border-b border-neutral-200 bg-white px-5">
      <div className="min-w-0">
        <div className="truncate text-[10px] font-semibold uppercase tracking-[0.14em] text-neutral-400">{eyebrow}</div>
        <div className="mt-1 truncate text-sm font-semibold text-neutral-950">{title}</div>
      </div>
      <button onClick={close} className="rounded-md p-1.5 text-neutral-400 hover:bg-neutral-100 hover:text-neutral-800" aria-label="关闭原型">
        <X size={16} />
      </button>
    </header>
  );
}

function ActionRequired() {
  return (
    <section className="rounded-xl border border-amber-300 bg-amber-50 p-4">
      <div className="flex gap-3">
        <ShieldAlert size={18} className="mt-0.5 shrink-0 text-amber-700" />
        <div>
          <div className="text-sm font-semibold text-amber-950">需要你的决定</div>
          <p className="mt-1 text-xs leading-5 text-amber-800">一个子任务需要读取额外历史审计记录，超出原授权范围。</p>
        </div>
      </div>
      <div className="mt-3 flex gap-2">
        <button className="rounded-md bg-amber-900 px-3 py-1.5 text-xs font-semibold text-white">查看并处理</button>
        <button className="rounded-md border border-amber-300 bg-white/70 px-3 py-1.5 text-xs font-semibold text-amber-900">取消 Task</button>
      </div>
    </section>
  );
}

function EventTimeline() {
  return (
    <div className="space-y-2">
      {[...EVENTS].reverse().map((event) => (
        <div key={event.time} className="flex gap-3 rounded-lg border border-neutral-200 bg-white p-3">
          <div className={`mt-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-full ${
            event.tone === 'action' ? 'bg-amber-100 text-amber-700'
              : event.tone === 'attention' ? 'bg-blue-100 text-blue-700'
                : 'bg-emerald-100 text-emerald-700'
          }`}>
            {event.tone === 'action' ? <AlertTriangle size={13} /> : <Check size={13} />}
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center justify-between gap-2">
              <span className="text-xs font-semibold text-neutral-900">{event.title}</span>
              <span className="text-[10px] text-neutral-400">{event.time}</span>
            </div>
            <p className="mt-1 text-[11px] leading-4 text-neutral-500">{event.body}</p>
          </div>
        </div>
      ))}
    </div>
  );
}

function Metric({ value, label, tone }: { value: string; label: string; tone: string }) {
  return (
    <div className="rounded-lg bg-neutral-50 px-2 py-2">
      <div className={`text-base font-semibold ${tone}`}>{value}</div>
      <div className="mt-0.5 text-neutral-400">{label}</div>
    </div>
  );
}

function Fact({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <dt className="text-neutral-400">{label}</dt>
      <dd className="mt-0.5 leading-5 text-neutral-800">{value}</dd>
    </div>
  );
}

function PrototypeSwitcher({ current }: { current: Variant }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const navigate = (direction: -1 | 1) => {
    const currentIndex = VARIANTS.indexOf(current);
    const next = VARIANTS[(currentIndex + direction + VARIANTS.length) % VARIANTS.length]!;
    const params = new URLSearchParams(searchParams.toString());
    params.set('orchestrationPrototype', next);
    router.replace(`?${params.toString()}`, { scroll: false });
  };

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      if (target?.matches('input, textarea, [contenteditable="true"]')) return;
      if (event.key === 'ArrowLeft') navigate(-1);
      if (event.key === 'ArrowRight') navigate(1);
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  });

  if (process.env.NODE_ENV === 'production') return null;

  return (
    <div className="absolute bottom-4 left-1/2 z-50 flex -translate-x-1/2 items-center gap-2 rounded-full bg-neutral-950 p-1.5 text-white shadow-xl">
      <button onClick={() => navigate(-1)} className="rounded-full p-1.5 hover:bg-white/15" aria-label="上一个原型">
        <ArrowLeft size={15} />
      </button>
      <div className="min-w-[150px] px-2 text-center text-xs font-semibold">
        {current} — {VARIANT_NAMES[current]}
      </div>
      <button onClick={() => navigate(1)} className="rounded-full p-1.5 hover:bg-white/15" aria-label="下一个原型">
        <ArrowRight size={15} />
      </button>
    </div>
  );
}

export function resolveOrchestrationPrototype(value: string | null): Variant | null {
  return value === 'A' || value === 'B' || value === 'C' ? value : null;
}
