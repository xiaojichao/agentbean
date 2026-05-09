'use client';

import Link from 'next/link';
import { Bot, Zap, Shield, Globe } from 'lucide-react';

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-neutral-950 text-white">
      {/* 导航 */}
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-lg bg-white text-neutral-900">
            <Bot size={18} />
          </div>
          <span className="text-lg font-semibold tracking-tight">AgentBean</span>
        </div>
        <div className="flex items-center gap-3">
          <Link href="/login" className="rounded-md px-4 py-2 text-sm font-medium text-neutral-300 hover:text-white transition-colors">
            登录
          </Link>
          <Link href="/signup" className="rounded-md bg-white px-4 py-2 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 transition-colors">
            免费注册
          </Link>
        </div>
      </nav>

      {/* 主视觉 */}
      <section className="mx-auto max-w-4xl px-6 pt-24 pb-16 text-center">
        <div className="mb-6 inline-flex items-center gap-2 rounded-full border border-neutral-700 bg-neutral-900 px-4 py-1.5 text-xs font-medium text-neutral-300">
          <Zap size={12} className="text-amber-400" />
          多 Agent 编排平台
        </div>
        <h1 className="text-5xl font-bold leading-tight tracking-tight">
          你的 AI Agent，
          <br />
          <span className="bg-gradient-to-r from-purple-400 via-pink-400 to-amber-400 bg-clip-text text-transparent">
            统一管理
          </span>
        </h1>
        <p className="mx-auto mt-6 max-w-2xl text-lg leading-relaxed text-neutral-400">
          跨设备管理、对话和编排 AI Agent。
          私有网络、实时协作、安全的任务管理，一站式搞定。
        </p>
        <div className="mt-10 flex items-center justify-center gap-4">
          <Link href="/signup" className="rounded-lg bg-white px-6 py-3 text-sm font-semibold text-neutral-900 hover:bg-neutral-100 transition-colors shadow-lg shadow-white/10">
            免费开始
          </Link>
          <Link href="/login" className="rounded-lg border border-neutral-700 px-6 py-3 text-sm font-medium text-neutral-300 hover:bg-neutral-800 transition-colors">
            登录
          </Link>
        </div>
      </section>

      {/* 特性 */}
      <section className="mx-auto max-w-6xl px-6 py-16">
        <div className="grid gap-6 sm:grid-cols-3">
          <FeatureCard
            icon={<Zap size={20} className="text-amber-400" />}
            title="实时对话"
            desc="与 Agent 实时沟通，发送消息、接收响应，无缝协作。"
          />
          <FeatureCard
            icon={<Shield size={20} className="text-emerald-400" />}
            title="私有网络"
            desc="每个用户拥有独立隔离网络，Agent 和设备安全可控。"
          />
          <FeatureCard
            icon={<Globe size={20} className="text-purple-400" />}
            title="多设备接入"
            desc="跨网络连接设备，借助 Tailscale 随时随地管理 Agent。"
          />
        </div>
      </section>

      {/* 页脚 */}
      <footer className="border-t border-neutral-800 py-8 text-center text-xs text-neutral-500">
        &copy; {new Date().getFullYear()} AgentBean
      </footer>
    </div>
  );
}

function FeatureCard({ icon, title, desc }: { icon: React.ReactNode; title: string; desc: string }) {
  return (
    <div className="rounded-xl border border-neutral-800 bg-neutral-900/50 p-6">
      <div className="mb-4 flex h-10 w-10 items-center justify-center rounded-lg bg-neutral-800">
        {icon}
      </div>
      <h3 className="mb-2 text-sm font-semibold text-white">{title}</h3>
      <p className="text-sm leading-relaxed text-neutral-400">{desc}</p>
    </div>
  );
}
