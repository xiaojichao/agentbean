# Team-wide Workspace Explorer 第一版：list 筛选

> 日期：2026-06-15
> 分支：`feat/workspace-run-explorer-filters`
> 方向：Workspace run 深化（`post-flip-follow-up-status.md` 标注的第一条剩余边界）

## 背景

生产已切换到 `apps/server-next`（PR #217 cutover）。workspace run 第一版闭环已落地——执行元数据、日志摘要排障工具、team/agent/device 列表入口、完整日志 artifact（PR #239-249、#250-253）。

`post-flip-follow-up-status.md` 与 `known-gaps.md` 反复标注的第一条剩余边界：

> 更完整的 workspace run 专用页面布局、复杂 team-wide workspace explorer 与分段日志存储/检索仍需后续产品切片覆盖。

当前 team scope run 列表（`apps/web/app/[networkPath]/runs/page.tsx`）是单一平铺列表，无任何筛选。AgentBean 核心场景是多 agent/device 协作，team 内 agent/device 增多后，100 条平铺 run 难以定位。

## 目标（本切片）

给 team workspace runs 列表加**第一版筛选能力**：按 `status` / `agent` / `device` 过滤。后端 list API 支持过滤参数，前端列表页加筛选栏并同步 URL query（刷新保持、可分享）。

这是 team-wide workspace explorer 的第一步（筛选维度），暂不做分组视图、分页、分段日志检索。

## 不做范围（后续切片）

- 分页（cursor / offset）—— 当前 100 条上限足够第一版
- 分组视图（按 agent / 日期分组）
- 分段日志存储/检索（大日志 range 查询 + 全文索引，属架构债，单独切片）
- artifact 文件浏览器增强、目录树预览

## 涉及文件

### 后端

| 文件 | 改动 |
|---|---|
| `apps/server-next/src/application/usecases.ts` | `ListTeamWorkspaceRunsInput`（:414）加可选 `agentId?`/`deviceId?`/`status?`；`listTeamWorkspaceRuns`（:2094）透传 |
| `apps/server-next/src/infra/sqlite/repositories.ts` | `workspaceRuns.listByTeam`（:1205）动态 WHERE |
| `apps/server-next/src/infra/memory/repositories.ts` | `workspaceRuns.listByTeam`（:650）对齐 |
| `apps/server-next/src/dev-server.ts` | `handleTeamWorkspaceRunsHttp`（:228）解析 `searchParams` |

### 前端

| 文件 | 改动 |
|---|---|
| `apps/web/lib/socket.ts` | `fetchTeamWorkspaceRuns(teamId, filters?)` 拼 query |
| `apps/web/app/[networkPath]/runs/page.tsx` | 筛选栏（status/agent/device select）+ URL query 同步 |

### 测试落点

- `apps/server-next/tests/sqlite-repositories.test.ts` — repository 层过滤
- `apps/server-next/tests/first-slice.test.ts` — usecase 过滤 + visibility 授权
- `apps/server-next/tests/dev-server.test.ts` — HTTP query 解析（如必要）

## TDD 步骤

### 步骤 1：repository 失败测试（sqlite）
`workspaceRuns.listByTeam` 支持 `{ teamId, limit, agentId?, deviceId?, status? }`：
- 不传过滤 = 现有行为（全量按 `updated_at DESC`）
- `agentId` 只返回该 agent 的 run
- `status` 只返回该状态
- 组合 = AND
- 过滤不绕过 team 隔离（仍按 teamId 限定）

### 步骤 2：实现 repository（sqlite + memory）
- 动态拼 WHERE + 参数化绑定（防注入）
- memory 对齐

### 步骤 3：usecase 失败测试
- `listTeamWorkspaceRuns` 透传过滤参数
- 过滤后**仍受 channel visibility 约束**（私有 channel 的 run 不泄漏给非成员）
- 非 team member → `FORBIDDEN`

### 步骤 4：实现 usecase + contract input + HTTP route
- `ListTeamWorkspaceRunsInput` 加可选字段
- `listTeamWorkspaceRuns` 透传给 `listByTeam`
- `handleTeamWorkspaceRunsHttp` 读 `input.url.searchParams`，忽略空值

### 步骤 5：前端实现
- `fetchTeamWorkspaceRuns(teamId, { agentId?, deviceId?, status? })`
- `runs/page.tsx`：status / agent / device 三个 select；筛选状态读自 + 写回 URL query（`useSearchParams`）；筛选变化重新 fetch；agent/device 选项来自已有 store snapshot（`agents`/`devices`）

### 步骤 6：验证
- `npm run test:server-next` 全绿
- `npm run test:contracts` 全绿
- `apps/web` build 通过

## 验证命令

```bash
# 用项目 Node（见 .nvmrc）跑后端测试
npm run test:server-next
npm run test:contracts
# 前端构建
cd apps/web && npm run build
```

## 验收口径

- 列表页可选 status / agent / device 过滤；URL query 反映筛选状态
- 后端过滤在 SQL 层完成，visibility 授权不变
- 既有用例（无筛选）行为零回归
