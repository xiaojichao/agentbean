# 更新日志内容业务化 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 设置页"更新日志"（Daily Changelog）内容从 git commit subject 改为业务向用户更新：作者在 PR body 写 `## 用户向更新` 小节（`- 新功能: xxx` 行前缀），每日流水线收集人工条目，缺失的 PR 由 LLM 兜底生成同构条目；存量历史块保留、UI 兼容渲染。

**Architecture:** `CHANGELOG.md` 仍是唯一真相源。改造链：每日 cron → `scripts/update-daily-changelog.ts` 改为用 GitHub REST API（fetch + `GITHUB_TOKEN`）拉当天合并 PR → 提取人工小节条目；缺失小节的 PR 列表 POST 到 server 内部端点 `POST /api/internal/changelog-summarize`（Bearer token），Server 用内置 PI Manager 的 Active PI Model（复用 capability-summarizer 的 `resolveActiveTarget` 通道）生成兜底条目（fail-open）→ 写入 `CHANGELOG.md`（每日块改用中文三分 Section：新功能/改进/修复）→ 现有 `gen-changelog.ts` 与前端静态管线不变，`parseChangelog` 扩展识别中文 Section，`ReleaseEntry` 对中文类分组渲染、对旧英文类保留 badge 渲染。

**Tech Stack:** Next.js 14 App Router · React 18 · TypeScript · vitest · tsx · Node 24（fetch 内置，零新依赖；CI 无需 gh CLI，用 GitHub REST API；LLM 调用走 server 的 `@agentbean/pi-management-runtime` adapter，与 capability-summarizer 同通道）

**关联文档：** spec `docs/superpowers/specs/2026-08-01-user-facing-changelog-design.md`；ADR-0070

## Global Constraints

- **分支**：所有提交落在新建 `feat/user-facing-changelog` 分支（从 origin/main 起）。
- **模块系统**：ESM（`package.json` 的 `type: module`）；Node v22+（CI v24.18.0）。
- **测试**：vitest，`environment: node`，测试文件放 `apps/web-next/tests/*.test.ts`，命令 `npm run test`（= `vitest run`）。不写组件渲染测试（遵循现有"纯逻辑测试"约定）。
- **零新依赖**：GitHub REST 与 LLM 均用 Node 内置 `fetch`；解析用正则纯手写。
- **`lib/changelog.ts` 与 `lib/daily-changelog.ts` 必须纯 TS**：不得 `import` 任何 Next.js/浏览器 API 或 `@/` alias，以便同时被 vitest、Node tsx 脚本 import。
- **分类名**：中文固定为 `新功能` / `改进` / `修复`（PR 小节行前缀与 CHANGELOG Section 名一致）；占位文案 `当日无面向用户的代码变更，服务保持稳定运行。` 保留，归入"改进"组（与现状占位放 Changed 一致）。
- **LLM 兜底 fail-open**：`AGENTBEAN_CHANGELOG_LLM_BASE_URL` / `_API_KEY` / `_MODEL` 三者齐全才启用；任一缺失或调用失败 → 跳过该 PR 的兜底（不阻塞流水线）。
- **存量数据**：CHANGELOG.md 已有 Daily 块（英文 Section）与历史版本块不动；新写入的 Daily 块用中文 Section。
- **范围**：web-next（生产前端）+ 根 `scripts/` + `.github/workflows/daily-changelog.yml`；legacy `apps/web` 不在范围。

## File Structure

| 文件 | 操作 | 职责 |
|---|---|---|
| `apps/web-next/lib/changelog.ts` | Modify | `ChangeType` 扩展三个中文值；`SECTION_RE` 兼容中文 Section |
| `apps/web-next/tests/changelog.test.ts` | Modify | 中文 Section 解析用例 |
| `apps/web-next/lib/daily-changelog.ts` | Modify | 退役 `classifyDailyChange`/`normalizeDailyChangeItem`；新增 PR 小节提取 `extractUserFacingEntries`；`buildDailyReleaseSections` 改为三分组装 |
| `apps/web-next/tests/daily-changelog.test.ts` | Modify | 新解析/组装/upsert 用例，移除旧关键词分类断言 |
| `scripts/update-daily-changelog.ts` | Modify | 退役 `readCommitSubjects`；新增 GitHub PR 拉取（fetch）、小节提取、server 端点调用（fetch）、组装写入 |
| `apps/server-next/src/application/changelog-summarizer.ts` | Create | LLM 兜底模块：Active PI Model 单轮总结（仿 capability-summarizer，JSON 输出，fail-open） |
| `apps/server-next/src/application/usecases.ts` | Modify | 新增 `summarizeChangelogEntries` usecase + 依赖注入 |
| `apps/server-next/src/dev-server.ts` | Modify | 新增 `handleChangelogSummarizeHttp`（`POST /api/internal/changelog-summarize`，Bearer 鉴权） |
| `apps/server-next/tests/changelog-summarizer.test.ts` | Create | 总结器单测（mock resolveActiveTarget） |
| `.github/workflows/daily-changelog.yml` | Modify | "Update changelog source" 步骤注入 server URL/token env secrets |
| `apps/web-next/app/[teamPath]/settings/page.tsx` | Modify | `ReleaseEntry`：中文类分组渲染、英文类 badge 渲染 |
| `apps/web-next/lib/releases.generated.ts` | Regenerate | gen-changelog 重新生成（含新中文块） |
| `apps/web-next/scripts/gen-changelog.ts` | 不动 | 现有管线 |

---

### Task 1: `changelog.ts` 解析器支持中文 Section（TDD）

**Files:**
- Modify: `apps/web-next/lib/changelog.ts`
- Modify: `apps/web-next/tests/changelog.test.ts`

**Interfaces:**
- Consumes: 无（纯函数）
- Produces: `ChangeType` 增加 `'新功能' | '改进' | '修复'`；`parseChangelog` 可解析中文 Section

- [ ] **Step 1: 写失败测试**

在 `apps/web-next/tests/changelog.test.ts` 追加：

```ts
test('解析中文三分 Section（新功能/改进/修复）', () => {
  const md = `## [Daily 2026-08-01] - 2026-08-01
### 新功能
- 支持频道文件预览
### 改进
- 消息加载性能提升
### 修复
- 修复断线重连偶发失败
`;
  const r = parseChangelog(md);
  expect(r[0].sections.map((s) => s.type)).toEqual(['新功能', '改进', '修复']);
  expect(r[0].sections[0].items).toEqual(['支持频道文件预览']);
});

test('中文与英文 Section 可共存于同一文件', () => {
  const md = `## [Daily 2026-07-30] - 2026-07-30
### Added
- 旧条目
## [Daily 2026-08-01] - 2026-08-01
### 新功能
- 新条目
`;
  const r = parseChangelog(md);
  expect(r.length).toBe(2);
  expect(r[0].sections.map((s) => s.type)).toEqual(['新功能']);
  expect(r[1].sections.map((s) => s.type)).toEqual(['Added']);
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/changelog.test.ts`
Expected: FAIL（中文 Section 行被跳过）

- [ ] **Step 3: 实现**

在 `apps/web-next/lib/changelog.ts`：

```ts
export type ChangeType =
  | 'Added' | 'Changed' | 'Deprecated' | 'Removed' | 'Fixed' | 'Security'
  | '新功能' | '改进' | '修复';

const SECTION_RE = /^###\s+(Added|Changed|Deprecated|Removed|Fixed|Security|新功能|改进|修复)\s*$/;
```

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/changelog.test.ts`
Expected: PASS（新旧用例全过）

- [ ] **Step 5: 提交**

```bash
git add apps/web-next/lib/changelog.ts apps/web-next/tests/changelog.test.ts
git commit -m "feat(web-next): parseChangelog 支持中文三分 Section（新功能/改进/修复）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 2: `daily-changelog.ts` 新内容模型（PR 小节提取 + 三分组装）

**Files:**
- Modify: `apps/web-next/lib/daily-changelog.ts`
- Modify: `apps/web-next/tests/daily-changelog.test.ts`

**Interfaces:**
- Consumes: `ChangeType`（Task 1 扩展后）
- Produces:
  - `type UserFacingChangeType = '新功能' | '改进' | '修复'`
  - `interface UserFacingEntry { type: UserFacingChangeType; text: string }`
  - `function extractUserFacingEntries(prBody: string): UserFacingEntry[]`（解析 `## 用户向更新` 小节内 `- 新功能: xxx` 行，中英文冒号都支持）
  - `function parseUserFacingLine(line: string): UserFacingEntry | null`（单行解析，供脚本 `--subject` 复用）
  - `buildDailyReleaseSections(entries: UserFacingEntry[]): ReleaseSection[]`（三分组装 + 去重 + 占位）
  - `upsertDailyReleaseBlock(markdown: string, date: string, entries: UserFacingEntry[]): string`（签名从 `subjects: string[]` 改为 `entries`）

- [ ] **Step 1: 写失败测试**

改写 `apps/web-next/tests/daily-changelog.test.ts`（移除 `classifyDailyChange`/`normalizeDailyChangeItem` 相关断言，新增）：

```ts
describe('extractUserFacingEntries', () => {
  test('提取小节内的行前缀条目（中英文冒号）', () => {
    const body = `## 描述
重构了内部路由。
## 用户向更新
- 新功能: 支持频道文件预览
- 改进: 消息加载性能提升
- 修复：修复断线重连偶发失败
## 其他小节
不应进入
`;
    expect(extractUserFacingEntries(body)).toEqual([
      { type: '新功能', text: '支持频道文件预览' },
      { type: '改进', text: '消息加载性能提升' },
      { type: '修复', text: '修复断线重连偶发失败' },
    ]);
  });

  test('无小节或全无条目返回空数组', () => {
    expect(extractUserFacingEntries('无小节')).toEqual([]);
    expect(extractUserFacingEntries('## 用户向更新\n- 无关行\n')).toEqual([]);
  });

  test('小节后首个 ## 标题结束小节', () => {
    const body = `## 用户向更新
- 新功能: A
## 下一个
- 新功能: B
`;
    expect(extractUserFacingEntries(body)).toEqual([{ type: '新功能', text: 'A' }]);
  });
});

describe('buildDailyReleaseSections', () => {
  test('三分组装并按固定顺序', () => {
    const sections = buildDailyReleaseSections([
      { type: '修复', text: '修复 X' },
      { type: '新功能', text: '新增 Y' },
      { type: '改进', text: '更快 Z' },
    ]);
    expect(sections.map((s) => s.type)).toEqual(['新功能', '改进', '修复']);
  });

  test('去重相同条目', () => {
    const sections = buildDailyReleaseSections([
      { type: '新功能', text: 'A' },
      { type: '新功能', text: 'A' },
    ]);
    expect(sections[0].items).toEqual(['A']);
  });

  test('空条目写入占位文案（改进组）', () => {
    const sections = buildDailyReleaseSections([]);
    expect(sections).toEqual([{ type: '改进', items: ['当日无面向用户的代码变更，服务保持稳定运行。'] }]);
  });
});
```

- [ ] **Step 2: 跑测试确认失败**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/daily-changelog.test.ts`
Expected: FAIL（新函数不存在）

- [ ] **Step 3: 实现**

在 `apps/web-next/lib/daily-changelog.ts`：

```ts
import type { ChangeType, ReleaseSection } from './changelog';

const DAILY_VERSION_PREFIX = 'Daily ';
const DAILY_NO_CHANGE_ITEM = '当日无面向用户的代码变更，服务保持稳定运行。';
const RELEASE_HEADER_RE = /^##\s+\[[^\]]+\]/;

export type UserFacingChangeType = '新功能' | '改进' | '修复';
export interface UserFacingEntry { type: UserFacingChangeType; text: string }

const USER_FACING_ORDER: UserFacingChangeType[] = ['新功能', '改进', '修复'];
const USER_FACING_SECTION_RE = /^##\s*用户向更新\s*$/;
const USER_FACING_ITEM_RE = /^\s*-\s*(新功能|改进|修复)\s*[:：]\s*(.+?)\s*$/;

export function dailyReleaseVersion(date: string): string {
  return `${DAILY_VERSION_PREFIX}${date}`;
}

export function parseUserFacingLine(line: string): UserFacingEntry | null {
  const match = USER_FACING_ITEM_RE.exec(line.trim());
  if (!match) return null;
  return { type: match[1] as UserFacingChangeType, text: match[2].trim() };
}

export function extractUserFacingEntries(prBody: string): UserFacingEntry[] {
  const lines = prBody.replace(/\r\n/g, '\n').split('\n');
  const entries: UserFacingEntry[] = [];
  let inSection = false;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^##\s*/.test(line)) {
      inSection = USER_FACING_SECTION_RE.test(line);
      continue;
    }
    if (!inSection) continue;
    const entry = parseUserFacingLine(line);
    if (entry) entries.push(entry);
  }
  return entries;
}

export function buildDailyReleaseSections(entries: UserFacingEntry[]): ReleaseSection[] {
  const sections = new Map<UserFacingChangeType, string[]>();
  const seen = new Set<string>();
  for (const entry of entries) {
    if (!entry.text || seen.has(entry.text)) continue;
    seen.add(entry.text);
    sections.set(entry.type, [...(sections.get(entry.type) ?? []), entry.text]);
  }

  if (seen.size === 0) {
    sections.set('改进', [DAILY_NO_CHANGE_ITEM]);
  }

  return USER_FACING_ORDER
    .map((type) => ({ type: type as ChangeType, items: sections.get(type) ?? [] }))
    .filter((section) => section.items.length > 0);
}

export function buildDailyReleaseBlock(date: string, entries: UserFacingEntry[]): string {
  const sections = buildDailyReleaseSections(entries);
  const lines = [`## [${dailyReleaseVersion(date)}] - ${date}`];
  for (const section of sections) {
    lines.push(`### ${section.type}`);
    for (const item of section.items) {
      lines.push(`- ${item}`);
    }
  }
  return `${lines.join('\n')}\n`;
}

export function upsertDailyReleaseBlock(markdown: string, date: string, entries: UserFacingEntry[]): string {
  // 实现不变，仅 subjects: string[] → entries: UserFacingEntry[] 透传
  // ……（沿用现有 findReleaseBlock / findDailyInsertIndex / ensureTrailingNewline）
}
```

> 删除 `classifyDailyChange` 与 `normalizeDailyChangeItem`（新内容模型不再关键词分类；`scripts/update-daily-changelog.ts` 在 Task 3 同步移除调用）。

- [ ] **Step 4: 跑测试确认通过**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test -- tests/daily-changelog.test.ts`
Expected: PASS

- [ ] **Step 5: 提交**

```bash
git add apps/web-next/lib/daily-changelog.ts apps/web-next/tests/daily-changelog.test.ts
git commit -m "feat(web-next): daily-changelog 改为 PR 小节提取 + 中文三分组装，退役关键词分类" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3: `update-daily-changelog.ts` 改造（GitHub PR 拉取 + server 端点兜底）

**Files:**
- Modify: `scripts/update-daily-changelog.ts`

**Interfaces:**
- Consumes: `extractUserFacingEntries` / `parseUserFacingLine` / `upsertDailyReleaseBlock`（Task 2）、Node 内置 `fetch`
- Produces: 同 CLI 入口（`--date/--since/--until/--subject/--dry-run` 保留），但默认数据源为当天合并 PR；无 `--subject` 且未配置 server 端点时仅写入人工条目（fail-open）
- Env: `GITHUB_REPOSITORY`（owner/repo，CI 自动提供）、`GITHUB_TOKEN`、`AGENTBEAN_CHANGELOG_SERVER_URL` / `AGENTBEAN_CHANGELOG_SERVER_TOKEN`（调用 Task 3.5 的 server 端点）

- [ ] **Step 1: 实现 GitHub PR 拉取**

在 `scripts/update-daily-changelog.ts` 替换 `readCommitSubjects` 为：

```ts
interface PullRequest {
  number: number;
  title: string;
  body: string | null;
  merged_at: string | null;
  html_url: string;
}

async function fetchMergedPullRequests(since: string, until: string): Promise<PullRequest[]> {
  const repo = process.env.GITHUB_REPOSITORY;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) {
    console.log('[daily-changelog] GITHUB_REPOSITORY/GITHUB_TOKEN 缺失，跳过 PR 拉取（仅用 --subject 条目）');
    return [];
  }
  const all: PullRequest[] = [];
  let page = 1;
  for (;;) {
    const url = `https://api.github.com/repos/${repo}/pulls?state=closed&sort=updated&direction=desc&per_page=100&page=${page}`;
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json' } });
    if (!res.ok) throw new Error(`GitHub API ${res.status}: ${await res.text()}`);
    const batch = (await res.json()) as PullRequest[];
    all.push(...batch);
    if (batch.length < 100) break;
    page += 1;
  }
  // merged_at 落在 [since, until] 才属于当天（注意 until 需作为 end-of-day 边界传入）
  return all.filter((pr) => pr.merged_at && pr.merged_at >= since && pr.merged_at < untilEnd(until));
}

function untilEnd(until: string): string {
  // until 形如 YYYY-MM-DDTHH:MM:SS+08:00 → 当天 23:59:59 换算见调用处；
  // 简化：直接按 until 字符串比较（ISO 同格式可比较），当天 23:59:59 由调用方传入。
  return until;
}
```

> **说明**：现有 `since`/`until` 已含时区后缀（`+08:00`），ISO 字符串同格式可直接比较；脚本入口 `--since/--until` 语义不变，方便按天重跑。

- [ ] **Step 2: 实现 server 端点兜底调用（fail-open）**

新增：

```ts
interface ChangelogSummarizeResult { number: number; entries: UserFacingEntry[] }

function readServerConfig(): { serverUrl: string; serverToken: string } | null {
  const serverUrl = process.env.AGENTBEAN_CHANGELOG_SERVER_URL;
  const serverToken = process.env.AGENTBEAN_CHANGELOG_SERVER_TOKEN;
  if (!serverUrl || !serverToken) return null;
  return { serverUrl: serverUrl.replace(/\/+$/, ''), serverToken };
}

// 对无小节 PR 列表调用 server 内部端点（Task 3.5），由内置 PI Manager 的
// Active PI Model 生成兜底条目；未配置/失败 → []（fail-open）。
async function summarizeMissingEntries(
  pulls: PullRequest[],
  config: { serverUrl: string; serverToken: string } | null,
): Promise<Map<number, UserFacingEntry[]>> {
  const missing = pulls.filter((pr) => !pr.body?.includes('## 用户向更新'));
  const result = new Map<number, UserFacingEntry[]>();
  if (missing.length === 0 || !config) return result;
  try {
    const res = await fetch(`${config.serverUrl}/api/internal/changelog-summarize`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${config.serverToken}`,
      },
      body: JSON.stringify({
        pulls: missing.map((pr) => ({ number: pr.number, title: pr.title, body: pr.body ?? '' })),
      }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`server summarize ${res.status}`);
    const data = (await res.json()) as { results?: ChangelogSummarizeResult[] };
    for (const item of data.results ?? []) {
      result.set(item.number, item.entries);
    }
  } catch (error) {
    console.log(`[daily-changelog] server 兜底失败（fail-open）：${error instanceof Error ? error.message : String(error)}`);
  }
  return result;
}
```

- [ ] **Step 3: 重写主流程**

```ts
const serverConfig = readServerConfig();
let entries: UserFacingEntry[] = [];
if (options.subjects.length > 0) {
  entries = options.subjects.map((line) => parseUserFacingLine(line)).filter((e): e is UserFacingEntry => e !== null);
} else {
  const pulls = await fetchMergedPullRequests(since, until);
  console.log(`[daily-changelog] ${pulls.length} merged PR(s) for ${date}`);
  const fallback = await summarizeMissingEntries(pulls, serverConfig);
  for (const pr of pulls) {
    entries.push(...extractUserFacingEntries(pr.body ?? ''));
    entries.push(...(fallback.get(pr.number) ?? []));
  }
}
const current = fs.readFileSync(changelogPath, 'utf8');
const next = upsertDailyReleaseBlock(current, date, entries);
// dry-run 分支与写入分支同现状
```

> 顶层 await：脚本已是 ESM（`type: module`），可直接 `await`。若当前文件为同步顶层，包一层 `async function main()`。

- [ ] **Step 4: 手工验证（dry-run）**

```bash
cd /Users/shaw/AgentBean && node_modules/.bin/tsx scripts/update-daily-changelog.ts --dry-run --date 2026-08-01 --subject "新功能: 支持频道文件预览" --subject "修复: 修复断线重连偶发失败"
```
Expected: stdout 输出含 `## [Daily 2026-08-01] - 2026-08-01`、`### 新功能`、`### 修复`，无英文 Section。

- [ ] **Step 5: 提交**

```bash
git add scripts/update-daily-changelog.ts
git commit -m "feat(scripts): 每日更新日志改为 PR 小节收集 + LLM 兜底（fail-open）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 3.5: server 内部端点 `POST /api/internal/changelog-summarize`

**Files:**
- Create: `apps/server-next/src/application/changelog-summarizer.ts`
- Modify: `apps/server-next/src/application/usecases.ts`（依赖注入 + `summarizeChangelogEntries` usecase）
- Modify: `apps/server-next/src/dev-server.ts`（`handleChangelogSummarizeHttp` 注册）
- Create: `apps/server-next/tests/changelog-summarizer.test.ts`

**Interfaces:**
- Consumes: `resolveActiveTarget`（现有 PI Management 通道，见 `usecases.ts:2311`）、`createOpenAiCompatibleManagementModelAdapter`（`@agentbean/pi-management-runtime`）
- Produces: usecase `summarizeChangelogEntries(input: { pulls: { number: number; title: string; body: string }[] }): Promise<{ number: number; entries: { type: '新功能'|'改进'|'修复'; text: string }[] }[]>`（fail-open：未配置/失败 → 空 entries）；HTTP `POST /api/internal/changelog-summarize`（Bearer 校验 env `AGENTBEAN_CHANGELOG_INTERNAL_TOKEN`，未配置时 503）

- [ ] **Step 1: 创建 `changelog-summarizer.ts`（仿 capability-summarizer 模式）**

```ts
/**
 * 每日更新日志 LLM 兜底总结器（内置 PI Manager / Active PI Model）。
 *
 * 背景：PR body 未写 `## 用户向更新` 小节时，由本模块对 PR 信息做单轮 LLM
 * 总结，产出用户向条目（新功能/改进/修复）。
 *
 * 设计要点：
 * - 复用 capability-summarizer 的 resolveActiveTarget 通道：credential 由
 *   Server 管理，CI 与仓库不接触模型密钥。
 * - fail-open：模型不可用/超时/输出非法 → 该 PR 空条目，绝不阻断每日流水线。
 * - 无缓存：每日只跑一次，量小（几十个 PR），不引入缓存复杂度。
 */
```

核心实现（沿用 capability-summarizer 的 adapter 用法与 JSON 解析模式）：

```ts
import {
  createOpenAiCompatibleManagementModelAdapter,
  ManagementModelAdapterError,
  type ManagementModelRequest,
  type ManagementModelResponse,
} from '@agentbean/pi-management-runtime';

export type ChangelogEntryType = '新功能' | '改进' | '修复';
export interface ChangelogEntry { type: ChangelogEntryType; text: string }
export interface ChangelogPullInput { number: number; title: string; body: string }
export interface ChangelogSummarizeResult { number: number; entries: ChangelogEntry[] }

export interface ChangelogSummarizerModelTarget {
  readonly kind: 'available';
  readonly config: { baseUrl: string; modelId: string; timeoutMs: number; maxOutputTokens: number };
  readonly apiKey: string;
}

export interface ChangelogSummarizerDependencies {
  resolveActiveTarget(): Promise<ChangelogSummarizerModelTarget | { kind: 'unavailable'; diagnosticCode: string }>;
  fetch?: typeof fetch;
}

const SUMMARIZE_SYSTEM_PROMPT = [
  'You are the release-notes author of the AgentBean product.',
  'For each pull request below, decide whether the change has a visible impact on end users.',
  'Rules:',
  '- If the change has NO user-visible impact (internal refactor, infrastructure, docs, tests), output an empty entries array for that PR.',
  '- Otherwise write 1-3 concise user-facing entries. Never invent features that are not in the PR.',
  '- Entry types must be exactly one of: 新功能 (new feature), 改进 (improvement, incl. performance), 修复 (bug fix).',
  '- Return EXACTLY one JSON object per PR on a single line, no markdown fences, no prose:',
  '{"number": <pr number>, "entries": [{"type": "新功能", "text": "<one sentence>"}]}',
  '- The text must be user-facing Chinese, free of commit messages, issue numbers, or internal slice/ADR terms.',
].join('\n');

function parseSummarizeResponse(response: ManagementModelResponse): ChangelogEntry[] {
  if (response.finishReason !== 'stop') return [];
  const texts = response.content
    .filter((item): item is { type: 'text'; text: string } => item.type === 'text')
    .map((item) => item.text);
  if (texts.length !== 1) return [];
  const raw = texts[0]!.trim().replace(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i, '$1').trim();
  try {
    const parsed = JSON.parse(raw) as { entries?: unknown };
    if (!Array.isArray(parsed.entries)) return [];
    const out: ChangelogEntry[] = [];
    for (const item of parsed.entries) {
      if (typeof item !== 'object' || item === null) continue;
      const type = (item as { type?: unknown }).type;
      const text = (item as { text?: unknown }).text;
      if ((type === '新功能' || type === '改进' || type === '修复') && typeof text === 'string' && text.trim()) {
        out.push({ type, text: text.trim() });
      }
    }
    return out;
  } catch {
    return [];
  }
}

export function createChangelogSummarizer(deps: ChangelogSummarizerDependencies): {
  summarize(pulls: ChangelogPullInput[]): Promise<ChangelogSummarizeResult[]>;
} {
  async function summarize(pulls: ChangelogPullInput[]): Promise<ChangelogSummarizeResult[]> {
    const target = await deps.resolveActiveTarget();
    if (target.kind === 'unavailable') {
      return pulls.map((p) => ({ number: p.number, entries: [] }));
    }
    const results: ChangelogSummarizeResult[] = [];
    for (const pull of pulls) {
      let response: ManagementModelResponse;
      try {
        const adapter = createOpenAiCompatibleManagementModelAdapter({
          id: `changelog-summarizer:${pull.number}`,
          apiKey: target.apiKey,
          baseUrl: target.config.baseUrl,
          modelId: target.config.modelId,
          timeoutMs: target.config.timeoutMs,
          maxOutputTokens: target.config.maxOutputTokens,
          fetch: deps.fetch,
        });
        const request: ManagementModelRequest = {
          systemPrompt: SUMMARIZE_SYSTEM_PROMPT,
          sessionContext: {
            schemaVersion: 1 as const,
            scope: { kind: 'managed' as const, managementRunId: 'changelog-summarizer', teamId: 'system', channelId: 'system', rootMessageId: 'summarizer' },
            frozenTarget: { agentId: 'changelog', kind: 'custom' as const },
            visibleThread: { revision: 0, messages: [] },
          } as never,
          messages: [{ role: 'user', content: [{ type: 'text', text: `PR #${pull.number}: ${pull.title}\n\n${pull.body.slice(0, 3000)}` }] }],
          tools: [],
        };
        response = await adapter.respond(request, { callCount: 1 });
      } catch (error) {
        if (error instanceof ManagementModelAdapterError) {
          console.warn(`changelog summarizer skipped (${error.code}): PR #${pull.number}`);
        } else {
          console.warn(`changelog summarizer skipped: PR #${pull.number} ${error instanceof Error ? error.message : String(error)}`);
        }
        results.push({ number: pull.number, entries: [] });
        continue;
      }
      results.push({ number: pull.number, entries: parseSummarizeResponse(response) });
    }
    return results;
  }
  return { summarize };
}
```

- [ ] **Step 2: usecases.ts 注入 + usecase**

在 `createServerNextUseCases` 内（仿 capability-summarizer 注入点 `usecases.ts:2310`）：

```ts
const changelogSummarizer = createChangelogSummarizer({
  resolveActiveTarget: async () => { /* 与 capability-summarizer 相同的解析实现，抽共享或复制 */ },
  fetch,
});
```

在返回的 usecases 对象增加：

```ts
async summarizeChangelogEntries(input: { pulls: { number: number; title: string; body: string }[] }) {
  return makeSuccess({ results: await changelogSummarizer.summarize(input.pulls) });
}
```

- [ ] **Step 3: dev-server.ts 注册 HTTP 端点**

在 HTTP 分发链（`dev-server.ts` 约 350 行 `ioServer` 之前）加：

```ts
if (await handleChangelogSummarizeHttp({ app, config, request, response, url })) {
  return;
}
```

handler 实现（`POST /api/internal/changelog-summarize`）：

```ts
async function handleChangelogSummarizeHttp(input: {
  app: ServerNextUseCases; config: DevServerConfig; request: IncomingMessage; response: ServerResponse; url: URL;
}): Promise<boolean> {
  const { app, config, request, response, url } = input;
  if (url.pathname !== '/api/internal/changelog-summarize') return false;
  if (request.method !== 'POST') {
    response.writeHead(405, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'METHOD_NOT_ALLOWED' }));
    return true;
  }
  const expected = config.changelogInternalToken;
  if (!expected) {
    response.writeHead(503, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'INTERNAL_ENDPOINT_NOT_CONFIGURED' }));
    return true;
  }
  const auth = request.headers.authorization ?? '';
  if (auth !== `Bearer ${expected}`) {
    response.writeHead(401, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'UNAUTHORIZED' }));
    return true;
  }
  const body = await readRequestBody(request);
  const { pulls } = JSON.parse(body) as { pulls?: { number: number; title: string; body: string }[] };
  if (!Array.isArray(pulls) || pulls.length === 0 || pulls.length > 100) {
    response.writeHead(400, { 'content-type': 'application/json' });
    response.end(JSON.stringify({ ok: false, error: 'INVALID_PULLS' }));
    return true;
  }
  const result = await app.summarizeChangelogEntries({ pulls });
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(result.value));
  return true;
}
```

> `changelogInternalToken` 加入 `DevServerConfig`，来源 env `AGENTBEAN_CHANGELOG_INTERNAL_TOKEN`；`readRequestBody` 复用现有辅助或就地实现。

- [ ] **Step 4: 总结器单测**

`apps/server-next/tests/changelog-summarizer.test.ts`：mock `resolveActiveTarget`（available/unavailable 两种）+ mock fetch 返回合法/非法/失败响应，断言 entries 正确与 fail-open 行为。

- [ ] **Step 5: 提交**

```bash
git add apps/server-next/src/application/changelog-summarizer.ts apps/server-next/src/application/usecases.ts apps/server-next/src/dev-server.ts apps/server-next/tests/changelog-summarizer.test.ts
git commit -m "feat(server): 新增 changelog-summarize 内部端点（内置 PI Manager 兜底）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 4: workflow 注入 server 端点配置

**Files:**
- Modify: `.github/workflows/daily-changelog.yml`

- [ ] **Step 1: "Update changelog source" 步骤加 env**

```yaml
      - name: Update changelog source
        env:
          AGENTBEAN_CHANGELOG_SERVER_URL: ${{ secrets.AGENTBEAN_CHANGELOG_SERVER_URL }}
          AGENTBEAN_CHANGELOG_SERVER_TOKEN: ${{ secrets.AGENTBEAN_CHANGELOG_SERVER_TOKEN }}
        run: node_modules/.bin/tsx scripts/update-daily-changelog.ts --date "${{ steps.changelog-date.outputs.date }}"
```

> `GITHUB_TOKEN` 由 Actions 自动注入（`permissions: contents: write` 已具备，无需显式传）。
> 两个 secret 未配置时流水线照常运行（仅跳过 server 兜底）——fail-open 语义，可先上线后补配置。

- [ ] **Step 2: 提交**

```bash
git add .github/workflows/daily-changelog.yml
git commit -m "ci: daily-changelog workflow 注入 server 兜底端点配置（secrets，fail-open）" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 5: UI 分组渲染（兼容旧格式）

**Files:**
- Modify: `apps/web-next/app/[teamPath]/settings/page.tsx`（`ReleaseEntry` 709-744）

**Interfaces:**
- Consumes: `Release`/`ChangeType`（Task 1 扩展后）
- Produces: 中文三分 Section → 分组渲染（组标题 + 列表，无 badge）；英文 Section → 现有 badge 渲染；两类可共存

- [ ] **Step 1: 改写 `ReleaseEntry`**

在 `apps/web-next/app/[teamPath]/settings/page.tsx` 中（保留 `SECTION_STYLE` 供英文类用）：

```tsx
const USER_FACING_TYPES = new Set<ChangeType>(['新功能', '改进', '修复']);
const USER_FACING_ORDER: ChangeType[] = ['新功能', '改进', '修复'];

function ReleaseEntry({ release }: { release: Release }) {
  const sections = release.sections.filter((s) => s.items.length > 0);
  const version = formatReleaseVersion(release.version);
  const userFacing = sections.filter((s) => USER_FACING_TYPES.has(s.type));
  const legacy = sections.filter((s) => !USER_FACING_TYPES.has(s.type));

  return (
    <article className="rounded-lg border border-neutral-200 bg-white p-5" data-smoke="settings-release-entry">
      <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
        <span className="rounded-md bg-neutral-100 px-2.5 py-1 font-mono text-sm font-semibold text-neutral-800">
          {release.date}
        </span>
        <span className="font-mono text-xs font-bold text-neutral-400">{version}</span>
      </div>

      <div className="space-y-2.5">
        {/* 中文三分类：分组渲染（无 badge） */}
        {USER_FACING_ORDER
          .filter((type) => userFacing.some((s) => s.type === type))
          .map((type) => {
            const items = userFacing.find((s) => s.type === type)!.items;
            return (
              <div key={type}>
                <div className="text-xs font-semibold text-neutral-500">{type}</div>
                <ul className="mt-1 space-y-1 pl-4">
                  {items.map((n, i) => (
                    <li key={i} className="text-sm text-neutral-700 list-disc">{n}</li>
                  ))}
                </ul>
              </div>
            );
          })}
        {/* 旧英文类：保留 badge 渲染（存量历史块） */}
        {legacy.flatMap((s) =>
          s.items.map((n, i) => (
            <div key={`${s.type}-${i}`} className="flex items-start gap-2.5">
              <span className={`inline-flex shrink-0 rounded px-1.5 py-0.5 text-[10px] font-bold uppercase leading-none ${SECTION_STYLE[s.type].badge}`}>
                {SECTION_STYLE[s.type].label}
              </span>
              <span className={`min-w-0 flex-1 text-left text-sm leading-5 ${SECTION_STYLE[s.type].item}`}>{n}</span>
            </div>
          )),
        )}
      </div>
    </article>
  );
}
```

- [ ] **Step 2: 重新生成产物并类型检查**

```bash
cd /Users/shaw/AgentBean/apps/web-next && npm run predev && npm run build
```
Expected: `releases.generated.ts` 重新生成（含新的中文 Daily 块，若 CHANGELOG.md 已有）；build 通过。

- [ ] **Step 3: 手动冒烟**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run dev`
打开 `http://localhost:4101/<任意 teamPath>/settings` → "更新日志" Tab：
- 旧格式卡片：badge 渲染不变。
- 新格式卡片（如存在）："新功能/改进/修复"分组标题 + 列表。
- 验证后 Ctrl+C。

- [ ] **Step 4: 提交**

```bash
git add "apps/web-next/app/[teamPath]/settings/page.tsx" apps/web-next/lib/releases.generated.ts
git commit -m "feat(web-next): 更新日志中文三分组渲染，兼容存量英文 badge 块" -m "Co-Authored-By: Claude <noreply@anthropic.com>"
```

---

### Task 6: 真实数据演练与全量回归

- [ ] **Step 1: 用最近一天真实数据 dry-run**

```bash
cd /Users/shaw/AgentBean && node_modules/.bin/tsx scripts/update-daily-changelog.ts --dry-run --date <最近一天>
```
Expected: 输出当天合并 PR 的条目；无小节 PR 在未配 LLM 时跳过（console 提示）。

- [ ] **Step 2: 全量测试回归**

Run: `cd /Users/shaw/AgentBean/apps/web-next && npm run test`
Expected: 全绿（changelog / daily-changelog 新旧用例）。

- [ ] **Step 3: 推送分支并发 PR**

```bash
git push -u origin feat/user-facing-changelog
```
PR 标题：`feat: 更新日志内容业务化（PR 小节 + LLM 兜底，ADR-0070）`；正文链接 spec / plan / ADR-0070。

- [ ] **Step 4: 部署提醒（合并后）**

- 仓库 Settings → Secrets and variables → Actions 配置三个 secret：`AGENTBEAN_CHANGELOG_LLM_BASE_URL`、`AGENTBEAN_CHANGELOG_LLM_API_KEY`、`AGENTBEAN_CHANGELOG_LLM_MODEL`（未配置时流水线跳过 LLM 兜底，不报错）。
- 首个真实 Daily 块产生后，人工抽查内容：无 commit subject / issue 号 / slice 术语。
- 团队约定（PR 小节格式）写入 `AGENTS.md`（后续独立 PR）。

## 收尾（实现完成后）

- 跑全量 web-next 测试回归（Task 6 已含）。
- 合并后观察 1-2 个 cron 周期（上海 00:10），确认 Daily 块为中文三分格式且无内部术语。
- 若需补写人工约定，另开 PR 更新 `AGENTS.md` 与 PR 模板建议。

## 范围外（YAGNI）

- legacy `apps/web` 的 settings 页不同步（web-next 为生产前端）。
- 设备/daemon 级更新日志（新入口，ADR-0070 范围外）。
- LLM 兜底条目"AI 生成"标记与待审流程（用户已确认直接发布不标记）。
- 关键词分类器（`classifyDailyChange`）退役，不做降级保留。
- 版本级（semver）发布粒度与 `Daily` 版本号体系改造。
