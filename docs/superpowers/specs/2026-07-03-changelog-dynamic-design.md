# 更新日志动态化设计

- **日期**：2026-07-03
- **状态**：设计稿（待用户复审）
- **关联页面**：`https://www.agentbean.dev/{teamPath}/settings` → 更新日志 Tab

## 1. 背景

设置页的"更新日志"目前只展示 `v0.1.0` 一条记录，且版本数据是硬编码在 JSX 字面量里的（`apps/web-next/app/[teamPath]/settings/page.tsx:643`）：

```tsx
<ReleaseEntry version="v0.1.0" date="2026-05-05" notes={['初始版本，支持 Agent 管理、设备管理、聊天和任务看板。']} />
```

用户希望：每次版本更新都能自动展示在更新日志中，按降序排列（最新在最上面），无需手改前端代码。

## 2. 现状分析

经全仓探查，确认以下事实：

| 维度 | 现状 |
|---|---|
| 版本数据 | 100% 硬编码 JSX 字面量，无 props/API/常量注入 |
| 数据源 | 无 `CHANGELOG.md`、无 `changelog.json`、无版本常量文件 |
| 后端 API | 无。server-next 为纯 WebSocket，无 `/version`、`/changelog` 路由 |
| git tag | 仅有 `m1`、`m3` 两个 milestone tag，无 semver tag，无 `v0.1.0` tag |
| package.json version | `web-next=0.0.0`、`apps/web=0.0.1`、`server-next=0.0.0`、`daemon-next=0.2.6`，与 UI 展示的 `v0.1.0` 完全脱节 |
| i18n | 无 i18n 框架，"更新日志"为硬编码中文字面量 |
| 现有组件 | `ReleaseEntry`（650-664 行）已支持 `{version, date, notes: string[]}` 任意条数，UI 结构无需大改 |
| server/client 边界 | `page.tsx` 第 1 行 `'use client'`，整个文件（含 `ReleasesPanel`、`ReleaseEntry`）为 client component，**不能使用 Node `fs`** |

关键结论：当前 `v0.1.0` 是个"孤儿字符串"——不来自 package.json、不来自 git tag，纯粹是手敲进 JSX 的。项目从未建立过版本号真相源。本设计的核心是**建立一个可维护的数据源 + 发版时的更新流程**。

## 3. 目标与非目标

### 目标
1. 建立唯一的版本日志真相源（`CHANGELOG.md`），发版时更新该文件即可驱动设置页展示。
2. 设置页"更新日志"自动渲染全部版本，按日期降序（最新在上）。
3. 充分利用 Keep a Changelog 分类语义，UI 上分类可视化。
4. 改动最小、风险最低，不破坏现有 settings 页结构与 server/client 边界。

### 非目标（YAGNI）
- 不做 i18n（项目无框架，沿用中文硬编码）。
- 不绑定 package.json version（脱节现状接受，统一版本号策略超出本需求范围）。
- 不新增后端 API（更新日志内容与前端 build 同步，走 WebSocket 不划算）。
- 不自动从 git commit 生成 changelog（无 conventional-commits 规范，人工撰写更准确）。
- 不回填 git 历史版本（`m1`/`m3` milestone 信息不足，只保留 v0.1.0）。

## 4. 设计决策

| 决策点 | 选定 | 理由 |
|---|---|---|
| 数据源 | `CHANGELOG.md`（根目录） | 单一真相源；符合社区惯例；非前端贡献者也可直接编辑 markdown；未来可被工具链消费 |
| 格式规范 | Keep a Changelog 1.1.0 | 国际标准；分类语义清晰；工具链兼容性好 |
| 位置 / 版本语义 | 根目录 / 产品级版本号 | 更新日志面向终端用户，代表 AgentBean 产品发布，与各 npm 包 version 解耦 |
| UI 展示 | 分类可视化（彩色标签） | 既然选了 Keep a Changelog 格式，分类信息应在 UI 体现，否则格式选型价值减半 |
| 数据注入 | 代码生成（方案 A） | 见 §6.4，受 `page.tsx` 为 client component 约束 |
| 排序 | 解析后按 date 降序 | 保证 CHANGELOG 写乱序时 UI 仍正确；不依赖维护者手工保持顺序 |

> 注：前 4 项为用户在 brainstorming 中确认；后 2 项为本文档基于技术约束的工程选型。

## 5. 架构与数据流

```
CHANGELOG.md (根目录, Keep a Changelog 格式)
        │
        │  build/dev 时由 scripts/gen-changelog.ts 读取
        ▼
lib/changelog.ts :: parseChangelog(md) → Release[]
        │
        │  序列化为 TS 模块
        ▼
lib/releases.generated.ts (export const releases: Release[])
        │
        │  import（build 时静态打包）
        ▼
ReleasesPanel (client component) ── .map ──▶ ReleaseEntry (分类可视化渲染)
```

数据流向是单向的、build 时确定的：CHANGELOG.md 改动 → 跑生成脚本 → 重新 build/deploy web-next → UI 更新。运行时无文件读取、无网络请求。

## 6. 详细设计

### 6.1 `CHANGELOG.md`（新建，根目录）

遵循 Keep a Changelog 1.1.0 + semver。初始内容：

```markdown
# Changelog

本文件记录 AgentBean 产品的版本变更。

## [0.2.0] - 2026-07-03
### Added
- 更新日志页动态化：版本记录改为由 CHANGELOG.md 驱动，自动按时间倒序展示。
### Fixed
- 修复已删除设备用旧凭证复活的问题。

## [0.1.0] - 2026-05-05
### Added
- 初始版本，支持 Agent 管理、设备管理、聊天和任务看板。
```

> 0.2.0 条目为本期交付的示范条目；上线时其内容应如实反映本期 + 同期已合并的变更。维护约定：每次发版在文件顶部追加新版本块。

### 6.2 数据结构（`apps/web-next/lib/changelog.ts`）

```ts
export type ChangeType =
  | 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';

export interface ReleaseSection {
  type: ChangeType;
  items: string[];
}

export interface Release {
  version: string;      // 如 "0.2.0"（不含前导 v，展示时再加）
  date: string;         // ISO 格式 YYYY-MM-DD
  sections: ReleaseSection[];
}
```

### 6.3 解析层（`apps/web-next/lib/changelog.ts`）

纯函数，零外部依赖：

```ts
export function parseChangelog(md: string): Release[] {
  // 1. 按 /^## \[(.+?)\] - (\d{4}-\d{2}-\d{2})$/ 切版本块
  // 2. 版本块内按 /^### (Added|Changed|Deprecated|Removed|Fixed|Security)$/ 切分类
  // 3. 分类内收集 /^\s*[-*]\s+(.+)$/ 行为 items
  // 4. 跳过文件头部的标题/说明段落、## [Unreleased] 块（无日期）
  // 5. 解析后按 date 降序排序后返回
}
```

边界处理：
- `## [Unreleased]` 块（无日期）跳过，不展示。
- 空分类（`### Added` 下无条目）产出空 `items: []`，UI 不渲染。
- 格式不合规的行静默跳过，不抛异常（解析器宽容）。
- 同版本号重复时保留最后一块。

### 6.4 数据注入方案对比与选型

**约束**：`page.tsx` 顶部 `'use client'`（第 1 行），整个模块为 client component，不能使用 Node `fs`。

| 方案 | 做法 | 优 | 劣 |
|---|---|---|---|
| **A. 代码生成（选定）** | `scripts/gen-changelog.ts` 读 `CHANGELOG.md` → `parseChangelog` → 写 `lib/releases.generated.ts`；挂到 web-next `package.json` 的 `predev`/`prebuild` | 不动 server/client 结构；零运行时开销；改动最小；解析确定性可复现 | 多一个脚本步骤；生成文件需提交/gitignore 取舍 |
| B. 拆 server/client | 新建 server 组件 `fs.readFileSync` + 解析，把 `releases` 作 prop 传给 client `ReleasesPanel` | 符合 App Router 本意；无生成文件 | `page.tsx` 4 个 panel 全在 client 文件，边界重构改动大、回归风险高 |
| C. raw import + 客户端解析 | 配置 `next.config` 把 `.md` 当 raw 字符串 import，组件内 `parseChangelog` | 无脚本、无 server/client 拆分 | 需改 Next.js webpack/turbopack raw loader 配置；解析跑在客户端（虽开销极小） |

**选 A 的理由**：改动最小、回归面最小、与现有 client 架构完全兼容。`releases.generated.ts` **提交到 git**：其内容完全源自 `CHANGELOG.md`，生成是确定性的；提交可避免 CI 增加额外步骤，也便于 code review 时直接看到数据变化。`predev`/`prebuild` 钩子保证本地开发时 CHANGELOG 改动能即时反映。

`scripts/gen-changelog.ts`（根目录，便于复用）伪代码：

```ts
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../apps/web-next/lib/changelog';

// ESM 下无 __dirname，用 import.meta.url 推导
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(__dirname, '..');

const md = fs.readFileSync(path.join(root, 'CHANGELOG.md'), 'utf8');
const releases = parseChangelog(md);
const out = `// AUTO-GENERATED from CHANGELOG.md — do not edit.\nimport type { Release } from './changelog';\nexport const releases: Release[] = ${JSON.stringify(releases, null, 2)};\n`;
fs.writeFileSync(path.join(root, 'apps/web-next/lib/releases.generated.ts'), out);
```

实现注意：
- 脚本用项目既有的 TS 运行方式执行（如 `tsx`；web-next `package.json` 的 `predev`/`prebuild` 写成 `tsx ../../scripts/gen-changelog.ts && <原命令>`，具体相对路径以 web-next cwd 为准）。
- `changelog.ts` 须保持为纯 TS（无浏览器/Next.js 特有 API），以便同时被 Node 脚本和前端 import。

### 6.5 UI 重构（`ReleaseEntry` 升级）

**变更前**：`ReleaseEntry({ version, date, notes: string[] })` —— 扁平列表。

**变更后**：`ReleaseEntry({ release }: { release: Release })` —— 分类可视化。

```tsx
const SECTION_STYLE: Record<ChangeType, { label: string; badge: string }> = {
  Added:      { label: '新增', badge: 'bg-green-100 text-green-700' },
  Changed:    { label: '变更', badge: 'bg-blue-100 text-blue-700' },
  Deprecated: { label: '弃用', badge: 'bg-yellow-100 text-yellow-700' },
  Removed:    { label: '移除', badge: 'bg-red-100 text-red-700' },
  Fixed:      { label: '修复', badge: 'bg-orange-100 text-orange-700' },
  Security:   { label: '安全', badge: 'bg-purple-100 text-purple-700' },
};

function ReleaseEntry({ release }: { release: Release }) {
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">v{release.version}</span>
        <span className="text-xs text-neutral-400">{release.date}</span>
      </div>
      <div className="mt-1.5 space-y-2 pl-2">
        {release.sections
          .filter((s) => s.items.length > 0)
          .map((s) => (
            <div key={s.type}>
              <span className={`inline-block rounded px-1.5 py-0.5 text-xs font-medium ${SECTION_STYLE[s.type].badge}`}>
                {SECTION_STYLE[s.type].label}
              </span>
              <ul className="mt-1 space-y-1 pl-4">
                {s.items.map((n, i) => (
                  <li key={i} className="text-sm text-neutral-600 list-disc">{n}</li>
                ))}
              </ul>
            </div>
          ))}
      </div>
    </div>
  );
}
```

**`ReleasesPanel` 变更**：

```tsx
import { releases } from '@/lib/releases.generated';

function ReleasesPanel() {
  return (
    <div className="mx-auto max-w-xl space-y-6">
      <h2 className="text-xl font-semibold">更新日志</h2>
      <section className="rounded-lg border border-neutral-200 p-5">
        <div className="space-y-4">
          {releases.map((r) => (
            <ReleaseEntry key={r.version} release={r} />
          ))}
        </div>
      </section>
    </div>
  );
}
```

降序由 `parseChangelog` 的排序保证，UI 层直接按数组顺序渲染。

## 7. 测试策略

- **解析层单测**（`lib/changelog.test.ts`）：
  - 标准格式解析正确（多版本、多分类、多条目）。
  - `## [Unreleased]` 块被跳过。
  - 空分类不出现在结果中（或 items 为空）。
  - 降序排序：输入乱序版本块，断言输出按 date 降序。
  - 容错：格式不合规的行不抛异常。
  - 同版本号重复：保留最后一块。
- **生成脚本**：跑 `gen-changelog.ts` 后断言 `releases.generated.ts` 内容与 `parseChangelog(CHANGELOG.md)` 一致。
- **UI 冒烟**：`ReleasesPanel` 渲染给定 fixture `releases`，断言版本号、日期、分类标签、条目文本均出现；空分类不渲染。

## 8. 实现步骤概要

（详细 task 拆分交给 writing-plans）

1. 新建根目录 `CHANGELOG.md`（含 0.1.0 + 0.2.0 两块）。
2. 新建 `apps/web-next/lib/changelog.ts`（类型 + `parseChangelog` + 单测）。
3. 新建 `scripts/gen-changelog.ts`，挂到 web-next `package.json` 的 `predev`/`prebuild`。
4. 生成 `apps/web-next/lib/releases.generated.ts` 并提交。
5. 重构 `ReleaseEntry` 为分类可视化，`ReleasesPanel` 改为 map `releases`。
6. UI 冒烟测试。
7. Release A 仍按现有 CI 验证旧 Web；Release B 退役旧源码后不再同步该实现。

## 9. 风险与回退

- **风险**：维护者改了 `CHANGELOG.md` 忘记跑生成脚本 → `releases.generated.ts` 陈旧。
  - 缓解：`predev`/`prebuild` 自动跑；CI 可加一步"生成结果与已提交文件一致"的校验。
- **风险**：Keep a Changelog 格式被人误写（如日期格式错）→ 解析器容错跳过。
  - 缓解：解析器单测覆盖边界；CI 校验生成结果。
- **回退**：方案 A 完全增量，出问题时回滚到硬编码 `ReleaseEntry` 即可，不影响其他面板。
