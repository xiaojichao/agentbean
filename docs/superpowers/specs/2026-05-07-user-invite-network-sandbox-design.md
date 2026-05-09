# 用户注册 + 邀请 + 私有/公开网络 + 沙箱 设计文档

> 日期: 2026-05-07
> 状态: Draft

---

## 1. 用户注册 + 认证

### 1.1 用户模型

扩展现有 `users` 表（位于全局 DB `global.db`）：

```sql
ALTER TABLE users ADD COLUMN password_hash TEXT;
ALTER TABLE users ADD COLUMN salt TEXT;
ALTER TABLE users ADD COLUMN email TEXT;  -- 已有 UNIQUE 约束
```

密码使用 Node.js 内置 `crypto.scryptSync` 哈希，不引入外部依赖。

### 1.2 注册流程

1. 用户执行 npx 邀请命令（见 Section 2），浏览器打开 `/join/<inviteToken>` 页面
2. 填写用户名、密码、邮箱
3. 服务端校验：用户名唯一、邮箱唯一、invite code 有效
4. 创建用户记录
5. 自动创建私有网络 `<username>-private`
6. 将用户加入私有网络的 `network_members`
7. 生成个人 token（格式 `userId:privateNetworkId:random`）
8. 返回 token 给前端，前端通过 sessionId 推回给等待中的 daemon
9. 前端跳转到 `/dashboard`（私有网络主页）

### 1.3 Token 模型

- 保持现有格式：`userId:networkId:random`
- 注册成功后生成个人 token
- daemon 存入 `~/.agentbean/auth.json`
- 同一用户可有多个 token（多设备）
- `/agent` namespace 中间件验证 token 的 `userId` 是否存在于 users 表
- `/web` namespace 增加解析，提取 userId 供前端使用

### 1.4 Socket 认证扩展

**`/agent` namespace（`namespaces/agent.ts`）：**
- 现有：验证 token 字符串匹配
- 新增：从 `parseToken(token).userId` 查 users 表，确认用户存在
- 新增：从 `parseToken(token).networkId` 确认用户有权访问该网络

**`/web` namespace（`index.ts`）：**
- 现有：简单字符串比较
- 新增：解析 token，提取 userId 存入 socket state
- 前端可通过 `auth:whoami` 事件获取当前用户信息

### 1.5 新增 Socket 事件

| 事件 | 方向 | Payload | 说明 |
|------|------|---------|------|
| `auth:register` | web→server | `{ username, password, email, inviteToken }` | 用户注册 |
| `auth:login` | web→server | `{ username, password }` | 用户登录，返回 token |
| `auth:whoami` | web→server | `{}` | 返回当前用户信息 |
| `auth:invite:validate` | daemon→server | `{ code }` | daemon 验证 invite code |
| `auth:invite:claim` | server→daemon | `{ sessionId, registerUrl }` | 返回注册 URL |
| `auth:token:deliver` | server→daemon | `{ sessionId, token }` | 注册完成后推送 token |

---

## 2. 邀请系统

### 2.1 数据模型

全局 DB 新增 `invites` 表：

```sql
CREATE TABLE IF NOT EXISTS invites (
  id TEXT PRIMARY KEY,
  code TEXT NOT NULL UNIQUE,
  created_by TEXT NOT NULL REFERENCES users(id),
  network_id TEXT REFERENCES networks(id),
  used_at INTEGER,
  expires_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_invites_code ON invites(code);
```

- `code`: 8 字符随机字符串（URL-safe base64）
- `network_id`: 可选。若关联，邀请者邀请加入特定网络；若 null，注册后创建私有网络
- `used_at`: 使用后标记，单次有效
- `expires_at`: 默认 7 天过期

### 2.2 邀请命令格式

```
npx @agentbean/daemon@latest --invite <code> --server-url https://api.agentbean.ai
```

Web UI 中"邀请成员"按钮生成此命令，提供复制功能。

### 2.3 Daemon 邀请模式流程

1. 用户执行 `npx @agentbean/daemon@latest --invite <code> --server-url <url>`
2. Daemon 连接服务端 `/agent` namespace（使用临时连接，无需 auth token）
3. 发送 `auth:invite:validate` 事件 + invite code
4. 服务端验证 code 有效且未过期，返回 `{ sessionId, registerUrl }`
5. Daemon 调用 `open`（macOS `child_process.exec('open <url>')`）自动打开浏览器
6. 用户在浏览器 `/join/<sessionId>` 页面完成注册
7. 注册成功后，服务端通过 `auth:token:deliver` 将 token 推回给等待中的 daemon（按 sessionId 路由）
8. Daemon 收到 token → 存入 `~/.agentbean/auth.json` → 断开临时连接 → 用 token 重新连接
9. 重新连接后走正常 register 流程

### 2.4 已注册用户

- 若 `~/.agentbean/auth.json` 存在有效 token，daemon 跳过注册，直接连接
- 若 invite code 关联了网络，已注册用户可选加入该网络

### 2.5 安全

- Invite code 单次使用，注册后标记 `used_at`
- 默认 7 天过期
- 创建者信息记录在 `created_by`，可追溯

---

## 3. 私有/公开网络模型

### 3.1 网络分类

| 类型 | 创建时机 | 可见性 | 用途 |
|------|---------|--------|------|
| 公开网络 | 系统启动时自动创建 `default` | 所有认证用户 | 共享 Agent、跨用户协作 |
| 私有网络 | 用户注册时自动创建 `<username>-private` | 仅创建者 | 管理 Agent、控制发布 |

### 3.2 数据模型变更

**networks 表扩展：**
```sql
ALTER TABLE networks ADD COLUMN visibility TEXT NOT NULL DEFAULT 'private';
```

**network_members 表启用：**
```sql
-- 已有 schema，启用写入
CREATE TABLE IF NOT EXISTS network_members (
  network_id TEXT NOT NULL REFERENCES networks(id),
  user_id TEXT NOT NULL REFERENCES users(id),
  role TEXT NOT NULL DEFAULT 'member',
  joined_at INTEGER NOT NULL,
  PRIMARY KEY (network_id, user_id)
);
```

- 私有网络：创建时自动将 owner 加入 `network_members`，role = `owner`
- 公开网络：所有认证用户自动可见，不需要显式加入 `network_members`

### 3.3 Agent 跨网络发布

- Agent 始终创建在用户的私有网络中
- Agent 的 `visibility` 字段控制跨网络可见性：
  - `private`：仅在私有网络可见
  - `public`：在私有网络和公开网络都可见
- 设为 `public` 时，公开网络中的该 Agent **强制在沙箱中运行**（AgentOS 类型例外）
- `agent:update` 事件支持 `visibility` 切换（private ↔ public）

### 3.4 Socket 事件变更

| 事件 | 变更 |
|------|------|
| `network:list` | 返回用户有权访问的网络（私有 + 公开） |
| `agents:snapshot` | 按 `socketNetworkMap` 过滤，只返回当前网络的 Agent |
| `agent:update` | 扩展支持 `visibility` 切换 |
| `agent:create` | 创建在用户私有网络中 |

---

## 4. Web UI 私有网络页面

### 4.1 路由

| 路由 | 页面 | 说明 |
|------|------|------|
| `/join/<token>` | 注册页面 | 新用户注册/登录 |
| `/dashboard` | 私有网络主页 | 注册后默认着陆页 |
| `/agents` | 公开网络 Agent 列表 | 改造现有页面 |
| `/agents/[agentId]` | Agent 详情 | 现有 |

### 4.2 私有网络主页 `/dashboard`

四个功能区域：

**1) Runtime 扫描区**
- "扫描本机" 按钮 → 触发 `agents:discover`
- 展示 Claude Code / Codex / Kimi CLI 安装状态（图标 + 路径）
- Runtime 仅展示，不可操作（是执行器不是 Agent）

**2) AgentOS 扫描区**
- 同一次扫描同时检测 AgentOS
- 展示 Hermes / OpenClaw 运行状态
- "添加到私有网络" 按钮（已添加的显示"已添加"）
- "发布到公开网络" 开关（visibility 切换）

**3) 手动添加 Agent**
- "添加 Agent" 按钮 → 弹出表单：
  - 名称、分类（执行器托管/AgentOS托管/独立CLI）
  - 根据分类选 Runtime/Adapter
  - 命令、参数、工作目录
  - 可见性：私有 / 公开
- 创建后自动出现在私有网络中

**4) 已有 Agent 列表**
- 卡片展示所有 Agent（私有 + 发布的公开 Agent）
- 每张卡片有可见性切换开关（private ↔ public）
- 公开 Agent 卡片上有沙箱标识图标
- AgentOS 类型 Agent 无沙箱标识

### 4.3 公开网络页面 `/agents`（改造）

- 只展示 `visibility: public` 的 Agent
- 不显示扫描/添加功能
- 保留 npx 邀请命令区域
- 保留"连接设备"区域

### 4.4 侧边栏调整

- 显示当前网络名称 + 下拉切换（私有网络/公开网络）
- 导航项：Dashboard / Agents（公开）/ 频道 / 网络
- 新增"邀请成员"按钮（生成 invite 命令）

---

## 5. 沙箱执行（macOS sandbox-exec）

### 5.1 核心设计

```
服务端 dispatch → daemon 收到任务
    → 判断 Agent 是否需要沙箱
        ├─ 公开 Agent 且非 AgentOS → sandbox-exec 包装 adapter spawn
        └─ 私有 Agent / AgentOS → 正常 adapter spawn
```

沙箱由 daemon 端负责执行，服务端只需在 dispatch payload 中携带 `sandboxed: boolean` 标记。

### 5.2 sandbox profile 动态生成

daemon 根据配置动态生成 profile 到 `/tmp/agentbean-sandbox-{agentId}.sb`：

```scheme
(version 1)

;; Agent 工作目录：读写
(allow file-read* file-write*
  (subpath "/Users/<user>/.agentbean/workspaces/<agentId>"))

;; Runtime 路径：只读（执行需要）
(allow file-read*
  (subpath "/usr/local/lib/node_modules"))

;; 临时目录：读写
(allow file-read* file-write*
  (subpath "/tmp"))

;; API 网络：仅允许对应 API endpoint
(allow network-outbound
  (remote tcp "api.anthropic.com" 443))

;; 拒绝其他所有访问
(deny default)
```

### 5.3 Daemon 端改造

**`AgentInstance.handleDispatch()` 改造：**

- 检查 `agent.visibility === 'public' && agent.category !== 'agentos-hosted'`
- 若需要沙箱：
  1. 确保工作目录 `~/.agentbean/workspaces/{agentId}/` 存在
  2. 生成 sandbox profile 到 `/tmp/agentbean-sandbox-{agentId}.sb`
  3. 将 adapter spawn 命令包装为：
     ```
     sandbox-exec -f /tmp/agentbean-sandbox-{agentId}.sb -- claude --dangerously-skip-permissions ...
     ```
- 若不需要沙箱：正常启动 adapter

### 5.4 AgentOS 豁免

- `agentos-hosted` 类别的 Agent 不经过沙箱
- 理由：Hermes/OpenClaw 是消息网关，不执行用户代码

### 5.5 安全边界

- 沙箱在 macOS 内核层面限制，Agent 进程无法绕过
- profile 在 Agent 启动前生成，Agent 无法修改
- 每个公开 Agent 使用独立 profile 和独立工作目录
- Agent 工作目录之间互相隔离

### 5.6 服务端标记

`dispatch` 事件 payload 扩展：

```typescript
{
  agentId: string;
  requestId: string;
  channelId: string;
  prompt: string;
  history?: [...];
  sandboxed: boolean;  // 新增：是否需要在沙箱中执行
}
```

服务端根据 Agent 的 `visibility` 和 `category` 设置 `sandboxed` 标记。

---

## 6. 实现顺序

建议按以下顺序实现，每个阶段可独立验证：

1. **用户注册 + 认证** — 扩展 users 表、注册 API、login/whoami socket 事件
2. **邀请系统** — invites 表、invite 生成、daemon 邀请模式、浏览器打开
3. **私有/公开网络** — network visibility、network_members 启用、Agent 跨网络发布
4. **Web UI** — 注册页、Dashboard 页、侧边栏改造、邀请命令生成
5. **沙箱** — sandbox profile 生成、daemon spawn 包装、公开 Agent 强制沙箱
