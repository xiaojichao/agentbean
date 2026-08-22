import type { Metadata } from 'next';
import Link from 'next/link';
import { Check, X } from 'lucide-react';

export const metadata: Metadata = {
  metadataBase: new URL('https://agentbean.dev'),
  title: 'AgentBean：和你的 AI 同事，在一个团队里干活',
  description:
    '给「人类 + AI」一起用的团队工作台：在网页里说需求、@ 你的 AI、收文件、点一下审核。项目文件和 AI 的每一步操作，始终留在你自己的电脑上。',
  openGraph: {
    title: '和你的 AI 同事，在一个团队里干活',
    description:
      '把你的 AI 请进同一个团队：说需求、派任务、收文件，在网页里一键审核。项目始终在你自己的电脑上。',
    type: 'website',
    locale: 'zh_CN',
    siteName: 'AgentBean',
  },
  twitter: {
    card: 'summary_large_image',
    title: '和你的 AI 同事，在一个团队里干活',
    description: '把你的 AI 请进同一个团队：说需求、派任务、收文件，在网页里一键审核。',
  },
};

const navLinks = [
  { href: '#features', label: '功能' },
  { href: '#orchestration', label: '分工' },
  { href: '#quickstart', label: '快速开始' },
];

const principles = [
  {
    title: '活在你电脑上干',
    desc: '项目文件和 AI 的每一步操作都留在你的设备上，云端只负责协作和同步该同步的。',
  },
  {
    title: '你点头才算完',
    desc: '重要成果要你亲自接受或打回，AI 不会悄悄定稿，也不会把闲聊变成一堆工单。',
  },
  {
    title: 'AI 执行，人做决定',
    desc: '内置的项目经理只帮你拆任务、找合适的 AI；真正干活和拍板的，都是你指定的。',
  },
];

const collabPoints = [
  { title: '@ 一下就派活', desc: '在频道或私聊里 @ 你的 AI，它接到任务就开始做。' },
  { title: '消息变任务', desc: '复杂的事变成任务：谁来做、做到哪了、最后谁点头，一目了然。' },
  { title: '讨论串', desc: '在一句话下面展开讨论，上下文和附件都留在原地，不用翻记录。' },
  { title: '你来验收', desc: '做好的文件点开预览，接受或打回，不是改完就结束。' },
];

const dagChildren = [
  { agent: 'Codex', task: '升级依赖并修复测试' },
  { agent: 'Hermes', task: '更新部署文档' },
  { agent: '审查 Agent', task: '核对变更与文档一致' },
];

const bentoCells = {
  delivery: {
    rows: [
      { name: 'package.json', state: '已锁定' },
      { name: 'next.config.mjs', state: '已锁定' },
      { name: 'CHANGELOG.md', state: '已锁定' },
    ],
  },
  memory: {
    rows: [
      { name: '部署走 Railway 而不是 Vercel', state: '接受' },
      { name: '测试先跑全量再提 PR', state: '接受' },
    ],
  },
};

const dataRows = [
  {
    layer: '网页',
    pkg: '团队工作台',
    duty: '频道、任务、文件、设备，都在一个页面里。',
    wont: '只是窗口，不做主：权限和任务真相不在这里。',
  },
  {
    layer: '服务器',
    pkg: '团队协作中枢',
    duty: '保存团队聊天、任务记录、成员和权限。',
    wont: '不碰你电脑里的项目文件。',
  },
  {
    layer: '你的电脑',
    pkg: 'AI 的工作间',
    duty: 'AI 在这里干活，文件和每一步操作都留在本机。',
    wont: '不用一直开着网页，合上笔记本服务还在。',
  },
];

const quickstartSteps = [
  {
    title: '注册建团队',
    desc: '在网页里创建团队，拿到一条设备连接命令。',
  },
  {
    title: '连接你的 Mac',
    desc: '复制命令，在终端里运行一次，这台电脑就常驻团队。',
  },
  {
    title: '@ 它，派第一件活',
    desc: '在频道里 @ 你的 AI，等它交回成果，你来验收。',
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
        <DataSection />
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
          Claude、ChatGPT 很能干，但各干各的：一个在浏览器，一个在终端，文件散落各处。AgentBean
          把它们请进同一个团队：网页里说需求、@ 你的 AI、收文件、点一下审核。项目始终在你自己的电脑上。
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
          #产品频道 <span className="ml-2 font-mono text-xs text-zinc-500">4 人 · 3 个 AI</span>
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
          <div className="mt-1.5 font-mono text-[11px] text-zinc-500">已认领 · codex</div>
        </div>
        <PreviewMessage
          name="codex"
          agent
          time="14:26"
          text="完成。改动文件已打包，等你审核。"
        />
        <div className="rounded-lg border border-zinc-200 bg-zinc-50 p-3">
          <div className="flex items-center justify-between gap-3">
            <div>
              <div className="text-xs font-medium text-zinc-800">交付包 · 3 个文件</div>
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
            在频道里说需求，@ 一个 AI，它就开始干活。回复和文件回到同一个页面：你不用在浏览器和终端之间来回切，也不用翻聊天记录找结果。
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
            text="大纲完成，共 5 节，附上了页面结构建议。"
          />
          <PreviewMessage name="shaw" time="10:52" text="结构没问题，转成任务开工。" />
        </div>
        <div className="flex items-center gap-2 rounded-lg border border-dashed border-zinc-300 px-3 py-2">
          <span className="text-xs text-zinc-600">已转为任务</span>
          <span className="font-mono text-[11px] text-zinc-500">任务 1057 · hermes 已认领</span>
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
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">一件大事，几个 AI 分头做</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            复杂的工作不用来回发消息。AgentBean
            帮你拆成几份，交给合适的 AI：一个改代码，一个写文档，一个做检查。谁在做、做到哪了，任务列表里看得见。最后交到你面前的，是一整份可以验收的成果。
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
        <DagNode label="目标" title="上线新版帮助中心" highlighted />
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
        <DagNode label="你" title="接受 · 打回" gate />
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
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">你的 Mac，就是 AI 的工作间</h2>
          <p className="mt-4 max-w-xl leading-8 text-zinc-600">
            在网页里点「添加设备」，把命令复制到 Mac 上运行一次，这台电脑就成为团队的常驻工作设备：AI
            在它上面干活，文件从它交回团队。合上笔记本，服务还在；明天打开网页，一切照旧。
          </p>
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
        终端 · 复制运行
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
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">交回来的成果，清清楚楚</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            AI 交出的文件不会散落在聊天记录里，而是整包进入项目：看版本、做预览、标最终版。好用的经验也能存下来，下次协作不用从零解释。
          </p>
        </div>
        <div className="reveal mt-12 grid gap-4 lg:grid-cols-3">
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm lg:col-span-2">
            <h3 className="text-sm font-semibold text-zinc-900">交付包</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              AI 交上来的文件打包成一份，一次看完、一次审核。满意就标成最终版，之后大家都用这一版。
            </p>
            <div className="mt-5 space-y-1.5 font-mono text-xs text-zinc-500">
              {bentoCells.delivery.rows.map((row) => (
                <div key={row.name} className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <span className="text-zinc-700">{row.name}</span>
                  <span>{row.state}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">团队记忆</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              哪些做法有效、哪些约定要遵守，沉淀成团队记忆，下次带着上下文开工。
            </p>
            <div className="mt-5 space-y-1.5 font-mono text-xs text-zinc-500">
              {bentoCells.memory.rows.map((row) => (
                <div key={row.name} className="flex items-center justify-between rounded-md border border-zinc-200 bg-zinc-50 px-3 py-2">
                  <span className="truncate text-zinc-700">{row.name}</span>
                  <span className="ml-3 shrink-0 text-amber-700">{row.state}</span>
                </div>
              ))}
            </div>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">随时回看</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              每次修改都有版本记录，大文件也能稳稳传输，随时回到任何一版。
            </p>
          </div>
          <div className="rounded-xl border border-zinc-200 bg-white p-6 shadow-sm">
            <h3 className="text-sm font-semibold text-zinc-900">经验复用</h3>
            <p className="mt-2 text-sm leading-6 text-zinc-600">
              验证过的好做法打包复用，挂在频道里，新任务直接受益。
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}

function DataSection() {
  return (
    <section>
      <div className="mx-auto max-w-6xl px-6 py-24">
        <div className="reveal max-w-2xl">
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">你的东西放在哪，清清楚楚</h2>
          <p className="mt-4 leading-8 text-zinc-600">
            AgentBean 分三层工作：你看到的网页、记录团队协作的服务器、以及你自己的电脑。项目文件和
            AI 的操作，都在你的电脑上。
          </p>
        </div>
        <div className="reveal mt-12 divide-y divide-zinc-200">
          <div className="grid gap-2 pb-4 font-mono text-xs text-zinc-500 sm:grid-cols-[180px_1fr_1fr] sm:gap-6">
            <div>层</div>
            <div>负责什么</div>
            <div>边界</div>
          </div>
          {dataRows.map((row) => (
            <div
              key={row.layer}
              className="grid gap-2 border-zinc-200 py-5 sm:grid-cols-[180px_1fr_1fr] sm:gap-6"
            >
              <div>
                <div className="text-sm font-semibold text-zinc-900">{row.layer}</div>
                <div className="mt-0.5 text-xs text-zinc-500">{row.pkg}</div>
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
          <h2 className="text-3xl font-semibold tracking-tight text-zinc-900">三步，把 AI 请进团队</h2>
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
            免费创建团队，把已经在用的 AI 接进来。
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
            <div className="text-xs text-zinc-500">和你的 AI 同事，在一个团队里干活</div>
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
