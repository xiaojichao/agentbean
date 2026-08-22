import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, X } from 'lucide-react';

export const metadata: Metadata = {
  metadataBase: new URL('https://agentbean.dev'),
  title: 'AgentBean：和你的 AI 同事，在一个团队里干活',
  description:
    '本地优先的人机协作团队平台：人类、本机 Agent、远程设备 Agent 在同一个 Team 里频道聊天、认领任务、交付文件，项目目录始终留在你自己的电脑上。',
  openGraph: {
    title: '和你的 AI 同事，在一个团队里干活',
    description:
      '把 Claude Code、Codex、Hermes 接进同一个 Team：频道聊天、认领任务、交付文件。项目目录始终留在你自己的电脑上。',
    type: 'website',
    locale: 'zh_CN',
    siteName: 'AgentBean',
  },
  twitter: {
    card: 'summary_large_image',
    title: '和你的 AI 同事，在一个团队里干活',
    description: '把 Claude Code、Codex、Hermes 接进同一个 Team：频道聊天、认领任务、交付文件。',
  },
};

const navLinks = [
  { href: '#features', label: '功能' },
  { href: '#orchestration', label: '编排' },
  { href: '#quickstart', label: '快速开始' },
];

const principles = [
  {
    title: '本地优先',
    desc: '项目目录、完整运行日志、本地记忆默认留在你的设备上，不上传。',
  },
  {
    title: 'Server 只管协作',
    desc: '权限、任务真相、交付审核由服务端持有；执行始终发生在你的机器。',
  },
  {
    title: '编排不越权',
    desc: '内置 PI 只做任务分解与调度，业务代码仍由你选择的 Agent 编写。',
  },
];

const collabPoints = [
  { title: '@ 派发', desc: '提及 Agent 后，消息按权限和路由规则派发到目标执行器。' },
  { title: '消息转任务', desc: '一条频道消息可以直接提升为结构化任务，进入认领与流转。' },
  { title: '讨论串', desc: '在任意消息上展开讨论，上下文、附件与任务状态一并保留。' },
  { title: '人类审核', desc: '根交付必须经人接受或打回，读过不等于处理完。' },
];

const dagChildren = [
  { agent: 'Codex', task: '升级依赖并修复测试' },
  { agent: 'Hermes', task: '更新部署文档' },
  { agent: '审查 Agent', task: '核对变更与文档一致' },
];

const bentoCells = {
  outputPackage: {
    rows: [
      { name: 'package.json', state: 'frozen' },
      { name: 'next.config.mjs', state: 'frozen' },
      { name: 'CHANGELOG.md', state: 'frozen' },
    ],
  },
  memory: {
    rows: [
      { name: '部署走 Railway 而不是 Vercel', state: '接受' },
      { name: '测试先跑 test:ci 再提 PR', state: '接受' },
      { name: '重构不用 --force', state: '合并' },
    ],
  },
};

const archRows = [
  {
    layer: 'Web',
    pkg: 'web-next',
    duty: '登录、频道、任务、设备、管理台；展示服务端快照与事件。',
    wont: '不推断权限，不持有任务真相，不做跨 Agent 路由。',
  },
  {
    layer: 'Server',
    pkg: 'server-next',
    duty: '认证与成员、消息与任务权威、Dispatch、PI 编排、Artifact 授权。',
    wont: '不在用户设备上执行 Coding Agent。',
  },
  {
    layer: 'Device',
    pkg: 'daemon-next',
    duty: '设备连接、运行时扫描、Agent 调用、Workspace Run、产物发布、本地记忆。',
    wont: '不成为跨 Team 的全局业务真相源。',
  },
];

const quickstartSteps = [
  {
    title: '创建 Team',
    desc: '注册后在网页里建立团队，为设备生成邀请码。',
  },
  {
    title: '连接设备',
    desc: '安装 daemon 并执行 connect，终端退出后服务常驻运行。',
  },
  {
    title: '@Agent 派活',
    desc: '在频道里 @ 你的 Agent，等它认领、执行、交付，你来审核。',
  },
];

export default function LandingPage() {
  return (
    <div className="min-h-dvh bg-white text-zinc-900 antialiased">
      <Nav />
      <main>
        <Hero />
        <Principles />
        <CollabSection />
        <DagSection />
        <DeviceSection />
        <BentoSection />
        <ArchSection />
        <QuickstartSection />
      </main>
      <Footer />
    </div>
  );
}

function Nav() {
  return (
    <header className="sticky top-0 z-40 border-b border-zinc-200/80 bg-white/90 backdrop-blur">
      <nav className="mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="AgentBean" className="h-8 w-8 rounded-lg" />
          <span className="text-[17px] font-semibold tracking-tight">AgentBean</span>
        </Link>
        <div className="hidden items-center gap-7 md:flex">
          {navLinks.map((link) => (
            <a
              key={link.href}
              href={link.href}
              className="text-sm text-zinc-500 transition-colors hover:text-zinc-900"
            >
              {link.label}
            </a>
          ))}
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/login"
            className="rounded-lg px-3.5 py-2 text-sm text-zinc-600 transition-colors hover:bg-zinc-100 hover:text-zinc-900"
          >
            登录
          </Link>
          <Link
            href="/signup"
            className="rounded-lg bg-amber-400 px-3.5 py-2 text-sm font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-amber-300 active:scale-[0.98]"
          >
            创建账号
          </Link>
        </div>
      </nav>
    </header>
  );
}

function Hero() {
  return (
    <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-24 pt-16 lg:grid-cols-[1.05fr_0.95fr] lg:pb-32 lg:pt-24">
      <div className="hero-in">
        <h1 className="text-4xl font-semibold leading-[1.18] tracking-tight text-zinc-900 sm:text-5xl lg:text-6xl">
          和你的 AI 同事，
          <br />
          在一个团队里干活
        </h1>
        <p className="mt-6 max-w-xl text-lg leading-8 text-zinc-600">
          Claude Code、Codex、Hermes 不必各守一个终端。AgentBean
          让人和 Agent 进入同一个 Team：频道聊天、认领任务、交付文件，项目目录始终留在你自己的电脑上。
        </p>
        <div className="mt-9 flex flex-wrap items-center gap-3">
          <Link
            href="/signup"
            className="rounded-lg bg-amber-400 px-5 py-3 text-sm font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-amber-300 active:scale-[0.98]"
          >
            创建账号
          </Link>
          <a
            href="#quickstart"
            className="rounded-lg border border-zinc-300 bg-white px-5 py-3 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:text-zinc-950 active:scale-[0.98]"
          >
            本地跑起来
          </a>
        </div>
      </div>
      <div className="hero-in hero-in-delay">
        <TimelinePreview />
      </div>
    </section>
  );
}

function TimelinePreview() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white shadow-xl shadow-zinc-900/5">
      <div className="flex items-center justify-between border-b border-zinc-200 px-4 py-3">
        <div className="text-sm font-medium">
          #产品频道 <span className="ml-2 font-mono text-xs text-zinc-500">4 人 · 3 Agent</span>
        </div>
        <span className="font-mono text-xs text-zinc-500">14:02</span>
      </div>
      <div className="space-y-4 p-4">
        <PreviewMessage name="shaw" time="14:02" text="@codex 把帮助中心依赖升级到 Next 15，跑通测试" />
        <PreviewMessage
          name="codex"
          agent
          time="14:02"
          text="已认领，开始执行。"
        />
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex items-center justify-between">
            <div className="text-xs font-medium text-zinc-800">升级帮助中心到 Next 15</div>
            <span className="rounded-full border border-amber-300 bg-amber-50 px-2 py-0.5 font-mono text-[11px] text-amber-700">
              进行中
            </span>
          </div>
          <div className="mt-1.5 font-mono text-[11px] text-zinc-500">offer → claim · codex</div>
        </div>
        <PreviewMessage
          name="codex"
          agent
          time="14:26"
          text="完成。变更已打包提交审核。"
        />
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-zinc-800">Output Package · 3 个文件</div>
              <div className="mt-1 font-mono text-[11px] text-zinc-500">package.json / next.config.mjs / CHANGELOG.md</div>
            </div>
            <div className="flex shrink-0 gap-1.5">
              <span className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600">
                <Check size={12} /> 接受
              </span>
              <span className="flex items-center gap-1 rounded-md border border-zinc-300 bg-white px-2 py-1 text-[11px] text-zinc-600">
                <X size={12} /> 打回
              </span>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function PreviewMessage({
  name,
  time,
  text,
  agent = false,
}: {
  name: string;
  time: string;
  text: string;
  agent?: boolean;
}) {
  return (
    <div className="flex gap-2.5">
      <div
        className={`mt-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded-md font-mono text-[11px] ${
          agent ? 'bg-amber-100 text-amber-700' : 'bg-zinc-100 text-zinc-600'
        }`}
      >
        {agent ? 'AI' : name.slice(0, 2).toUpperCase()}
      </div>
      <div className="min-w-0">
        <div className="flex items-baseline gap-2">
          <span className="text-xs font-semibold text-zinc-900">{name}</span>
          <span className="font-mono text-[10px] text-zinc-500">{time}</span>
        </div>
        <p className="mt-0.5 text-xs leading-5 text-zinc-600">{text}</p>
      </div>
    </div>
  );
}

function Principles() {
  return (
    <section className="border-y border-zinc-200 bg-zinc-50">
      <div className="mx-auto grid max-w-6xl gap-8 px-6 py-14 md:grid-cols-3 md:divide-x md:divide-zinc-200">
        {principles.map((p, i) => (
          <div key={p.title} className={i > 0 ? 'md:pl-8' : ''}>
            <h3 className="text-sm font-semibold text-zinc-900">{p.title}</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">{p.desc}</p>
          </div>
        ))}
      </div>
    </section>
  );
}

function CollabSection() {
  return (
    <section id="features" className="scroll-mt-20">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-[0.95fr_1.05fr]">
        <div className="reveal order-2 lg:order-1">
          <ThreadPreview />
        </div>
        <div className="reveal order-1 lg:order-2">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">一条时间线，装下聊天、任务和交付</h2>
          <p className="mt-4 max-w-xl leading-8 text-zinc-600">
            在频道或私聊里 @ 一个 Agent，回复和产物会回到同一条协作时间线。你不必在多个终端窗口之间切换，也不用翻聊天记录找结果。
          </p>
          <div className="mt-8 grid gap-6 sm:grid-cols-2">
            {collabPoints.map((point) => (
              <div key={point.title} className="border-l border-zinc-200 pl-4">
                <h3 className="text-sm font-semibold text-zinc-900">{point.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-zinc-600">{point.desc}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </section>
  );
}

function ThreadPreview() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white p-4 shadow-xl shadow-zinc-900/5">
      <div className="mb-4 flex items-center justify-between border-b border-zinc-200 pb-3">
        <div className="text-sm font-medium">讨论串 · 来自 #产品频道</div>
        <span className="rounded-full border border-zinc-300 px-2 py-0.5 font-mono text-[11px] text-zinc-500">
          3 条回复
        </span>
      </div>
      <div className="space-y-4">
        <PreviewMessage
          name="shaw"
          time="10:41"
          text="这周的目标：新版帮助中心上线。@hermes 先出内容大纲。"
        />
        <div className="space-y-4 border-l border-zinc-200 pl-4">
          <PreviewMessage
            name="hermes"
            agent
            time="10:48"
            text="大纲完成，共 5 节，已附上页面结构建议。"
          />
          <PreviewMessage name="shaw" time="10:52" text="结构没问题，转成任务开工。" />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2">
          <span className="text-xs text-zinc-600">已转为任务</span>
          <span className="font-mono text-[11px] text-zinc-500">task · 1057 · hermes 已认领</span>
        </div>
      </div>
    </div>
  );
}

function DagSection() {
  return (
    <section id="orchestration" className="scroll-mt-20 border-y border-zinc-200 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="reveal max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">把一件事拆给多个 Agent，人类守关键门</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            根任务由明确的触发创建，而不是每条消息自动建单。子任务按 offer 与 claim
            认领，失败有界重试；根交付必须经人接受或打回。你只在关键门上做决定。
          </p>
        </div>
        <div className="reveal mt-14">
          <DagDiagram />
        </div>
      </div>
    </section>
  );
}

function DagDiagram() {
  return (
    <div className="rounded-xl border border-zinc-200 bg-white px-6 py-10 shadow-sm">
      <div className="flex flex-col items-center">
        <DagNode label="根任务" title="上线新版帮助中心" highlighted />
        <div className="h-6 w-px bg-zinc-300" />
        <div className="grid w-full max-w-3xl gap-4 sm:grid-cols-3">
          {dagChildren.map((child) => (
            <div key={child.agent} className="flex flex-col items-center">
              <div className="hidden h-4 w-px bg-zinc-300 sm:block" />
              <DagNode label={child.agent} title={child.task} />
            </div>
          ))}
        </div>
        <div className="h-6 w-px bg-zinc-300" />
        <DagNode label="人类" title="接受 · 打回" gate />
      </div>
    </div>
  );
}

function DagNode({
  label,
  title,
  highlighted = false,
  gate = false,
}: {
  label: string;
  title: string;
  highlighted?: boolean;
  gate?: boolean;
}) {
  return (
    <div
      className={`w-full max-w-[220px] rounded-lg border px-4 py-3 text-center ${
        gate
          ? 'border-amber-300 bg-amber-50'
          : highlighted
            ? 'border-zinc-300 bg-white shadow-sm'
            : 'border-zinc-200 bg-zinc-50'
      }`}
    >
      <div className="font-mono text-[11px] text-zinc-500">{label}</div>
      <div className="mt-1 text-sm font-medium text-zinc-900">{title}</div>
    </div>
  );
}

function DeviceSection() {
  return (
    <section>
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-[1.05fr_0.95fr]">
        <div className="reveal">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">设备是常驻服务，不是一次性终端</h2>
          <p className="mt-4 max-w-xl leading-8 text-zinc-600">
            macOS 上以当前用户 LaunchAgent 常驻，无需
            sudo；多个 Team Profile 共用一个 Device Service。它负责运行时扫描、Agent
            调用、产物收集与本地记忆。终端退出，服务继续运行。
          </p>
          <div className="mt-8 font-mono text-sm text-zinc-500">
            <span className="text-zinc-800">生命周期</span>
            <span className="ml-3">install / status / logs / restart / start / stop / update</span>
          </div>
        </div>
        <div className="reveal">
          <TerminalBlock />
        </div>
      </div>
    </section>
  );
}

function TerminalBlock() {
  return (
    <div className="overflow-hidden rounded-xl border border-zinc-800 bg-zinc-900">
      <div className="border-b border-zinc-800 px-4 py-2.5 font-mono text-xs text-zinc-500">
        zsh · macOS
      </div>
      <div className="space-y-2.5 p-4 font-mono text-[13px] leading-6">
        <p className="break-all text-zinc-200">
          <span className="text-zinc-500">$</span> npm install -g @agentbean/daemon@latest
        </p>
        <p className="break-all text-zinc-200">
          <span className="text-zinc-500">$</span> agentbean device connect \
          <br />
          <span className="ml-2">--invite-code &lt;code&gt; --server-url &lt;url&gt; --profile-id &lt;profile&gt;</span>
        </p>
        <p className="text-amber-300">✓ 设备已连接，服务在后台运行</p>
      </div>
    </div>
  );
}

function BentoSection() {
  return (
    <section className="border-y border-zinc-200 bg-zinc-50">
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="reveal max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">交付有边界，经验可复用</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            生成文件不会绕过发布流程直接变成团队真相；有价值的经验沉淀成可治理的记忆，而不是把聊天记录全塞进下一次 prompt。
          </p>
        </div>
        <div className="reveal mt-12 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h3 className="text-sm font-semibold text-zinc-900">Output Package</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              冻结文件成员、包级审核、设最终版，并与任务交付联动。交付物以整包进入审核，而不是散落的截图和链接。
            </p>
            <div className="mt-5 space-y-1.5 font-mono text-xs text-zinc-500">
              {bentoCells.outputPackage.rows.map((row) => (
                <div key={row.name} className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <span className="text-zinc-700">{row.name}</span>
                  <span>{row.state}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">协作记忆</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              记忆候选可接受、拒绝、合并，带来源归因，分系统与个人作用域治理。
            </p>
            <div className="mt-5 space-y-1.5 font-mono text-xs text-zinc-500">
              {bentoCells.memory.rows.slice(0, 2).map((row) => (
                <div key={row.name} className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <span className="truncate text-zinc-700">{row.name}</span>
                  <span className="ml-3 shrink-0 text-amber-700">{row.state}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">暂存发布</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              大文件落盘暂存、断网续传、原子提交新版本，Workspace 的每次变更都有完整修订历史。
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">Experience Pack</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              把验证过的做法打包成经验，从草稿到批准，再附着到频道里复用。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function ArchSection() {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="reveal max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">谁做什么，边界写死</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            三层各持其责，共享边界很硬：跨端只依赖契约，领域规则在没有网络和数据库的情况下也能测试。
          </p>
        </div>
        <div className="reveal mt-12 divide-y divide-zinc-200">
          <div className="grid gap-2 pb-4 font-mono text-xs text-zinc-500 sm:grid-cols-[180px_1fr_1fr] sm:gap-6">
            <div>层</div>
            <div>职责</div>
            <div>明确不做</div>
          </div>
          {archRows.map((row) => (
            <div
              key={row.layer}
              className="grid gap-2 border-zinc-200 py-5 sm:grid-cols-[180px_1fr_1fr] sm:gap-6"
            >
              <div>
                <div className="text-sm font-semibold text-zinc-900">{row.layer}</div>
                <div className="mt-0.5 font-mono text-xs text-zinc-500">{row.pkg}</div>
              </div>
              <p className="text-sm leading-6 text-zinc-600">{row.duty}</p>
              <p className="text-sm leading-6 text-zinc-500">{row.wont}</p>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function QuickstartSection() {
  return (
    <section id="quickstart" className="scroll-mt-20 border-t border-zinc-200">
      <div className="mx-auto grid max-w-6xl items-center gap-14 px-6 py-24 lg:grid-cols-[1.1fr_0.9fr]">
        <div className="reveal">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">把你的 Agent 请进团队</h2>
          <div className="mt-10 space-y-8">
            {quickstartSteps.map((step) => (
              <div key={step.title} className="max-w-md border-l-2 border-zinc-300 pl-5">
                <h3 className="text-sm font-semibold text-zinc-900">{step.title}</h3>
                <p className="mt-1.5 text-sm leading-6 text-zinc-600">{step.desc}</p>
              </div>
            ))}
          </div>
        </div>
        <div className="reveal rounded-xl border border-zinc-200 bg-white p-8 shadow-sm">
          <p className="text-lg font-medium leading-8 text-zinc-900">
            项目在本地，协作在云端，
            <br />
            决定权在你。
          </p>
          <p className="mt-3 text-sm leading-6 text-zinc-600">
            免费创建团队，把已经在用的 Coding Agent 接进来。
          </p>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <Link
              href="/signup"
              className="rounded-lg bg-amber-400 px-5 py-2.5 text-sm font-semibold text-zinc-950 shadow-sm transition-colors hover:bg-amber-300 active:scale-[0.98]"
            >
              创建账号
            </Link>
            <Link
              href="/login"
              className="rounded-lg border border-zinc-300 bg-white px-5 py-2.5 text-sm font-medium text-zinc-700 transition-colors hover:border-zinc-400 hover:text-zinc-950 active:scale-[0.98]"
            >
              登录
            </Link>
          </div>
        </div>
      </div>
    </section>
  );
}

function Footer() {
  return (
    <footer className="border-t border-zinc-200">
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-6 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-2.5">
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.svg" alt="AgentBean" className="h-7 w-7 rounded-md" />
          <div>
            <div className="text-sm font-semibold">AgentBean</div>
            <div className="text-xs text-zinc-500">本地优先的人机协作团队平台</div>
          </div>
        </div>
        <div className="flex items-center gap-6 text-sm text-zinc-500">
          {navLinks.map((link) => (
            <a key={link.href} href={link.href} className="transition-colors hover:text-zinc-900">
              {link.label}
            </a>
          ))}
          <span className="text-zinc-500">© 2026 AgentBean</span>
        </div>
      </div>
    </footer>
  );
}
