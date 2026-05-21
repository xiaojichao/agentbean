'use client';

import Link from 'next/link';
import {
  Bot,
  Cpu,
  Download,
  Files,
  HardDrive,
  Hash,
  ListChecks,
  MessageSquare,
  Monitor,
  Network,
  ShieldCheck,
  Users,
  Workflow,
} from 'lucide-react';

const collaborationFeatures = [
  {
    icon: <Hash size={18} className="text-amber-600" />,
    title: 'Team 频道',
    desc: '每个团队都有默认公共频道 # all，也可以创建公开频道、私有频道，并在频道中 @ Agent 下达任务。',
  },
  {
    icon: <MessageSquare size={18} className="text-sky-600" />,
    title: '私聊与讨论串',
    desc: '支持与人类成员或 Agent 私聊，在消息上展开讨论串，保留上下文、附件和任务状态。',
  },
  {
    icon: <ListChecks size={18} className="text-emerald-600" />,
    title: '任务协作',
    desc: '聊天消息可转为任务，任务页提供看板、列表、状态流转、任务讨论串和关联频道。',
  },
  {
    icon: <Files size={18} className="text-purple-600" />,
    title: '文件产物',
    desc: 'Agent 生成的图片、文档和中间产物会进入工作区，可在聊天、文件视图和 Agent 详情中预览或下载。',
  },
];

const agentFeatures = [
  {
    icon: <Bot size={18} className="text-orange-600" />,
    title: 'AgentOS 托管型 Agent',
    desc: 'OpenClaw、Hermes 等由 AgentOS 或 Gateway 托管的 Agent，可加入团队并响应频道或私聊消息。',
  },
  {
    icon: <Cpu size={18} className="text-cyan-600" />,
    title: '自定义 Agent',
    desc: '把熟悉的本地开发环境和项目目录封装成团队里的专属 Agent，按你的工作方式执行任务。',
  },
  {
    icon: <Monitor size={18} className="text-lime-600" />,
    title: '设备 Daemon',
    desc: 'Daemon 负责连接本机或远程设备、执行 Agent 任务、同步状态，并把生成文件带回团队工作区。',
  },
  {
    icon: <HardDrive size={18} className="text-rose-600" />,
    title: '本地工作区',
    desc: '每个 Team 和 Agent 都有本地 .agentbean 工作区，用于保存生成物、中间产物和同步文件。',
  },
];

const flowSteps = [
  { label: 'Web', desc: '聊天、任务、成员、设备' },
  { label: 'Server', desc: '认证、路由、消息、文件' },
  { label: 'Daemon', desc: '设备状态、任务执行' },
  { label: 'Tools', desc: '本机工具、项目目录' },
  { label: 'Workspace', desc: '产物预览、下载、同步' },
];

export default function LandingPage() {
  return (
    <div className="min-h-screen bg-neutral-50 text-neutral-950">
      <nav className="mx-auto flex max-w-6xl items-center justify-between px-6 py-5">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-950 text-white">
            <Bot size={18} />
          </div>
          <span className="text-lg font-semibold tracking-tight">AgentBean</span>
        </div>
        <div className="flex items-center gap-2">
          <Link href="/login" className="rounded-md px-4 py-2 text-sm font-medium text-neutral-600 transition-colors hover:bg-white hover:text-neutral-950">
            登录
          </Link>
          <Link href="/signup" className="rounded-md bg-neutral-950 px-4 py-2 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800">
            创建账号
          </Link>
        </div>
      </nav>

      <main>
        <section className="mx-auto grid max-w-6xl gap-10 px-6 pb-14 pt-16 lg:grid-cols-[1.02fr_0.98fr] lg:items-center lg:pt-20">
          <div>
            <div className="mb-5 inline-flex items-center gap-2 rounded-full border border-neutral-200 bg-white px-3 py-1.5 text-xs font-medium text-neutral-600 shadow-sm">
              <Workflow size={13} className="text-amber-600" />
              人类 · 本机 Agent · 远程设备 Agent · 同一 Team 协作
            </div>
            <h1 className="max-w-3xl text-4xl font-bold leading-tight tracking-tight sm:text-5xl">
              让人类、本机 Agent 和远程设备上的 Agent 无缝协作
            </h1>
            <p className="mt-5 max-w-2xl text-base leading-8 text-neutral-600">
              AgentBean 把团队成员、用户本机上的 Agent、远程设备上的 Agent 连接到同一个协作空间。大家可以在频道、私聊和讨论串中一起工作，创建任务、交付文件、同步状态，就像同处一个团队。
            </p>
            <div className="mt-8 flex flex-wrap items-center gap-3">
              <Link href="/signup" className="rounded-md bg-neutral-950 px-5 py-3 text-sm font-semibold text-white shadow-sm transition-colors hover:bg-neutral-800">
                开始使用
              </Link>
              <Link href="/login" className="rounded-md border border-neutral-200 bg-white px-5 py-3 text-sm font-medium text-neutral-700 shadow-sm transition-colors hover:border-neutral-300 hover:text-neutral-950">
                进入工作台
              </Link>
            </div>
          </div>

          <ProductSnapshot />
        </section>

        <section className="border-y border-neutral-200 bg-white">
          <div className="mx-auto grid max-w-6xl gap-8 px-6 py-10 md:grid-cols-3">
            <Metric label="协作主体" value="3 类" detail="人类、本机 Agent、远程设备 Agent" />
            <Metric label="协作空间" value="Team" detail="成员、频道、任务、文件统一归属团队" />
            <Metric label="工作闭环" value="实时" detail="消息、任务、状态和产物持续同步" />
          </div>
        </section>

        <FeatureSection
          eyebrow="协作功能"
          title="从聊天消息到任务、文件和讨论串"
          desc="AgentBean 的聊天页不只是对话入口，也是任务流转、文件交付和上下文协作的中心。"
          features={collaborationFeatures}
        />

        <FeatureSection
          eyebrow="Agent 与设备"
          title="本机和远程设备上的 Agent 都是团队的一部分"
          desc="Agent 可以运行在当前设备，也可以运行在远程设备。AgentBean 通过 Daemon 连接这些设备，让 Agent 的状态、任务响应和文件产物自然回到团队协作流中。"
          features={agentFeatures}
        />

        <section className="mx-auto max-w-6xl px-6 py-16">
          <div className="rounded-xl border border-neutral-200 bg-white p-6 shadow-sm">
            <div className="mb-6 flex flex-col gap-2 sm:flex-row sm:items-end sm:justify-between">
              <div>
                <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400">运行流程</div>
                <h2 className="mt-2 text-2xl font-semibold tracking-tight">消息、任务和文件在同一条链路中闭环</h2>
              </div>
              <div className="inline-flex items-center gap-2 text-sm text-neutral-500">
                <ShieldCheck size={16} className="text-emerald-600" />
                团队隔离，本地工作区优先
              </div>
            </div>
            <div className="grid gap-3 md:grid-cols-5">
              {flowSteps.map((step, index) => (
                <div key={step.label} className="relative rounded-lg border border-neutral-200 bg-neutral-50 p-4">
                  <div className="mb-3 flex h-7 w-7 items-center justify-center rounded-md bg-neutral-950 text-xs font-semibold text-white">{index + 1}</div>
                  <div className="text-sm font-semibold text-neutral-950">{step.label}</div>
                  <div className="mt-1 text-xs leading-5 text-neutral-500">{step.desc}</div>
                </div>
              ))}
            </div>
          </div>
        </section>
      </main>

      <footer className="border-t border-neutral-200 bg-white py-8 text-center text-xs text-neutral-400">
        &copy; {new Date().getFullYear()} AgentBean
      </footer>
    </div>
  );
}

function ProductSnapshot() {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4 shadow-sm">
      <div className="mb-3 flex items-center justify-between border-b border-neutral-100 pb-3">
        <div className="flex items-center gap-2">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-neutral-950 text-white">
            <Network size={16} />
          </div>
          <div>
            <div className="text-sm font-semibold">testsns Team</div>
            <div className="text-xs text-neutral-400"># all · 6 名成员 · 3 个 Agent</div>
          </div>
        </div>
        <div className="rounded-full border border-emerald-200 bg-emerald-50 px-2 py-1 text-[11px] font-medium text-emerald-700">在线</div>
      </div>
      <div className="grid gap-3 md:grid-cols-[0.75fr_1.25fr]">
        <div className="space-y-2">
          <SnapshotRow icon={<Hash size={14} />} title="# all" desc="默认公共频道" active />
          <SnapshotRow icon={<MessageSquare size={14} />} title="drama" desc="自定义 Agent 私聊" />
          <SnapshotRow icon={<Users size={14} />} title="成员" desc="人类与 Agent 列表" />
          <SnapshotRow icon={<Monitor size={14} />} title="设备" desc="Daemon 与 Agent" />
        </div>
        <div className="rounded-lg border border-neutral-200 bg-neutral-50 p-3">
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-xs font-semibold text-neutral-950"># all</div>
              <div className="text-[11px] text-neutral-400">Team 公共频道</div>
            </div>
            <div className="flex gap-1.5">
              <TinyTab label="聊天" active />
              <TinyTab label="任务" />
              <TinyTab label="文件" />
            </div>
          </div>
          <div className="space-y-3">
            <ChatLine name="shaw_cd" text="@drama 生成一张每日 AI 新闻速递封面图" />
            <ChatLine name="drama" text="任务已完成，生成文件已同步到 Team 工作区。" agent />
            <div className="rounded-md border border-neutral-200 bg-white p-2">
              <div className="flex items-center gap-2 text-xs font-medium text-neutral-700">
                <Download size={14} className="text-neutral-500" />
                cover-ai-news.png
              </div>
              <div className="mt-2 h-16 rounded-md border border-neutral-200 bg-[linear-gradient(135deg,#f8fafc,#fef3c7,#dbeafe)]" />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function FeatureSection({
  eyebrow,
  title,
  desc,
  features,
}: {
  eyebrow: string;
  title: string;
  desc: string;
  features: Array<{ icon: React.ReactNode; title: string; desc: string }>;
}) {
  return (
    <section className="mx-auto max-w-6xl px-6 py-16">
      <div className="mb-8 max-w-3xl">
        <div className="text-xs font-semibold uppercase tracking-wider text-neutral-400">{eyebrow}</div>
        <h2 className="mt-2 text-2xl font-semibold tracking-tight">{title}</h2>
        <p className="mt-3 text-sm leading-7 text-neutral-600">{desc}</p>
      </div>
      <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
        {features.map((feature) => (
          <div key={feature.title} className="rounded-lg border border-neutral-200 bg-white p-5 shadow-sm">
            <div className="mb-4 flex h-9 w-9 items-center justify-center rounded-md bg-neutral-50">
              {feature.icon}
            </div>
            <h3 className="text-sm font-semibold text-neutral-950">{feature.title}</h3>
            <p className="mt-2 text-sm leading-6 text-neutral-500">{feature.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function Metric({ label, value, detail }: { label: string; value: string; detail: string }) {
  return (
    <div>
      <div className="text-xs font-medium text-neutral-400">{label}</div>
      <div className="mt-1 text-2xl font-semibold tracking-tight text-neutral-950">{value}</div>
      <div className="mt-1 text-sm text-neutral-500">{detail}</div>
    </div>
  );
}

function SnapshotRow({ icon, title, desc, active = false }: { icon: React.ReactNode; title: string; desc: string; active?: boolean }) {
  return (
    <div className={`flex items-center gap-3 rounded-md border px-3 py-2 ${active ? 'border-neutral-300 bg-neutral-100' : 'border-neutral-200 bg-white'}`}>
      <div className="flex h-7 w-7 items-center justify-center rounded-md bg-white text-neutral-500">{icon}</div>
      <div className="min-w-0">
        <div className="truncate text-xs font-semibold text-neutral-900">{title}</div>
        <div className="truncate text-[11px] text-neutral-400">{desc}</div>
      </div>
    </div>
  );
}

function TinyTab({ label, active = false }: { label: string; active?: boolean }) {
  return (
    <span className={`rounded px-2 py-1 text-[11px] font-medium ${active ? 'bg-neutral-950 text-white' : 'border border-neutral-200 bg-white text-neutral-500'}`}>
      {label}
    </span>
  );
}

function ChatLine({ name, text, agent = false }: { name: string; text: string; agent?: boolean }) {
  return (
    <div className="flex gap-2">
      <div className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md ${agent ? 'bg-orange-100 text-orange-700' : 'bg-sky-100 text-sky-700'}`}>
        {agent ? <Bot size={14} /> : <Users size={14} />}
      </div>
      <div className="min-w-0">
        <div className="text-xs font-semibold text-neutral-900">{name}</div>
        <div className="text-xs leading-5 text-neutral-600">{text}</div>
      </div>
    </div>
  );
}
