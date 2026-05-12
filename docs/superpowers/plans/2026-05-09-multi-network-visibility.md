# Agent 多网络可见性模型 + 频道系统重设计

## Context

当前每个 Agent 只属于一个网络（`agents.network_id`），通过单一的 `visibility` 字段控制可见性。用户的新需求是：
- 设备加入用户的私有网络
- Agent 可以"发布"到用户加入的多个网络（多对多）
- 频道支持私有/公开 + 用户成员
- 自定义 Agent 和独立 Agent 管理

**核心变更**：引入 `agent_network_publish` 多对多关联表，替代单 `visibility` 字段。

---

## Phase 1: 多网络 Agent 发布（基础）

### Task 1.1: 数据库 — `agent_network_publish` 表

**文件:** `apps/server/src/db.ts`

在 `GLOBAL_SCHEMA` 中添加：
```sql
CREATE TABLE IF NOT EXISTS agent_network_publish (
  agent_id     TEXT NOT NULL,
  network_id   TEXT NOT NULL,
  published_by TEXT NOT NULL,
  published_at INTEGER NOT NULL,
  PRIMARY KEY (agent_id, network_id)
);
```

在 `GlobalDb` 接口添加 `agentPublishes` DAO：
- `publish(agentId, networkId, publishedBy)`
- `unpublish(agentId, networkId)`
- `listByAgent(agentId)` → `{ networkId, publishedBy, publishedAt }[]`
- `listByNetwork(networkId)` → `{ agentId, publishedBy, publishedAt }[]`
- `isPublished(agentId, networkId)` → boolean

**Migration**: 对已有 `visibility='public'` 的 agent，自动 publish 到其 `network_id`（`INSERT OR IGNORE`）。

### Task 1.2: AgentRegistry — 添加 `publishedNetworkIds`

**文件:** `apps/server/src/registry.ts`

- `AgentRegisterInfo` 添加 `publishedNetworkIds?: string[]`
- `AgentRuntime` 添加 `publishedNetworkIds: string[]`
- 添加 `updatePublishedNetworks(agentId, networkIds)` 方法

### Task 1.3: Agent 注册 — 加载 publish 记录

**文件:** `apps/server/src/namespaces/agent.ts`

`register` handler 中，upsert agent 后加载 publish 记录：
```typescript
const publishes = globalDb.agentPublishes.listByAgent(agent.id);
const publishedNetworkIds = publishes.map(p => p.networkId);
registry.register(socketId, { ...agentInfo, publishedNetworkIds });
```

### Task 1.4: `agents:subscribe` 过滤逻辑重写

**文件:** `apps/server/src/index.ts`

替换当前逻辑为：
```typescript
const filtered = registry.all().filter(a =>
  a.networkId === networkId ||
  a.publishedNetworkIds.includes(networkId)
);
```

`snapshotToDto` 扩展，返回 `publishedNetworkIds`。

### Task 1.5: 新 Socket 事件 — `agent:publish` / `agent:unpublish`

**文件:** `apps/server/src/index.ts`

**`agent:publish`**: `{ agentId, networkId }`
- 验证：用户是 agent 的 owner（`agent.ownerId === userId`），且是目标网络成员
- 调用 `globalDb.agentPublishes.publish()`
- 更新 `AgentRuntime.publishedNetworkIds`
- 广播 `agent:status` 给 `/web` 客户端

**`agent:unpublish`**: `{ agentId, networkId }`
- 同上验证，删除 publish 记录，更新 registry，广播

### Task 1.6: 前端 — Agent 多网络可见性 UI

**文件:**
- `apps/web/lib/schema.ts` — `AgentSnapshot` 添加 `publishedNetworkIds`
- `apps/web/lib/socket.ts` — 添加 `publish`/`unpublish` 事件接口
- `apps/web/app/[networkPath]/devices/page.tsx` — 设备详情中 agent 的 visibility toggle 改为"已发布到 N 个网络"提示
- `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` — 添加多网络发布管理 UI（toggle 列表）

### Task 1.7: 邀请注册时自动加入邀请网络

**文件:** `apps/server/src/index.ts`

确认 `auth:register` 流程：用户注册 → 创建私有网络（owner）+ 加入邀请网络（member）。当前已实现，验证即可。

### 验证
1. 设备注册到私有网络 → agent 只在私有网络可见
2. 用户发布 agent 到加入的网络 B → 网络B的 `agents:subscribe` 包含该 agent
3. 取消发布 → agent 从网络 B 消失
4. agent 详情页显示发布网络列表

---

## Phase 2: 成员页面 + 频道系统

### Task 2.1: 成员页面 — 展示网络公开 Agent

**文件:**
- `apps/server/src/index.ts` — 新增 `members:list` 事件，返回 `{ humans[], agents[] }`
- `apps/web/app/[networkPath]/members/page.tsx` — 展示所有公开 agent + 网络成员，显示 agent owner 和发布时间

### Task 2.2: 频道 — 添加用户成员 + 私有/公开

**数据库** (per-network DB):
```sql
CREATE TABLE IF NOT EXISTS channel_user_members (
  channel_id TEXT NOT NULL,
  user_id    TEXT NOT NULL,
  joined_at  INTEGER NOT NULL,
  PRIMARY KEY (channel_id, user_id)
);
ALTER TABLE channels ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public';
ALTER TABLE channels ADD COLUMN created_by TEXT;
```

**文件:** `apps/server/src/channels.ts`
- `create()` 扩展：接受 `userIds[]`, `visibility`, `createdBy`
- 新增 `listForUser(networkId, userId)` — 公开频道 + 用户是成员的私有频道
- 新增 `addUserMember()` / `removeUserMember()` / `userMembers()`

**文件:** `apps/server/src/index.ts`
- `channels:subscribe` — 按用户过滤（公开 + 私有频道成员）
- `channel:create` — 扩展 payload 支持 `userIds` 和 `visibility`
- 新增 `channel:add-member` / `channel:remove-member` 事件
- `message:send` — 私有频道验证用户是成员
- **修复**: human message 的 `senderId` 填入 `socket.data.userId`

### Task 2.3: 前端 — 新建频道对话框

**文件:** `apps/web/components/new-channel-dialog.tsx`
- 添加"可见性"选择（公开/私有）
- 添加"成员"区域：agent 列表 + 用户列表，均可勾选

### Task 2.4: 前端 — 频道列表 + 私有频道标识

**文件:** `apps/web/app/[networkPath]/chat/page.tsx`
- 频道列表：私有频道显示锁图标
- 频道 header 显示成员数（agent + user）

### 验证
1. 成员页面展示所有公开 agent 及其 owner
2. 创建私有频道 → 只有被邀请的用户能看到
3. 创建公开频道 → 网络所有用户可见
4. 频道中人类消息显示正确的用户名

---

## Phase 3: 自定义 Agent + 独立 Agent

### Task 3.1: 自定义 Agent 配置 UI

**文件:**
- `apps/web/app/[networkPath]/agents/` — 新建"创建自定义 Agent"表单
  - 名称、命令、参数、工作目录、适配器类型
  - 网络发布 checkbox 列表
- `apps/server/src/index.ts` — 扩展 `agent:create` 事件支持 `publishedNetworkIds`

### Task 3.2: 独立 Agent 扫描扩展

**文件:** `apps/daemon/src/scanner.ts`
- `scanRuntimes()` 添加 manus、anygen.io 等检测
- 识别为 `category: 'standalone-cli'`, `adapterKind: 'standalone'`

### Task 3.3: Agent 详情页增强

**文件:** `apps/web/app/[networkPath]/agents/[agentId]/page.tsx`
- 完整运行时配置展示
- 网络发布矩阵
- 所在设备信息

### 验证
1. 从 UI 创建自定义 agent → 出现在列表中
2. 独立 agent 被自动扫描
3. Agent 详情页展示完整信息

---

## 关键文件清单

| 文件 | Phase | 修改内容 |
|------|-------|---------|
| `apps/server/src/db.ts` | 1 | `agent_network_publish` 表 + DAO |
| `apps/server/src/registry.ts` | 1 | `publishedNetworkIds` 字段 |
| `apps/server/src/namespaces/agent.ts` | 1 | 注册时加载 publish 记录 |
| `apps/server/src/index.ts` | 1,2 | `agents:subscribe` 重写、publish/unpublish 事件、members:list、频道扩展 |
| `apps/server/src/channels.ts` | 2 | 用户成员 + 私有频道 |
| `apps/web/lib/schema.ts` | 1 | `publishedNetworkIds` |
| `apps/web/lib/socket.ts` | 1,2 | 新事件接口 |
| `apps/web/app/[networkPath]/devices/page.tsx` | 1 | Agent 可见性 UI |
| `apps/web/app/[networkPath]/agents/[agentId]/page.tsx` | 1,3 | 多网络发布管理 |
| `apps/web/app/[networkPath]/members/page.tsx` | 2 | 展示公开 agent |
| `apps/web/components/new-channel-dialog.tsx` | 2 | 可见性 + 用户选择 |
| `apps/web/app/[networkPath]/chat/page.tsx` | 2 | 私有频道标识 |
| `apps/daemon/src/scanner.ts` | 3 | 独立 agent 检测 |
