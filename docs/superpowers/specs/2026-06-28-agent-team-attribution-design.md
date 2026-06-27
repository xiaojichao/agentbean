# Agent 团队归属重构 设计

- 日期：2026-06-28
- 分支：`feat/agent-team-attribution`
- 范围：`packages/contracts` / `apps/server-next` / `apps/web-next`
- 状态：已批准，待写实现计划

## 背景

设备详情页现有「将 Agent 加入某个团队」功能：通过 `SelectNetworkDialog`（`apps/web-next/app/[networkPath]/devices/page.tsx:1172`）把一个 Agent「发布」到多个团队，底层调用 `agentEvents().publish / unpublish`。本次重构移除该多团队发布能力，改为：

1. AgentOS 托管型 Agent、自定义 Agent 默认归属当前团队；
2. 编程智能体运行时不再作为团队成员；
3. 在详情页通过「对当前团队的可见性」开关管理每个 Agent 的团队归属。

## 现状（数据模型真相）

基于生产 `server-next` + `web-next`（注意：`apps/server` / `apps/web` 为 legacy，不作为依据）核实：

| 实体 | 数据模型 | 创建路径 | 默认归属 | 是否进成员页 |
|---|---|---|---|---|
| AgentOS 托管型 Agent | `category: agentos-hosted`, `source: scanned` | 扫描/连接命令发现 | ✅ `visibleTeamIds:[team]` | ✅ |
| 自定义 Agent | `category: executor-hosted`, `source: custom` | 详情页添加 | ✅ `visibleTeamIds:[team]` | ✅ |
| 扫描到的编程执行器 | `category: executor-hosted`, `source: scanned` | 扫描发现 | ✅ `visibleTeamIds:[team]` | ✅（现状，待剔除） |
| 运行时 RuntimeDto | `RuntimeDto`（非 AgentDto） | 设备检测 | 无 teamId | ❌ 本就不进 |

关键代码位置：

- 发现并 upsert agent：`apps/server-next/src/application/usecases.ts:1648`（`ingestDiscoveredAgents`，`source:'scanned'`、`visibleTeamIds:[discoveredInput.teamId]`）
- 创建自定义 agent：`usecases.ts:1704`（`createCustomAgent`，`visibleTeamIds:[agentInput.teamId]`、`category:'executor-hosted'`）
- `publishAgent` / `unpublishAgent`：`usecases.ts:1756` / `1786`
- 成员查询：`repositories.ts:209`（接口 `listVisibleInTeam`）、`infra/sqlite/repositories.ts:1082`（实现）
- 成员页：`apps/web-next/app/[networkPath]/members/page.tsx`（`memberEvents().list()` → `agents`）
- 多团队发布 UI：`devices/page.tsx:1172`（`SelectNetworkDialog`）
- 私聊/任务权限检查：`usecases.ts:2193` / `2246`（均为 `agent.visibleTeamIds.includes(teamId)`）
- AgentDto 定义：`packages/contracts/src/agent.ts:29-48`（`primaryTeamId` + `visibleTeamIds: ID[]`）

关键发现：

1. **`publish/unpublish` 操作的就是 `visibleTeamIds`**；前端 DTO 的 `publishedNetworkIds` 只是从 `visibleTeamIds` 派生的兼容字段（`usecases.ts:3816` / `4659` 的 `publishedNetworkIds: uniqueIds(agent.visibleTeamIds)`）。
2. **创建路径其实已默认归属当前团队**（1664 / 1735 行 `visibleTeamIds:[teamId]`）。因此本需求不是「新增归属逻辑」，而是「移除多团队发布 + 收窄为当前团队可见性 + 剥离编程执行器」。
3. **`visibleTeamIds` 同时承担两个职责**：① 成员页是否展示；② 私聊/任务权限检查。这一点是可见性设计的核心约束。

## 目标 / 非目标

**目标**

1. 移除设备详情页「将 Agent 加入某个团队」的多团队发布能力（`SelectNetworkDialog`）。
2. AgentOS 托管型 Agent 与自定义 Agent 默认归属当前团队（保持现状）。
3. 扫描发现的编程执行器（`executor-hosted + scanned`）不再作为 Agent 成员实体，仅作为 `RuntimeDto` 存在。
4. 详情页为 `agentos-hosted` 与 `custom` Agent 提供「对当前团队可见性」开关。

**非目标**

- 不支持多团队归属（明确去除）。
- 不改 `RuntimeDto` 的检测与展示路径（`RuntimeGroup` 不变）。
- 不改人类成员逻辑。
- 不改 `primaryTeamId` 字段语义（保持 identity 稳定）。

## 方案选择

### 决策 1：「编程智能体运行时」的界定

「编程智能体」= `executor-hosted` 中非用户显式添加的运行时实例，即 `source ∈ {scanned, self-register}`（如设备上跑的 codex/claude-code）。它与 `agentos-hosted`（AgentOS 托管型）、`custom`（自定义）区分。`source: self-register` 在生产中基本未启用（仅 `usecases.ts:4641` 一处排序用到），但属同一类运行时实例，本次一并按编程执行器处理。

统一口径：**保留进成员页的** = `agentos-hosted`（任意 source）+ `executor-hosted + custom`；**剔除的** = `executor-hosted 且 source ≠ 'custom'`。下文过滤与迁移均遵循此规则。

### 决策 2：编程执行器实体的去留

选定：**不再存为 AgentDto，仅作为 RuntimeDto**。

- 改动 `ingestDiscoveredAgents`（`usecases.ts:1648`）只 ingest `category === 'agentos-hosted'`，跳过 `executor-hosted`。
- 需迁移历史 `executor-hosted + scanned` AgentDto（见 §6）。
- 考虑并否决的替代：① 存为 Agent 但成员页过滤（实体冗余，与「不归属」语义冲突）；② 存但 `visibleTeamIds` 留空（语义模糊，仍占用 agent 表）。

### 决策 3：可见性的数据模型表达（核心）

选定 **方案 B：清空 `visibleTeamIds` 表达「移出」，`primaryTeamId` 永久稳定**。

| 方案 | 「移出」表达 | 取舍 |
|---|---|---|
| A 清空 `primaryTeamId` | `primaryTeamId = null` | 字面直观，但 `agentIdentityKey`（`usecases.ts:1650`）含 teamId → 移出再设回被当成新 agent，历史私聊/工作区断裂；需改类型与全部权限检查。**破坏性，否决** |
| **B 清空 `visibleTeamIds`** | `visibleTeamIds = []` | **选定**。复用现有权限语义（成员页过滤 + 私聊/任务拦截本就用 `visibleTeamIds`），零新增字段，identity 稳定 |
| C 新增 `excludedFromTeam` 布尔 | 新字段 | 与 `visibleTeamIds` 双源真相，否决 |

方案 B 与「移出当前团队」产品语义完全等价：`visibleTeamIds = []` 时，成员页不展示、私聊/任务被现有权限检查自然拦截、设备详情页按 `deviceId` 查询仍可见。

## 详细设计

### 1. 数据模型

- `primaryTeamId`：永久 = 创建时所在团队，**不改**（identity 稳定）。
- `visibleTeamIds`：可见 = `[primaryTeamId]`；移出 = `[]`。
- `AgentDto`（`contracts/src/agent.ts:29`）**不新增字段**。
- 享有可见性 toggle 的：`agentos-hosted` + `custom`。
- 不再创建 AgentDto：`executor-hosted + scanned`。

### 2. 后端变更

| 组件 | 文件:行 | 变更 |
|---|---|---|
| 发现入库 | `usecases.ts:1648` `ingestDiscoveredAgents` | 只 upsert `category === 'agentos-hosted'`，跳过 `executor-hosted`（其展示由 RuntimeDto 承载） |
| 可见性切换 | `usecases.ts` 新增 `setAgentTeamVisibility` | `visible=true → visibleTeamIds=[primaryTeamId]`；`false → []`；联动默认频道 membership（见 §5） |
| 多团队发布 | `usecases.ts:1756/1786` | `publishAgent` / `unpublishAgent` 废弃（多团队语义失效）；前端改调 `setAgentTeamVisibility` |
| 成员查询 | `repositories.ts:209`、`sqlite/repositories.ts:1082` | 保留 `visibleTeamIds.includes` 过滤；**兜底**排除 `executor-hosted 且 source ≠ 'custom'` 的运行时实例（防历史数据漏网） |
| 私聊/任务权限 | `usecases.ts:2193/2246` 等 | **不改**（已是 `visibleTeamIds.includes`，移出时自动拦截） |

`setAgentTeamVisibility` 输入：`{ userId, teamId, agentId, visible: boolean }`；校验调用者为 team 成员、agent 属于该 device/team；返回更新后的 `AgentDto`。

### 3. 前端变更

- **设备详情页**（`devices/page.tsx`，`AgentRow` 组件 1118-1170）：
  - 移除 `SelectNetworkDialog`（1172）及其触发按钮「选择团队」（1153-1157）、「已发布到 N 个团队」徽章（1147-1151）；相应移除 `AgentRow` 的 `onSelectNetwork` prop 与「自定义仅可发布到私有/自有团队」限制（1180）。
  - 在 `agentos-hosted` 与 `custom` 两个分组的**每个 Agent 行尾**（状态圆点之后、删除按钮之前）增加一个**复选框**，标注「对当前团队可见」：
    - 勾选状态 = `visibleTeamIds.includes(currentTeamId)`；
    - 勾选/取消勾选调用 `setAgentTeamVisibility({ teamId: currentTeamId, agentId, visible })`；
    - 复选框点击需 `e.stopPropagation()`（避免触发行 `onClick → onSelectAgent`，参照现有删除按钮 1160 的写法）；
    - 仅 `canManage` 时可交互，否则只读展示勾选状态。
  - 行结构变更后示意：`[图标] [名称+adapterKind] [状态圆点] [☑ 对当前团队可见] [删除(仅custom)]`
- **成员页**（`members/page.tsx`）：不改代码，后端过滤已剔除被移出 agent 与编程执行器。
- **RuntimeGroup**（`devices/page.tsx:947`）：不改。

### 4. 「当前团队」判定

「当前团队」= 设备详情页 URL 的 `networkPath` 解析得到的 `teamId`（与 `members/page.tsx:66` 现有解析一致）。扫描发现、添加自定义、可见性切换均以此为 `teamId`。

### 5. 边界与连带

- **移出联动退频道**：`visibleTeamIds → []` 时同步退出默认频道 membership（复用 PR#367 的 `channel:leave` 路径），保证成员页 / 频道成员 / 私聊权限三处一致。
- **私聊历史**：移出后保留历史消息，但不可再发新私聊（权限检查拦截）。
- **设备详情页可见性**：按 `deviceId` 查询 agent，不受 `visibleTeamIds` 影响；被移出的 agent 仍可见，且可重新设为可见（`visibleTeamIds → [primaryTeamId]`，identity 不变）。
- **自定义 Agent 限制**：原「仅可发布到私有/自有团队」（`devices/page.tsx:1180`）随多团队发布一并移除。

### 6. 迁移策略

迁移脚本需幂等、可重跑：

1. **删除历史编程执行器 AgentDto**：所有 `category = 'executor-hosted' AND source IN ('scanned','self-register')` 的 agent，连同其 `channel_*_members` 记录与 `agent_identity_links` 一并删除。
2. **多团队收窄**：对所有现存 agent，`visibleTeamIds` 收窄为 `[primaryTeamId]`（去除多团队发布残留）。
3. 迁移在 server-next 启动时执行一次（沿用现有 migration 机制），记录受影响行数。

### 7. 测试策略

- **后端单测**：
  - `ingestDiscoveredAgents` 只创建 `agentos-hosted`，不创建 `executor-hosted`。
  - `setAgentTeamVisibility` 正确切换 `visibleTeamIds` 并联动频道 membership。
  - `listVisibleInTeam` 排除被移出 agent 与 `executor-hosted + scanned`。
  - 移出后发起私聊/任务被权限检查拦截。
- **前端**：可见性 toggle 双向工作；`SelectNetworkDialog` 已彻底移除。
- **迁移**：历史执行器正确删除；多团队 `visibleTeamIds` 正确收窄；脚本可重复执行无副作用。
- **回归**：成员页、智能体私聊、工作区运行列表。

## 影响面

- `packages/contracts`：新增 `setAgentTeamVisibility` 的 input/output DTO；标记 `publishAgent/unpublishAgent` 为 deprecated（或移除）。
- `apps/server-next`：usecases、repositories（sqlite + memory 双实现）、迁移。
- `apps/web-next`：设备详情页 UI、socket 事件封装（`lib/socket.ts`）。
