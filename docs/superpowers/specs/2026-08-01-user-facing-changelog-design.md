# 更新日志内容业务化设计（User-facing Changelog）

- **日期**：2026-08-01
- **状态**：设计稿（已通过 grilling 确认，待实施）
- **关联页面**：`https://www.agentbean.dev/{teamPath}/settings` → 更新日志 Tab
- **关联 ADR**：ADR-0070（人工撰写为主 + LLM 兜底）
- **前置文档**：`2026-07-03-changelog-dynamic-design.md`（更新日志动态化，本设计延续其真相源与管线）

## 1. 背景

用户反馈：设置页"更新日志"（Daily Changelog）记录的都是开发技术术语，终端用户看不出意义；应展示新功能、功能或性能的改进、修复等业务相关更新日志。

经 grilling 确认：入口即设置页 releases tab（用户口误称"设备页"），目标是把内容从 git commit subject 改为业务向描述，入口位置、每日节律、静态生成管线均不变。

## 2. 现状分析

| 维度 | 现状 |
|---|---|
| UI 位置 | `apps/web-next/app/[teamPath]/settings/page.tsx:678-746`，ReleasesPanel + ReleaseEntry（每天卡片 + 六色分类 badge 条目平铺），无二级详情页 |
| 数据源 | 无后端 API/表/socket；build 时静态生成：`CHANGELOG.md` → `scripts/gen-changelog.ts` → `apps/web-next/lib/releases.generated.ts` → 前端 import |
| 内容 | GitHub Actions 每日（`daily-changelog.yml`，cron `10 16 * * *`=上海 00:10）跑 `scripts/update-daily-changelog.ts` 抓当天 commit subject（`git log --no-merges --format=%s`），`daily-changelog.ts::classifyDailyChange` 按关键词分到 Section，仅剥离 conventional 前缀与 `(#123)`，其余原文展示 |
| 污染示例 | "记录 2026-07-29 每日更新日志"（bot 自指）、"server: Message tracer slice D — cutover 路由层（#921）"、每日版本号为 `Daily YYYY-MM-DD`（非 semver） |
| daemon | 不参与 changelog；设备页仅展示 daemon 版本号 + 升级引导（独立链路） |
| 设计文档冲突 | `2026-07-03-changelog-dynamic-design.md:46` 明确"不自动从 git commit 生成 changelog，人工撰写更准确"，daily 自动流程违背该意图 |

## 3. 目标与非目标

### 目标
1. Daily Changelog 内容全部为业务向描述（新功能 / 改进 / 修复），不再出现 commit subject、issue 号、slice/ADR 术语。
2. 人工撰写为主：作者在 PR body 写"用户向更新"小节，CI 自动收集。
3. LLM 兜底：未写小节的 PR 由 LLM 生成同构条目；无用户可见影响的 PR 不生成。
4. 存量历史块保留、UI 兼容渲染；真相源与静态生成管线不变。

### 非目标（YAGNI）
- 不改设置页入口与 UI 整体结构（仅 ReleaseEntry 内部渲染调整）。
- 不改每日节律与 cron 时间。
- 不新增面向产品的后端 API、表、socket 事件（LLM 兜底使用仅 CI 内部调用的工具端点，见 6.2）。
- 不迁移/业务化改写存量历史 Daily 块。
- 不做设备/daemon 级更新日志（新入口，超出本需求范围）。
- 不引入 i18n（沿用中文硬编码惯例）。

## 4. 设计决策（grilling 结论）

| # | 决策点 | 选定 | 理由 |
|---|---|---|---|
| 1 | 入口 | 设置页 releases，不动 | 用户口误"设备页"；设备页仅 daemon 版本展示，无 changelog |
| 2 | 内容来源 | 人工为主 + LLM 兜底 | 业务信息在开发时刻最准确；纯自动（现状）内容不可用；纯人工（设计原意）无兜底会退化 |
| 3 | 节律 | 保持每日 | web 持续部署，"日期"比"版本号"更有锚点；改动最小 |
| 4 | 落点 | PR body `## 用户向更新` 小节，CI 用 `gh api` 拉取 | PR 是用户向变更的自然粒度；bot 直接 push 的元变更无 PR 自动过滤；团队已有 PR body 书写习惯（Closes #N 惯例） |
| 5 | 分类 | 三分法：新功能 / 改进 / 修复 | 用户原话；现有六类（NEW/IMPROVED/DEPRECATED/REMOVED/FIX/SECURITY）收敛，安全修复归入"修复" |
| 6 | 小节格式 | 行前缀 `- 新功能: xxx` | 人与 LLM 都好写、解析统一（AI 与人工条目共用解析器） |
| 7 | LLM 兜底发布 | 直接发布、不标记 | changelog 低风险；待审区无成功先例会成僵尸流程 |
| 8 | UI 展示 | 卡片内按分类分组、无 badge | 阅读效率高；`SECTION_STYLE` 六色 badge 退役 |

## 5. 架构与数据流

### 5.1 每日流水线（改造 `scripts/update-daily-changelog.ts` + `daily-changelog.yml`）

```
GitHub Actions 每日 cron（时间不变）
    │
    ▼
gh api 拉取当天合并的 PR（title/body/mergedAt）
    │
    ├── 有 ## 用户向更新 小节 → 行前缀解析 → 人工条目
    └── 无小节 → LLM 兜底：用该 PR 的 title + commits 生成同构条目
                 （LLM 判定无用户可见影响 → 不生成）
    │
    ▼
写 CHANGELOG.md 的 ## [Daily YYYY-MM-DD] 块（新格式）
    │
    ▼
（现有管线不变）gen-changelog.ts → releases.generated.ts → 前端渲染
```

### 5.2 PR 小节约定（团队约定，写入 AGENTS.md 或 PR 模板建议）

```markdown
## 用户向更新
- 新功能: 支持频道文件预览
- 改进: 消息加载性能提升
- 修复: 修复断线重连偶发失败
```

- 小节可空（不写 = 对用户无可见影响或选择不披露）。
- 分类名固定为 新功能 / 改进 / 修复。
- 每条为一行、一句话业务描述，不带 commit 术语。

### 5.3 CHANGELOG.md 新 Daily 块格式

```markdown
## [Daily 2026-08-01]
### 新功能
- 支持频道文件预览
### 改进
- 消息加载性能提升
### 修复
- 修复断线重连偶发失败
```

无任何条目的天保留占位文案："当日无面向用户的代码变更，服务保持稳定运行。"（沿用现有 `daily-changelog.ts` 占位逻辑）。

## 6. 详细设计

### 6.1 解析层改造（`apps/web-next/lib/changelog.ts` / `daily-changelog.ts`）

- `parseChangelog` 兼容新旧两种 Section 名：旧英文（Added/Changed/Fixed/Security…）→ 旧格式渲染路径；新中文（新功能/改进/修复）→ 分组渲染路径。
- `classifyDailyChange` 退役：新条目分类由作者显式标注（行前缀），不再关键词猜测；LLM 兜底输出的条目自带分类前缀，与人工条目共用同一解析器。
- `daily-changelog.ts::normalizeDailyChangeItem` 的"剥离前缀/issue 号"逻辑退役——新内容模型下不应再出现这类脏数据。

### 6.2 LLM 兜底（内置 PI Manager / Active PI Model，复用 `apps/server-next/src/application/capability-summarizer.ts` 模式）

- **执行位置（已定）**：Server 新增仅 CI 内部使用的工具端点 `POST /api/internal/changelog-summarize`（Bearer token 鉴权，token 由部署环境 `AGENTBEAN_CHANGELOG_INTERNAL_TOKEN` 配置，GitHub 侧 secret `AGENTBEAN_CHANGELOG_SERVER_TOKEN` 配对）。CI 每日流水线把无小节 PR 列表 POST 到该端点，Server 用内置 PI Manager 的 Active PI Model（与 capability-summarizer 同一 `resolveActiveTarget` 通道）逐个生成条目后返回。
- **输入粒度**：PR 级。请求 `{ pulls: [{ number, title, body }] }`；当天合并的 PR 中未写小节的，逐个生成。
- **判空**：LLM 判定该 PR 无用户可见影响时输出空条目，不生成——防止内部重构又渗入更新日志。
- **模型**：Active PI Model（fail-open：未配置或调用失败 → 该 PR 返回空条目，不阻断流水线）。
- **输出**：`{ results: [{ number, entries: [{ type, text }] }] }`，Server 端解析 LLM JSON 输出（与 capability-summarizer 的 JSON 契约一致），CI 侧无需解析模型原始输出。
- **发布**：直接写入 CHANGELOG.md，不标记来源（用户已确认）。

### 6.3 UI 改造（`apps/web-next/app/[teamPath]/settings/page.tsx` ReleaseEntry）

- 新格式条目：卡片内分"新功能 / 改进 / 修复"三组渲染，组标题 + 条目列表，无 badge。
- 旧格式条目（存量历史块）：沿用现有六色 badge 渲染路径，只读展示。
- `SECTION_STYLE` 六色映射退役（或仅保留供旧格式渲染）。

### 6.4 流水线改造（`.github/workflows/daily-changelog.yml`）

- 增加 `gh api` 拉当天合并 PR 的步骤（GITHUB_TOKEN 已具备）。
- 增加 LLM 兜底步骤（位置见 6.2 待定项）。
- 其余（bot commit + push、时间、`gen-changelog` 触发）不变。

## 7. 测试策略

- **解析层单测**（`lib/changelog.test.ts` / `daily-changelog.test.ts` 改造）：
  - 新行前缀格式解析正确（三分组、多条目）。
  - 新旧格式混合 CHANGELOG.md 解析正确（历史块旧渲染、新块分组）。
  - 占位文案逻辑不变。
  - `classifyDailyChange` 退役后相关断言移除。
- **流水线**：`update-daily-changelog.ts` 对 fixture PR 列表（含/不含小节、LLM 跳过）的集成测试。
- **UI 冒烟**：分组渲染 + 旧格式 badge 渲染两路径均断言。

## 8. 实现步骤概要

（详细 task 拆分交给 writing-plans）

1. 解析层：`changelog.ts` 兼容新旧格式；`daily-changelog.ts` 退役关键词分类，新增行前缀解析。
2. PR 小节约定：写入 AGENTS.md（或新增 PR 模板建议）。
3. 流水线：`update-daily-changelog.ts` 改 `gh api` 拉 PR + LLM 兜底（先确认 6.2 执行位置）。
4. UI：ReleaseEntry 分组渲染 + 旧格式兼容。
5. 测试：解析/流水线/UI 单测与冒烟。
6. 存量数据：保留历史 Daily 块不动，验证新旧混合渲染。
7. 文档：ADR-0070 已记录；AGENTS.md 约定更新。

## 9. 风险与回退

- **风险**：LLM 兜底生成质量不可控（表述不准确）。
  - 缓解：输入限制为 PR title/body/commits；判空指令；changelog 低风险可事后修正；直接发布不标记已确认接受此权衡（ADR-0070）。
- **风险**：CI 中 LLM 调用的 credential 位置未定（见 6.2）。
  - 缓解：实施阶段先确认；fail-open 保证不可用时不阻塞每日流水线。
- **风险**：作者漏写小节 + LLM 也判空 → 该 PR 的变更对用户不可见。
  - 缓解：这是有意的过滤语义（无用户可见影响的 PR 不展示），非缺陷。
- **回退**：内容模型整体增量；最坏情况下恢复自动抓取路径（旧 `update-daily-changelog.ts` 逻辑保留在 git 历史）。
