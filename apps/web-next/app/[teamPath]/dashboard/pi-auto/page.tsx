'use client';

import { ConnectionBanner } from '@/components/connection-banner';

/**
 * System Admin Console — PI 自动协调状态（只读）。
 *
 * PI 自动协调已成为 AgentBean 底层必备基础设施（ADR 0062），始终运行。
 * 此面板仅展示当前状态与机制说明，不提供开关。
 * 原 Team 级开关 PiPolicyPanel（#707）已从此处迁出。
 */
export default function AdminPiAutoPage() {
  return (
    <div className="flex flex-1 flex-col overflow-hidden" data-smoke="admin-pi-auto-page">
      <div className="flex h-14 shrink-0 items-center border-b border-neutral-200 px-4">
        <h1 className="text-sm font-semibold">PI 自动协调</h1>
      </div>
      <div className="flex-1 overflow-y-auto p-6">
        <ConnectionBanner />

        <section className="rounded-lg border border-neutral-200 p-5">
          <div className="flex items-center gap-3">
            <span className="flex h-3 w-3 rounded-full bg-emerald-500" />
            <h2 className="text-sm font-semibold text-neutral-900">已启用</h2>
          </div>
          <p className="mt-3 text-sm leading-relaxed text-neutral-600">
            PI 自动协调是 AgentBean 系统级基础设施，始终运行。PI 读取每条频道消息，
            通过 AI 模型分析意图，按风险门禁自动执行低风险协调动作。
          </p>
        </section>

        <section className="mt-6 rounded-lg border border-neutral-200 p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">六种协调意图</h3>
          <div className="mt-3 space-y-2">
            <IntentRow intent="no_action" label="无动作" desc="闲聊、打招呼等纯对话内容，不触发任何协调行为。" conversational />
            <IntentRow intent="system_reply" label="系统回复" desc="简短事实性回复，如状态查询、帮助说明。" conversational />
            <IntentRow intent="clarification_required" label="追问澄清" desc="信息不足时追问一个问题，获取更多上下文。" conversational />
            <IntentRow intent="agent_request" label="Agent 请求" desc="@Agent 执行具体操作，如代码审查、文件操作。" />
            <IntentRow intent="tracked_task" label="跟踪任务" desc="需要持久跟踪和交付的任务，创建 Task 并分派。" />
            <IntentRow intent="task_followup" label="任务跟进" desc="与已有任务相关的后续消息，追加到现有 Task 上下文。" />
          </div>
          <p className="mt-3 text-xs text-neutral-400">
            会话型意图（前三个）不受任何开关影响始终执行；副作用型意图（后三个）经风险门禁裁决后执行或建议。
          </p>
        </section>

        <section className="mt-6 rounded-lg border border-neutral-200 p-5">
          <h3 className="text-xs font-semibold uppercase tracking-wider text-neutral-500">风险门禁</h3>
          <ul className="mt-3 space-y-2 text-sm text-neutral-600">
            <li className="flex items-start gap-2">
              <span className="mt-1 shrink-0 rounded bg-emerald-50 px-1.5 py-0.5 text-[10px] font-medium text-emerald-700">applied</span>
              <span>低风险动作自动执行（自动协调已启用时）。</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 shrink-0 rounded bg-amber-50 px-1.5 py-0.5 text-[10px] font-medium text-amber-700">suggested</span>
              <span>自动协调关闭时副作用动作仅建议不执行，等待人工确认。</span>
            </li>
            <li className="flex items-start gap-2">
              <span className="mt-1 shrink-0 rounded bg-red-50 px-1.5 py-0.5 text-[10px] font-medium text-red-700">blocked</span>
              <span>高风险动作（删除数据、导出敏感信息、跨团队扩作用域）永不自动执行，始终需人工确认。</span>
            </li>
          </ul>
          <p className="mt-3 text-xs text-neutral-400">
            显式 @Agent 与明确任务永远不被吞没，即使自动协调关闭也会执行。
          </p>
        </section>
      </div>
    </div>
  );
}

function IntentRow({
  intent,
  label,
  desc,
  conversational,
}: {
  intent: string;
  label: string;
  desc: string;
  conversational?: boolean;
}) {
  return (
    <div className="flex items-start gap-3 rounded-md border border-neutral-100 bg-neutral-50 px-3 py-2">
      <span className="mt-0.5 shrink-0 rounded bg-neutral-200 px-1.5 py-0.5 font-mono text-[10px] text-neutral-600">
        {intent}
      </span>
      <div>
        <span className="text-sm font-medium text-neutral-800">{label}</span>
        {conversational && (
          <span className="ml-1.5 rounded bg-blue-50 px-1.5 py-0.5 text-[10px] font-medium text-blue-600">会话型</span>
        )}
        <span className="mt-0.5 block text-xs text-neutral-500">{desc}</span>
      </div>
    </div>
  );
}
