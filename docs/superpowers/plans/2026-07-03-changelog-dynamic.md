# 更新日志动态化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 让设置页"更新日志"由根目录 `CHANGELOG.md` 驱动，自动按日期降序、分类可视化展示全部版本，发版时只需改 markdown。

**Architecture:** `CHANGELOG.md`（Keep a Changelog 格式）作为唯一真相源；`apps/web-next/scripts/gen-changelog.ts` 在 `predev`/`prebuild` 时调用 `lib/changelog.ts` 的 `parseChangelog` 解析为 `Release[]`，序列化为 `lib/releases.generated.ts`；settings 页 `ReleasesPanel` import 该产物并 `.map` 渲染，`ReleaseEntry` 按分类显示彩色标签，降序由解析器保证。

**Tech Stack:** Next.js 14 App Router · React 18 · TypeScript · Tailwind · vitest · tsx（均已就绪，不引入新依赖）

## Global Constraints

- **分支**：所有提交落在已建的 `feat/changelog-dynamic` 分支。
- **模块系统**：ESM（`package.json` 的 `type: module`）；Node v22+（实测 v24）。
- **测试**：vitest，`environment: node`，测试文件放 `apps/web-next/tests/*.test.ts`，命令 `npm run test`（= `vitest run`）。不写组件渲染测试（遵循现有"纯逻辑测试"约定）。
- **零新依赖**：`parseChangelog` 用正则纯手写；生成脚本用仓库已有的 `tsx`。
- **`lib/changelog.ts` 必须纯 TS**：不得 `import` 任何 Next.js/浏览器 API 或 `@/` alias，以便同时被 vitest 与 Node tsx 脚本 import。
- **CHANGELOG.md 格式**：Keep a Changelog 1.1.0；版本块标题严格为 `## [semver] - YYYY-MM-DD`；`## [Unreleased]` 块不展示。
- **文案**：中文硬编码（项目无 i18n）。
- **范围**：只改 web-next（生产前端）；legacy `apps/web` 不在本次范围。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `CHANGELOG.md`（根） | Create | 唯一真相源，Keep a Changelog 格式 |
| `apps/web-next/lib/changelog.ts` | Create | 类型（`Release`/`ReleaseSection`/`ChangeType`）+ 纯函数 `parseChangelog` |
| `apps/web-next/tests/changelog.test.ts` | Create | `parseChangelog` 的 TDD 单测 |
| `apps/web-next/scripts/gen-changelog.ts` | Create | 读 CHANGELOG.md → 解析 → 写 `releases.generated.ts` |
| `apps/web-next/lib/releases.generated.ts` | Create（脚本生成，提交） | 序列化后的 `Release[]`，前端 import |
| `apps/web-next/package.json` | Modify | 加 `predev`，`prebuild` 前置生成脚本 |
| `apps/web-next/app/[networkPath]/settings/page.tsx` | Modify | `ReleasesPanel` 改 map、`ReleaseEntry` 改分类可视化 |

---

### Task 1: `parseChangelog` 解析器（TDD 核心）

**Files:**
- Create: `apps/web-next/lib/changelog.ts`
- Test: `apps/web-next/tests/changelog.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces:
  - `type ChangeType = 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security'`
  - `interface ReleaseSection { type: ChangeType; items: string[] }`
  - `interface Release { version: string; date: string; sections: ReleaseSection[] }`
  - `function parseChangelog(md: string): Release[]`（返回值按 `date` 降序；空分类已过滤；重复版本号保留最后一块）

- [ ] **Step 1: 写失败测试**

Create `apps/web-next/tests/changelog.test.ts`：

```ts
import { describe, expect, test } from 'vitest';
import { parseChangelog } from '../lib/changelog';

const SAMPLE = `# Changelog

本文件记录产品变更。说明段落应被忽略。

## [Unreleased]
### Added
- 未发布的实验条目，不应出现

## [0.3.0] - 2026-07-10
### Added
- 功能 C
### Fixed
- 修复 C

## [0.1.0] - 2026-05-05
### Added
- 初始版本

## [0.2.0] - 2026-06-01
### Added
- 功能 B
### Removed
- 移除旧接口
`;

describe('parseChangelog', () => {
  test('解析出全部版本并按日期降序', () => {
    const r = parseChangelog(SAMPLE);
    expect(r.map((x) => x.version)).toEqual(['0.3.0', '0.2.0', '0.1.0']);
    expect(r[0].date).toBe('2026-07-10');
    expect(r[r.length - 1].date).toBe('2026-05-05');
  });

  test('Unreleased 块被跳过', () => {
    const r = parseChangelog(SAMPLE);
    expect(r.find((x) => x.sections.some((s) => s.items.includes('未发布的实验条目，不应出现')))).toBeUndefined();
  });

  test('分类与条目正确归属对应版本', () => {
    const r = parseChangelog(SAMPLE);
    const v03 = r.find((x) => x.version === '0.3.0')!;
    expect(v03.sections.map((s) => s.type)).toEqual(['Added', 'Fixed']);
    expect(v03.sections.find((s) => s.type === 'Added')!.items).toEqual(['功能 C']);
  });

  test('空分类被过滤（items 为空的不出现）', () => {
    const md = `## [0.1.0] - 2026-05-05
### Added
- 一条
### Fixed
`;
    const r = parseChangelog(md);
    expect(r[0].sections.map((s) => s.type)).toEqual(['Added']);
  });

  test('version 不含前导 v', () => {
    const r = parseChangelog('## [0.2.0] - 2026-06-01\n### Added\n- x\n');
    expect(r[0].version).toBe('0.2.0');
  });

  test('格式不合规的行不抛异常', () => {
    expect(() => parseChangelog('乱七八糟\n## 不是版本\n### 不是分类\n')).not.toThrow();
  });

  test('重复版本号保留最后一块', () => {
    const md = `## [0.1.0] - 2026-05-05
### Added
- 旧
## [0.1.0] - 2026-05-05
### Added
- 新
`;
    const v = parseChangelog(md).find((x) => x.version === '0.1.0')!;
    expect(v.sections[0].items).toEqual(['新']);
  });

  test('空字符串返回空数组', () => {
    expect(parseChangelog('')).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/changelog.test.ts`
Expected: FAIL（`Cannot find module '../lib/changelog'`）

- [ ] **Step 3: 写最小实现**

Create `apps/web-next/lib/changelog.ts`：

```ts
// 纯 TS 模块：不得 import 任何 Next.js / 浏览器 API 或 @/ alias，
// 以便同时被 vitest 与 Node tsx 脚本（scripts/gen-changelog.ts）import。

export type ChangeType =
  | 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security';

export interface ReleaseSection {
  type: ChangeType;
  items: string[];
}

export interface Release {
  version: string;   // 不含前导 v，如 "0.2.0"
  date: string;      // YYYY-MM-DD
  sections: ReleaseSection[];
}

const VERSION_RE = /^##\s*\[([^\]]+)\]\s*-\s*(\d{4}-\d{2}-\d{2})\s*$/;
const SECTION_RE = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security)\s*$/;
const ITEM_RE = /^\s*[-*]\s+(.+?)\s*$/;
const UNRELEASED_RE = /^##\s*\[Unreleased\]/i;

/**
 * 解析 Keep a Changelog 1.1.0 格式的字符串为 Release[]。
 * - 跳过 ## [Unreleased] 块与无日期的版本块。
 * - 过滤掉空分类（items 为空）。
 * - 重复版本号保留最后一块。
 * - 返回值按 date 降序排列。
 * - 对格式不合规的行静默跳过，不抛异常。
 */
export function parseChangelog(md: string): Release[] {
  const lines = md.split('\n');
  const byVersion = new Map<string, Release>();
  let current: Release | null = null;
  let currentSection: ReleaseSection | null = null;

  for (const line of lines) {
    if (UNRELEASED_RE.test(line)) {
      current = null;
      currentSection = null;
      continue;
    }
    const vm = VERSION_RE.exec(line);
    if (vm) {
      current = { version: vm[1].trim(), date: vm[2].trim(), sections: [] };
      byVersion.set(current.version, current); // 重复版本号覆盖 → 保留最后
      currentSection = null;
      continue;
    }
    if (!current) continue;
    const sm = SECTION_RE.exec(line);
    if (sm) {
      currentSection = { type: sm[1] as ChangeType, items: [] };
      current.sections.push(currentSection);
      continue;
    }
    if (!currentSection) continue;
    const im = ITEM_RE.exec(line);
    if (im) currentSection.items.push(im[1].trim());
  }

  return Array.from(byVersion.values())
    .map((r) => ({ ...r, sections: r.sections.filter((s) => s.items.length > 0) }))
    .sort((a, b) => b.date.localeCompare(a.date));
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/changelog.test.ts`
Expected: PASS（8 个 test 全过）

- [ ] **Step 5: 提交**

```bash
git add apps/web-next/lib/changelog.ts apps/web-next/tests/changelog.test.ts
git commit -m "feat(web-next): 新增 changelog 解析器 parseChangelog" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `CHANGELOG.md` 数据源

**Files:**
- Create: `CHANGELOG.md`（仓库根目录）

**Interfaces:**
- Consumes: 无
- Produces: 真实的 `CHANGELOG.md` 文件，供 Task 3 的脚本读取

- [ ] **Step 1: 创建 CHANGELOG.md**

Create `CHANGELOG.md`（根目录）：

```markdown
# Changelog

本文件记录 AgentBean 产品的版本变更，遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/) 规范。

## [Unreleased]

## [0.2.0] - 2026-07-03
### Added
- 更新日志页动态化：版本记录改为由 CHANGELOG.md 驱动，自动按时间倒序展示，并区分新增/修复等分类。
### Fixed
- 修复已删除设备用旧凭证复活的问题。

## [0.1.0] - 2026-05-05
### Added
- 初始版本，支持 Agent 管理、设备管理、聊天和任务看板。
```

- [ ] **Step 2: 提交**

```bash
git add CHANGELOG.md
git commit -m "docs: 新增根目录 CHANGELOG.md（Keep a Changelog 格式）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: 代码生成脚本 + `predev`/`prebuild` 钩子

**Files:**
- Create: `apps/web-next/scripts/gen-changelog.ts`
- Create: `apps/web-next/lib/releases.generated.ts`（由脚本生成）
- Modify: `apps/web-next/package.json`（`scripts` 段）

**Interfaces:**
- Consumes: `parseChangelog`（来自 Task 1）、`CHANGELOG.md`（来自 Task 2）
- Produces: `releases.generated.ts`，其默认导出 `export const releases: Release[]`，供 Task 4 的 `ReleasesPanel` import

- [ ] **Step 1: 创建生成脚本**

Create `apps/web-next/scripts/gen-changelog.ts`：

```ts
// 读取仓库根 CHANGELOG.md，解析为 Release[]，序列化为 lib/releases.generated.ts。
// 由 web-next 的 predev / prebuild 钩子调用，用 tsx 运行。
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseChangelog } from '../lib/changelog';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.join(__dirname, '..', '..', '..'); // apps/web-next/scripts → 仓库根
const changelogPath = path.join(repoRoot, 'CHANGELOG.md');
const outPath = path.join(__dirname, '..', 'lib', 'releases.generated.ts');

const md = fs.readFileSync(changelogPath, 'utf8');
const releases = parseChangelog(md);

const header =
  '// AUTO-GENERATED from CHANGELOG.md by scripts/gen-changelog.ts — do not edit.\n' +
  "import type { Release } from './changelog';\n" +
  'export const releases: Release[] = ';
fs.writeFileSync(outPath, header + JSON.stringify(releases, null, 2) + ';\n');

console.log(`[gen-changelog] wrote ${releases.length} releases → ${path.relative(repoRoot, outPath)}`);
```

- [ ] **Step 2: 跑脚本生成产物**

Run: `cd /Users/shaw/AgentBean/apps/web-next && ../../node_modules/.bin/tsx scripts/gen-changelog.ts`
Expected: 输出 `[gen-changelog] wrote 2 releases → apps/web-next/lib/releases.generated.ts`，且 `lib/releases.generated.ts` 已生成，内容为 2 条 Release（0.2.0、0.1.0）。

- [ ] **Step 3: 人工核对生成产物**

打开 `apps/web-next/lib/releases.generated.ts`，确认：
- 顶部有 `// AUTO-GENERATED` 注释与 `import type { Release }`。
- `releases` 数组第一条是 `0.2.0`（date 2026-07-03），第二条是 `0.1.0`（date 2026-05-05）。
- 每条 `sections` 只含非空分类。

- [ ] **Step 4: 接入 `predev` 与 `prebuild` 钩子**

Modify `apps/web-next/package.json` 的 `scripts` 段，把：

```json
"build": "npm run build:client && npm run build:app",
"dev": "next dev -p 4101",
"prebuild": "tsc -p ../../packages/contracts/tsconfig.json",
```

改为：

```json
"build": "npm run build:client && npm run build:app",
"dev": "next dev -p 4101",
"predev": "tsx scripts/gen-changelog.ts",
"prebuild": "tsx scripts/gen-changelog.ts && tsc -p ../../packages/contracts/tsconfig.json",
```

> npm 会在 `npm run dev` / `npm run build` 前自动执行同名 `pre*` 脚本；`tsx` 由根 `node_modules/.bin` 提供（npm scripts PATH 自动包含）。

- [ ] **Step 5: 验证钩子生效**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run predev`
Expected: 输出 `[gen-changelog] wrote 2 releases → apps/web-next/lib/releases.generated.ts`（与 Step 2 一致）。

- [ ] **Step 6: 提交（含生成产物）**

```bash
git add apps/web-next/scripts/gen-changelog.ts apps/web-next/lib/releases.generated.ts apps/web-next/package.json
git commit -m "feat(web-next): 新增 changelog 生成脚本与 predev/prebuild 钩子" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: 设置页 UI 重构（分类可视化）

**Files:**
- Modify: `apps/web-next/app/[networkPath]/settings/page.tsx`（顶部 import 区、`ReleasesPanel` 637-648、`ReleaseEntry` 650-664）

**Interfaces:**
- Consumes: `releases`（来自 `@/lib/releases.generated`）、`Release`/`ChangeType` 类型（来自 `@/lib/changelog`）
- Produces: 动态、降序、分类可视化的"更新日志"面板

- [ ] **Step 1: 在 import 区追加数据与类型引入**

在 `apps/web-next/app/[networkPath]/settings/page.tsx` 第 17 行（`} from '@/lib/browser-settings';`）之后插入两行：

```ts
import { releases } from '@/lib/releases.generated';
import type { Release, ChangeType } from '@/lib/changelog';
```

- [ ] **Step 2: 重写 `ReleasesPanel`（637-648 行）**

把原 `ReleasesPanel` 函数整体替换为：

```tsx
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

- [ ] **Step 3: 重写 `ReleaseEntry`（650-664 行）为分类可视化**

把原 `ReleaseEntry` 函数（含 `SECTION_STYLE`）整体替换为：

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
  const sections = release.sections.filter((s) => s.items.length > 0);
  return (
    <div>
      <div className="flex items-center gap-2">
        <span className="text-sm font-semibold">v{release.version}</span>
        <span className="text-xs text-neutral-400">{release.date}</span>
      </div>
      <div className="mt-1.5 space-y-2 pl-2">
        {sections.map((s) => (
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

- [ ] **Step 4: 类型检查与构建**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run build`
Expected: 构建成功（`prebuild` 会先跑生成脚本，再 `tsc` 类型检查 + `next build`）。若报 `Cannot find module '@/lib/releases.generated'`，确认 Task 3 已生成该文件且 tsconfig `paths` 含 `@/*`。

- [ ] **Step 5: 手动冒烟验证**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run dev`
打开 `http://localhost:4101/<任意 networkPath>/settings` → 切到"更新日志" Tab，确认：
- 显示两条版本：`v0.2.0`（2026-07-03）在上，`v0.1.0`（2026-05-05）在下。
- v0.2.0 下有绿色"新增"标签（1 条）+ 橙色"修复"标签（1 条）。
- v0.1.0 下有绿色"新增"标签（1 条）。
- 验证后 Ctrl+C 停止 dev server。

- [ ] **Step 6: 提交**

```bash
git add apps/web-next/app/[networkPath]/settings/page.tsx
git commit -m "feat(web-next): 更新日志页改为 CHANGELOG 驱动的分类可视化" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

## 收尾（实现完成后）

- 跑全量 web-next 测试回归：`cd /Users/shaw/AgentBean/apps/web-next && npm run test`（确保无回归）。
- 推送分支并发 PR：`git push -u origin feat/changelog-dynamic`，PR 标题 `feat: 更新日志动态化（CHANGELOG.md 驱动）`，正文链接 spec 与本 plan。
- 合并后，在仓库根 `CHANGELOG.md` 顶部按 `## [x.y.z] - YYYY-MM-DD` 追加新版本块即可让设置页自动更新（开发时 `predev` 自动重生；线上随 web build 同步）。

## 范围外（YAGNI）

- legacy `apps/web/app/[teamPath]/settings/page.tsx` 的同名硬编码不同步（web-next 为生产前端；如需 rollback 一致性，另开任务）。
- i18n、绑定 package.json version、后端 API、自动从 git commit 生成 changelog。
