# 执行记录迁移至设置页「执行记录诊断」设计

> 日期：2026-07-03
> 状态：待审阅
> 生产前端：`apps/web-next`（Next.js App Router，动态段 `[teamPath]`）

## 背景

当前「执行记录」(`/{teamPath}/runs`) 作为侧边栏「诊断」分组下的一级入口，存在两个问题：

1. **可见性 bug（已查清根因，仅 runs 页独有）**：列表页 `runs/page.tsx` 最外层容器（`mx-auto max-w-5xl p-6`）缺少 `overflow-y-auto`，30 条记录的真实高度约 6749px，被 app-shell 的 `h-screen overflow-hidden` → `flex-1 flex flex-col overflow-hidden` 链路裁剪在视口高度（约 822px）内，导致底部内容看不到、无滚动条、「加载更多」按钮（位于 ~6687px）点不到。对比同级页面 `agents/dashboard/chat/tasks` 均各自包了 `flex-1 overflow-y-auto`，runs 是唯一漏掉的。
2. **信息架构**：执行记录是低频的运维诊断数据，不应占据侧边栏一级导航位；「诊断」分组下实际只有「执行记录」一项，分组结构冗余。

## 目标

- 将「执行记录」从侧边栏一级入口移除，降级为「设置」页内的一个 tab，命名为「执行记录诊断」。
- 顺带消除上述 overflow bug（内容进入设置页本就支持滚动的容器）。

## 非目标（YAGNI 边界）

- **不**为设置页 tab 引入 URL 驱动（不改造现有 4 个 tab 的 state 机制）。
- **不**改变 run 详情页路由与交互。
- **不**改变后端 API、数据获取逻辑、cursor 分页机制。
- **不**调整权限模型（仍团队全员可见）。

## 现状

### 侧边栏（`components/sidebar.tsx`）
- 主导航：聊天、任务、成员、设备、（admin）仪表盘
- 底部分组：
  - 「诊断」标题 + 执行记录（`/{np}/runs`）—— 仅此一项
  - 设置（`/{np}/settings`）

### 设置页（`app/[teamPath]/settings/page.tsx`，665 行）
- **已是 tab 结构**：左侧 tab nav（米色背景 `#FFF8E7`）+ 右侧内容区
- 4 个 tab：账号(account)、浏览器(browser)、团队(server)、更新日志(releases)
- tab 用本地 `useState<Tab>` 管理，切换**不改 URL**
- 右侧内容区 `flex-1 overflow-y-auto p-6` —— **本身支持滚动**
- 每个 tab 对应独立 Panel 组件，条件渲染 `{tab==='x' && <XPanel/>}`

### 执行记录页（`app/[teamPath]/runs/page.tsx`，494 行）
- 独立路由，客户端组件 `TeamWorkspaceRunsPage`
- 含标题、状态/Agent/设备/分组过滤器、列表、cursor 分页「加载更多」
- 数据：`fetchTeamWorkspaceRuns`（`lib/socket.ts`），请求 `GET /api/teams/{teamId}/workspace-runs`，默认 pageSize 30
- 详情页 `runs/[runId]/page.tsx` 独立存在

## 设计决策

### D1：栏目形态 = 设置页新增 tab
设置页已是 tab 结构，「栏目」最自然即第 5 个 tab，复用现有 tab 机制（左 tab nav + 右内容区 + 条件渲染）。

### D2：URL 策略 = 方案 A（跟随现有 tab）⭐
tab 维持纯前端 state，切换不改 URL，与现有 4 个 tab 完全一致。

**论证**：
- 零回归：不触碰现有 tab 机制
- 一致性：5 个 tab 行为统一
- YAGNI：诊断类功能极少需要"分享链接直达"

**代价（已接受）**：
- 刷新设置页回到默认 tab（账号）
- 旧 `/runs` 书签 redirect 后无法自动落在「执行记录诊断」tab

### D3：旧列表路由 redirect
`/{np}/runs`（列表）→ redirect 到 `/{np}/settings`，避免书签 404。
`/{np}/runs/{runId}`（详情）**保留不动**（卡片「查看详情」继续指向它）。

### D4：侧边栏精简
删除「诊断」分组标题 + 执行记录 NavItem（`sidebar.tsx:142-145`）。移除后底部只剩「设置」。

### D5：RunsPanel 抽独立组件
将 `runs/page.tsx` 的列表主体抽成独立 `RunsPanel` 组件，**不内联进 `settings/page.tsx`**（已 665 行）。理由：文件聚焦、边界清晰、独立可测、便于将来扩展（导出/搜索等只动这一个文件）。

### D6：overflow bug 随之解决
`RunsPanel` 进入设置页 `flex-1 overflow-y-auto p-6` 容器后，原 `mx-auto max-w-5xl p-6` 外壳需去掉重复 `p-6`（容器已 pad），保留宽度约束。内容在可滚动容器内渲染，overflow bug 消失。

## 次要决策（默认值，可在审阅时调整）
- **tab 位置**：团队(server) 与 更新日志(releases) 之间
- **图标**：沿用 `Terminal`（与原侧边栏入口一致；备选 `Activity` 更"诊断"）
- **panel 内大标题**：沿用「执行记录」（tab 名已是「执行记录诊断」，避免冗余）

## 改动清单

| 文件 | 改动 |
|---|---|
| `app/[teamPath]/settings/page.tsx` | `TABS` 数组 + `Tab` 类型加 `'runs'`；import `RunsPanel`；内容区加 `{tab==='runs' && <RunsPanel/>}` |
| `app/[teamPath]/settings/RunsPanel.tsx`（新建） | 迁移 `runs/page.tsx` 主体（标题/过滤器/列表/加载更多），去掉重复 padding |
| `app/[teamPath]/runs/page.tsx` | 列表渲染改为 `redirect` 到 `/{np}/settings`（`runs/[runId]/` 详情页保留不动） |
| `components/sidebar.tsx` | 删「诊断」分组 + 执行记录 NavItem（142-145 行） |

## 数据流（不变）
`RunsPanel` → `fetchTeamWorkspaceRuns`（`lib/socket.ts`）→ `GET /api/teams/{teamId}/workspace-runs` → cursor 分页（默认 30 条/页，「加载更多」拼接）。
run 详情链接 `/{np}/runs/{runId}` 不变。

## 边界与取舍
- **tab 切换卸载 RunsPanel**：丢失已加载列表/筛选状态。诊断场景可接受，对齐现有 tab 模式（其他 tab 也是条件渲染）。若将来需保留状态，再评估改 CSS `hidden`。
- **旧 `/runs` 书签**：redirect 后落到设置页默认 tab（账号），需手动点「执行记录诊断」。方案 A 已知代价。
- **权限**：团队全员可见，与现状一致，不加 admin 限制。

## 验证

### smoke 标识
现有 `data-smoke` 体系需更新：
- 新增 `data-smoke="settings-tab-runs"`（设置页 tab 按钮）
- `RunsPanel` 保留原列表标识（`workspace-runs-page`、`workspace-runs-count`、过滤器与卡片标识）

### 手动验证项
1. 侧边栏无「执行记录」入口，「诊断」分组消失
2. 设置页出现「执行记录诊断」tab，可切换
3. tab 内列表正常显示、**可滚动到底部**、「加载更多」可用（回归原 overflow bug）
4. 旧地址 `/testsns/runs` 自动跳转到 `/testsns/settings`
5. 卡片「查看详情」→ `/testsns/runs/{runId}` 正常打开
6. 刷新设置页 → 回默认 tab（账号，方案 A 预期行为）
