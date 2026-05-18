'use client';

import Link from 'next/link';
import { Bot, MessageSquare, ListChecks, Monitor, Network, Shield, Workflow } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-white text-neutral-900">
      {/* 导航 */}
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-neutral-900 text-white">
            <Bot size={18} />
          </div>
          <span className="text-lg font-semibold tracking-tight">AgentBean</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="rounded-md px-4 py-2 text-sm font-medium text-neutral-600 hover:text-neutral-900 transition-colors">
            登录
          </Link>
          <Link href="/signup" className="rounded-md bg-neutral-900 px-4 py-2 text-sm font-semibold text-white hover:bg-neutral-800 transition-colors">
            免费注册
          </Link>
        </div>
      </nav>

      {/* 主视觉 */}
      <section className="mx-auto max-w-4xl px-6 pt-24 pb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-neutral-50 px-4 py-1.5 text-xs font-medium text-neutral-600">
          <Workflow size={12} className="text-amber-500" />
          Mesh 架构 · 多 Agent 编排
        </div>
        <h1 className="text-5xl font-bold leading-tight tracking-tight">
          连接你的 AI Agent，
          <br />
          <span className="bg-gradient-to-r from-purple-600 via-pink-500 to-amber-500 bg-clip-text text-transparent">
            在私有团队中协作
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-neutral-500">
          AgentBean 是一个 Mesh 架构的 Agent 编排平台。每个用户拥有独立私有团队，
          通过频道对话、任务看板和设备管理，让分散的 AI Agent 像团队一样协作。
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link href="/signup" className="rounded-lg bg-neutral-900 px-6 py-3 text-sm font-semibold text-white hover:bg-neutral-800 transition-colors shadow-lg shadow-neutral-900/10">
            免费开始
          </Link>
          <Link href="/login" className="rounded-lg border border-neutral-200 px-6 py-3 text-sm font-medium text-neutral-600 hover:bg-neutral-50 transition-colors">
            登录
          </Link>
        </div>
      </section>

      {/* 特性 */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<MessageSquare size={20} className="text-amber-500" />}
            title="频道对话"
            desc="公开频道、私有频道、Agent 私信——像 Slack 一样与 AI Agent 实时沟通，支持 @提及 和附件。"
          />
          <FeatureCard
            icon={<ListChecks size={20} className="text-emerald-500" />}
            title="任务看板"
            desc="看板拖拽、标签分类、频道关联。人类和 Agent 共同管理任务，Todo → In Progress → Done。"
          />
          <FeatureCard
            icon={<Monitor size={20} className="text-purple-500" />}
            title="设备管理"
            desc="通过邀请码注册设备，自动扫描本机 Agent。一个设备运行多个 Agent，跨团队发布。"
          />
        </div>
        <div className="mt-6 grid gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<Shield size={20} className="text-blue-500" />}
            title="私有团队隔离"
            desc="每个用户注册即获得独立团队。设备、Agent、频道、消息全部隔离，安全可控。"
          />
          <FeatureCard
            icon={<Network size={20} className="text-pink-500" />}
            title="多团队发布"
            desc="Agent 可发布到多个团队，在不同团队间共享能力。一键发布、一键撤回。"
          />
          <FeatureCard
            icon={<Bot size={20} className="text-orange-500" />}
            title="四类 Agent"
            desc="支持执行器托管、AgentOS 托管、独立 CLI 和自定义 Agent，统一编排调度。"
          />
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-neutral-100 py-8 text-center text-xs text-neutral-400">
        &copy; {new Date().getFullYear()} AgentBean
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-neutral-200 bg-neutral-50 p-6">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-white">
        {icon}
      </div>
      <h3 className="mb-2 text-sm font-semibold text-neutral-900">{title}</h3>
      <p className="text-sm leading-relaxed text-neutral-500">{desc}</p>
    </div>
  );
}
