import { Check, Hash, LayoutGrid } from 'lucide-react';
import { OrchestrationVisibilityPrototype } from '@/components/prototypes/OrchestrationVisibilityPrototype';

// PROTOTYPE — #901 public read-only alias for reviewing the authenticated Tasks
// route variants without changing or bypassing the app's authentication contract.
export default function OrchestrationVisibilityPrototypePage({
  searchParams,
}: {
  searchParams: { orchestrationPrototype?: string };
}) {
  if (process.env.NODE_ENV === 'production') return null;
  const variant = searchParams.orchestrationPrototype === 'B' || searchParams.orchestrationPrototype === 'C'
    ? searchParams.orchestrationPrototype
    : 'A';

  return (
    <div className="flex min-h-screen bg-white text-neutral-900">
      <nav className="flex w-56 shrink-0 flex-col border-r border-neutral-200 bg-neutral-950 p-4 text-white">
        <div className="text-sm font-semibold">AgentBean</div>
        <div className="mt-8 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">Team</div>
        <div className="mt-2 rounded-md bg-white/10 px-3 py-2 text-xs font-medium">Architecture</div>
        <div className="mt-6 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">工作区</div>
        <div className="mt-2 flex items-center gap-2 rounded-md px-3 py-2 text-xs text-neutral-400">
          <Hash size={13} /> 频道
        </div>
        <div className="flex items-center gap-2 rounded-md bg-white/10 px-3 py-2 text-xs font-medium">
          <Check size={13} /> 任务
        </div>
      </nav>

      <main className="flex min-w-0 flex-1 flex-col bg-white">
        <header className="flex h-16 items-center justify-between border-b border-neutral-200 px-5">
          <div>
            <h1 className="text-sm font-semibold">任务</h1>
            <p className="mt-0.5 text-xs text-neutral-400">#901 throwaway visibility prototype</p>
          </div>
          <div className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-2.5 py-1.5 text-xs text-neutral-600">
            <LayoutGrid size={13} /> 看板
          </div>
        </header>
        <div className="grid flex-1 grid-cols-3 gap-4 overflow-hidden bg-neutral-50 p-5">
          <MockColumn title="待处理" count="2" cards={['定义事件 projection schema', '冻结通知去重合同']} />
          <MockColumn title="进行中" count="1" cards={['冻结消息与编排的 Server API 合同']} active />
          <MockColumn title="验收中" count="1" cards={['验证隐藏 PI 下的系统事件与任务可见性']} />
        </div>
      </main>

      <OrchestrationVisibilityPrototype variant={variant} />
    </div>
  );
}

function MockColumn({
  title,
  count,
  cards,
  active = false,
}: {
  title: string;
  count: string;
  cards: readonly string[];
  active?: boolean;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between text-xs">
        <span className="font-semibold">{title}</span>
        <span className="text-neutral-400">{count}</span>
      </div>
      <div className="space-y-3">
        {cards.map((card) => (
          <div key={card} className={`rounded-lg border bg-white p-3 text-sm shadow-sm ${active ? 'border-neutral-900' : 'border-neutral-200'}`}>
            <div className="font-medium leading-5">{card}</div>
            <div className="mt-3 flex items-center justify-between text-[10px] text-neutral-400">
              <span>#architecture</span>
              <span>{active ? '3/5' : '—'}</span>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
