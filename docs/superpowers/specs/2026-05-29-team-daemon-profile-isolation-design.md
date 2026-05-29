---
title: AgentBean Team Daemon Profile Isolation — 团队级本地运行隔离设计
date: 2026-05-29
status: 草稿，待用户复核
related_specs:
  - 2026-05-05-agentbean-network-isolation-design.md
  - 2026-05-09-multi-network-visibility-design.md
---

# AgentBean Team Daemon Profile Isolation — 团队级本地运行隔离设计

## 1. 背景与结论

AgentBean 当前已经在服务端按 `networkId` 隔离团队数据：每个团队有独立的 SQLite 数据库和 artifacts 目录，全局库只保存用户、团队、设备、Agent 索引等元数据。

本地 daemon 侧目前更接近“一个物理设备当前连接一个团队”的模型：一个 daemon 进程持有一个 token、一个 `networkId`、一个 Socket.IO `/agent` 连接，并把本机扫描到的 Agent 注册到这个团队。

新的产品决策是：

- **一个团队对应一个本地 daemon/profile**。
- 同一台物理机器可以加入多个团队，但每个团队在本机有独立 profile、独立 token、独立缓存、独立工作区、独立 daemon 连接。
- 不采用“单 daemon 同时连接多个团队，然后完全靠代码传 `networkId` 隔离”的方案作为默认模型。

这个方向更适合当前阶段，因为它把团队边界变成本地进程边界和文件目录边界，用户心智也更清楚：进入团队时拿到连接命令，启动的是这个团队自己的本地运行时。

## 2. 为什么不优先做单进程多团队

单进程多团队不是不能实现，但隔离强度依赖每一条代码路径都正确携带并使用 tenant context。当前代码里已有多个全局或半全局状态点：

- `apps/daemon/src/auth-store.ts` 固定读写 `~/.agentbean/auth.json`，只能保存一份认证信息。
- `apps/daemon/src/scanner.ts` 固定使用 `~/.agentbean/device-id` 和 `~/.agentbean/agents/`。
- `apps/daemon/src/device-daemon.ts` 固定使用 `~/.agentbean/scanned-agents.json` 作为扫描缓存。
- `apps/daemon/src/sandbox.ts` 固定使用 `~/.agentbean/workspaces/{agentId}` 和 `/tmp/agentbean-sandbox-{agentId}.sb`。
- `apps/server/src/device-registry.ts` 当前按 `deviceId` 作为唯一 key；同一物理设备以同一个 `deviceId` 加入多个团队时，后连接的 daemon 会踢掉前一个 socket。
- `apps/server/src/db.ts` 的 `devices` 表以 `id` 为主键，并在 upsert 时更新 `network_id`，这更像“设备当前所在团队”，不是“设备在多个团队中的多个实例”。

如果做单进程多团队，任何一个漏掉 `networkId` 的 dispatch、workspace sync、artifact upload、scan cache、sandbox path 都可能造成跨团队污染。代码级 tenant 隔离可以作为优化层，但不应该作为安全边界。

## 3. 目标模型

### 3.1 概念定义

- **Machine**：物理机器，例如用户的 MacBook。它可以有一个稳定的 `machineId`。
- **Team Profile**：某台机器上某个团队的本地 profile，包含该团队 token、配置、缓存、工作区和日志。
- **Daemon Instance**：绑定一个 Team Profile 的后台进程。它只连接一个团队，只使用一个团队 token。
- **Device Instance**：服务端看到的“某台机器在某个团队里的设备实例”。它不是单纯的物理设备，而是 `teamId + machineId` 的组合身份。

### 3.2 推荐拓扑

```text
Physical Machine: Shaw-MacBook

~/.agentbean/
  machine.json
  teams/
    team-a/
      auth.json
      device-agent.yaml
      scanned-agents.json
      agents/
      workspaces/
      runs/
      logs/
    team-b/
      auth.json
      device-agent.yaml
      scanned-agents.json
      agents/
      workspaces/
      runs/
      logs/

Processes:
  agentbean-daemon --profile team-a
  agentbean-daemon --profile team-b
```

### 3.3 运行原则

- 每个 daemon 只读写自己的 profile 目录。
- 每个 daemon 只携带一个团队 token。
- 每个 daemon 只与服务端建立一个 `/agent` socket。
- 服务端 registry 不再用物理 `deviceId` 作为唯一在线 key，而应使用团队内唯一的设备实例 key。
- 如果多个团队都需要同一个本地 CLI，例如 `codex` 或 `claude`，它们可以分别由各自团队 daemon 调用，但运行记录、输出、缓存必须落在各自 profile 下。

## 4. 本地目录设计

### 4.1 目录规范

推荐将 `~/.agentbean` 分成机器级和团队级两层：

```text
~/.agentbean/
  machine.json
  teams/
    {teamId}/
      profile.json
      auth.json
      device-agent.yaml
      scanned-agents.json
      agents/
      workspaces/
      runs/
      logs/
      tmp/
```

各文件用途：

- `machine.json`：机器级信息，例如 `machineId`、hostname、创建时间。它不包含团队 token。
- `teams/{teamId}/profile.json`：团队 profile 元信息，例如 `teamId`、`serverUrl`、`profileId`、`displayName`、最后连接时间。
- `teams/{teamId}/auth.json`：该团队的 daemon token。该文件敏感，不能进入 git 或上传日志。
- `teams/{teamId}/device-agent.yaml`：该团队 daemon 的显式配置；可选。
- `teams/{teamId}/scanned-agents.json`：该团队下的本机 Agent 扫描缓存。
- `teams/{teamId}/agents/`：团队级本地 agent definition。后续如果需要“某个 agent 只属于某个团队”，放这里最清楚。
- `teams/{teamId}/workspaces/`：sandbox 或 project workspace 根目录。
- `teams/{teamId}/runs/`：运行记录、输入输出、中间文件、日志。
- `teams/{teamId}/logs/`：daemon 自身日志。
- `teams/{teamId}/tmp/`：团队级临时文件，例如 sandbox profile。

### 4.2 路径 API

daemon 里应新增统一的 profile path 模块，避免各文件各自拼 `homedir()`：

```text
apps/daemon/src/profile-paths.ts
```

建议职责：

- 解析 `AGENTBEAN_HOME`，默认 `~/.agentbean`。
- 解析 `AGENTBEAN_PROFILE` 或 `--profile`，得到当前 `teamId/profileId`。
- 提供所有本地状态路径：
  - `machineFile()`
  - `teamRoot(teamId)`
  - `authFile(teamId)`
  - `scanCacheFile(teamId)`
  - `localAgentsDir(teamId)`
  - `workspaceDir(teamId, agentId)`
  - `runDir(teamId, agentId, runId)`
  - `sandboxProfilePath(teamId, agentId)`

这样可以把当前硬编码分散点收口到一个模块，后续审查隔离边界也更容易。

### 4.3 与现有 `AGENTBEAN_HOME` 的关系

当前 `apps/daemon/src/workspace-manager.ts` 已支持 `AGENTBEAN_HOME`，但这还不够。因为 `auth-store.ts`、`scanner.ts`、`device-daemon.ts`、`sandbox.ts` 仍直接使用 `~/.agentbean`。

推荐语义：

- `AGENTBEAN_HOME`：AgentBean 总根目录，默认 `~/.agentbean`。
- `AGENTBEAN_PROFILE`：当前团队 profile，通常等于 `teamId`。
- `AGENTBEAN_PROFILE_DIR`：可选的完整 profile 目录；如果设置，则优先于 `AGENTBEAN_HOME + teams/{teamId}`。

示例：

```bash
AGENTBEAN_PROFILE=team-a agentbean-daemon --server-url ... --token ...
```

或：

```bash
AGENTBEAN_PROFILE_DIR="$HOME/.agentbean/teams/team-a" \
  agentbean-daemon --server-url ... --token ...
```

## 5. 服务端设备身份设计

### 5.1 当前问题

当前服务端有两个关键假设：

- `DeviceRegistry` 使用 `Map<deviceId, DeviceRuntime>`。
- `devices` 表使用 `id TEXT PRIMARY KEY`，其中 `id` 是 daemon 上报的 `deviceId`。

这会导致同一物理机器加入多个团队时出现冲突：

```text
team-a daemon connects with deviceId = macbook-123
DeviceRegistry["macbook-123"] = team-a socket

team-b daemon connects with deviceId = macbook-123
DeviceRegistry sees existing same deviceId, kicks old socket
DeviceRegistry["macbook-123"] = team-b socket
```

结果是 team-a 和 team-b 不能同时在线。

### 5.2 推荐身份模型

将身份拆成两层：

- `machineId`：物理机器稳定 ID，可以跨团队相同。
- `deviceInstanceId`：团队内设备实例 ID，必须跨团队不同。

推荐生成方式：

```text
machineId = stable hardware hash or cached random id
deviceInstanceId = "dev_" + sha256(teamId + ":" + machineId).slice(0, 24)
```

也可以保留可读形式：

```text
deviceInstanceId = "{safeTeamId}-{machineId}"
```

但 hash 形式更适合避免 ID 过长和泄露团队名。

### 5.3 Socket handshake

daemon 连接 `/agent` 时建议上报：

```json
{
  "token": "...",
  "networkId": "team-a",
  "deviceId": "dev_xxx",
  "machineId": "machine_yyy",
  "profileId": "team-a",
  "agents": [],
  "systemInfo": {}
}
```

兼容策略：

- 新 daemon 上报 `machineId` 和 `profileId`。
- 老 daemon 没有这两个字段时，服务端仍按旧逻辑处理。
- `deviceId` 在新协议中表示 `deviceInstanceId`，而不是物理机器 ID。

### 5.4 Registry key

短期推荐：

```text
DeviceRegistry key = deviceInstanceId
```

也就是继续使用 `deviceId` 字段，但 daemon 生成的 `deviceId` 已经是团队级实例 ID。

如果想保留旧 `deviceId` 语义，则可以改为：

```text
DeviceRegistry key = networkId + ":" + deviceId
```

但这会影响更多调用点。当前阶段更推荐让 daemon 上报团队级 `deviceInstanceId`，服务端改动更小。

### 5.5 数据库表

当前 `devices.id` 可以继续作为设备实例主键，但建议新增字段：

```sql
ALTER TABLE devices ADD COLUMN machine_id TEXT;
ALTER TABLE devices ADD COLUMN profile_id TEXT;
```

新语义：

- `devices.id`：设备实例 ID，团队内 daemon/profile 的唯一身份。
- `devices.machine_id`：物理机器 ID。
- `devices.network_id`：团队 ID。
- `devices.profile_id`：本地 profile ID，通常等于团队 ID 或团队 slug。

建议增加索引：

```sql
CREATE INDEX IF NOT EXISTS idx_devices_machine ON devices(machine_id);
CREATE UNIQUE INDEX IF NOT EXISTS idx_devices_network_machine
  ON devices(network_id, machine_id);
```

这样可以同时支持：

- 一个团队里同一物理机器只有一个活跃设备实例。
- 同一物理机器可以在多个团队各有一个设备实例。

## 6. 连接命令设计

当前产品形态是“进入团队时给用户一个连接命令”。这个心智模型可以保留，但命令需要显式绑定 profile。

推荐命令：

```bash
agentbean-daemon connect \
  --server-url https://agentbean.example.com \
  --token user:team-a:secret \
  --profile team-a
```

开发期也可以保持现有形式：

```bash
npx tsx apps/daemon/src/bin.ts \
  --server-url http://localhost:4000 \
  --token user:team-a:secret \
  --profile team-a
```

命令执行后：

1. 解析 token 得到 `networkId`。
2. 如果传入 `--profile`，校验它与 token/team 的关系。
3. 创建 `~/.agentbean/teams/{teamId}/`。
4. 写入 `auth.json` 和 `profile.json`。
5. 生成或读取 `machineId`。
6. 生成 `deviceInstanceId`。
7. 启动只连接该团队的 daemon。

如果用户加入第二个团队，会得到第二条命令：

```bash
agentbean-daemon connect \
  --server-url https://agentbean.example.com \
  --token user:team-b:secret \
  --profile team-b
```

它不会覆盖 team-a 的 `auth.json`，也不会踢掉 team-a 的进程。

## 7. 后台进程模型

### 7.1 默认模式

默认采用“一团队一 daemon 进程”：

```text
team-a profile -> daemon process A -> /agent socket A
team-b profile -> daemon process B -> /agent socket B
```

这种模型的优点：

- token 隔离清楚。
- 工作区和缓存天然分开。
- 某个团队 daemon 崩溃不会影响其他团队。
- 服务端和 UI 可以明确展示每个团队自己的设备在线状态。
- 后续接入 launchd/systemd/Windows Service 时，service label 可以包含 profile。

代价：

- 多个团队同时在线会有多个常驻进程。
- 多个进程可能重复扫描本机 runtime。
- 同一个 CLI runtime 被多个团队同时 dispatch 时，需要依赖现有 per-agent queue 或后续全局 runtime lock 控制并发。

这些代价当前可接受，比单进程多团队的隔离复杂度更低。

### 7.2 进程管理

产品层可以提供三种体验：

- **手动启动**：用户复制团队连接命令，前台运行。
- **profile 管理命令**：`agentbean-daemon profiles list/start/stop`。
- **系统后台服务**：macOS launchd、Linux systemd user、Windows Task Scheduler/Service。

建议先实现 profile 管理命令，再做系统服务集成。

### 7.3 是否自动启动所有团队

不建议默认自动启动所有团队。更合理的默认策略：

- 用户进入某个团队时，如果本地 profile 存在但 daemon 离线，提示“启动本团队本地 daemon”。
- 用户可以手动勾选“此团队开机自动启动”。
- 多团队同时在线是允许的，但由用户显式选择。

## 8. Agent ID 与跨团队可见性

团队级 daemon/profile 与“Agent 发布到多个团队”不是同一个能力。

推荐区分：

- **团队级 daemon/profile**：解决本地运行隔离。
- **agent_network_publish**：解决某个 Agent 在多个团队 UI 中可见和可被调度。

如果一个 Agent 通过 team-a 的 daemon 发布到 team-b，它实际执行仍发生在 team-a profile 对应的 daemon 上。这种模式适合“共享能力”，但不等于 team-b 拥有独立本地运行时。

如果用户要求 team-a 和 team-b 完全隔离，则应该在两个团队分别启动 daemon/profile，并让各自团队注册自己的 Agent。

## 9. 安全与隔离边界

### 9.1 必须隔离的内容

- 团队 token：`auth.json` 必须 team-scoped。
- 扫描缓存：避免一个团队看到另一个团队特有的 local agent definition。
- 工作区：sandbox workspace 必须 team-scoped。
- 运行记录：run manifests、outputs、logs 必须 team-scoped。
- 临时文件：sandbox profile、临时输出目录应包含 team/profile 维度。
- connect command：服务端保存的命令必须是当前团队/profile 的命令，不能被另一团队覆盖。

### 9.2 可以共享的内容

- 物理机器 ID：只作为关联和展示用途，不作为在线 registry 唯一 key。
- runtime 探测结果：理论上可共享，但为了简单和隔离，第一版建议先 team-scoped 缓存。
- CLI 可执行文件路径：例如 `/opt/homebrew/bin/codex`，这是系统级资源，可以被多个 profile 引用。

### 9.3 不应依赖的隔离

不要把“每个请求都带 `networkId`”作为唯一隔离手段。`networkId` 校验仍然必要，但本地 profile 和服务端 device instance 才是更稳的边界。

## 10. 迁移计划

### Phase 1：建立 profile 路径层

目标：所有本地 daemon 状态都通过统一 profile path API 获取。

涉及文件：

- `apps/daemon/src/profile-paths.ts`：新增。
- `apps/daemon/src/auth-store.ts`：改为读写当前 profile 的 `auth.json`。
- `apps/daemon/src/scanner.ts`：`device-id`、`agents/` 支持 profile/team 语义。
- `apps/daemon/src/device-daemon.ts`：`scanned-agents.json` 改为 profile-scoped。
- `apps/daemon/src/sandbox.ts`：workspace 和 sandbox profile 改为 profile-scoped。
- `apps/daemon/src/workspace-manager.ts`：与新的 profile path API 对齐。

验收标准：

- team-a 和 team-b 连接命令不会互相覆盖 auth。
- 两个 profile 的 scan cache、workspace、runs 分别落在各自目录。
- 不设置 `--profile` 时仍能兼容旧默认路径或迁移到 `default` profile。

### Phase 2：引入 machineId 与 deviceInstanceId

目标：同一物理机器可以在多个团队同时在线。

涉及文件：

- `apps/daemon/src/scanner.ts` 或新的 `machine-id.ts`：生成机器级 `machineId`。
- `apps/daemon/src/index.ts`：解析 `--profile`，生成团队级 `deviceInstanceId`。
- `apps/daemon/src/device-daemon.ts`：handshake 上报 `machineId`、`profileId`、团队级 `deviceId`。
- `apps/server/src/namespaces/agent.ts`：接收并持久化新字段。
- `apps/server/src/db.ts`：`devices` 表新增 `machine_id`、`profile_id`。
- `apps/server/src/device-registry.ts`：确保 registry key 不再让跨团队连接互踢。

验收标准：

- 同一台机器同时运行 team-a 和 team-b daemon，两个团队设备页都显示在线。
- 停止 team-a daemon 不影响 team-b 在线状态。
- team-b 重连不会触发 team-a socket disconnect。

### Phase 3：连接命令与 UI 文案更新

目标：让用户理解“团队级本地运行时”。

涉及文件：

- `apps/server/src/connect-command.ts`：生成带 `--profile` 的连接命令。
- `apps/server/src/namespaces/agent.ts`：保存 connect command 时按设备实例保存。
- `apps/web/app/[networkPath]/devices/page.tsx`：设备页文案改为“本团队本地运行时”。
- `apps/web/app/device-login/[code]/page.tsx`：加入团队流程说明 profile 会独立保存。
- `apps/daemon/README.md`：更新多团队启动示例。

验收标准：

- 用户从 team-a 页面复制的命令只写 team-a profile。
- 用户从 team-b 页面复制的命令只写 team-b profile。
- UI 不再暗示“一台物理设备只能属于一个团队”。

### Phase 4：进程管理增强

目标：降低多 daemon 对用户的管理成本。

可选能力：

- `agentbean-daemon profiles list`
- `agentbean-daemon profiles start {teamId}`
- `agentbean-daemon profiles stop {teamId}`
- `agentbean-daemon profiles status`
- macOS launchd plist 生成
- Linux systemd user unit 生成

该阶段不阻塞核心隔离模型。

## 11. 兼容策略

旧用户可能已有：

```text
~/.agentbean/auth.json
~/.agentbean/device-id
~/.agentbean/scanned-agents.json
~/.agentbean/agents/
~/.agentbean/workspaces/
```

推荐兼容方式：

- 如果启动时未传 `--profile`，继续读取旧路径，视为 `default` profile。
- 如果传入 `--profile team-a`，只读写 `teams/team-a/`，不再读取旧 `auth.json`。
- 可提供一次性迁移命令：

```bash
agentbean-daemon profiles migrate-default --team team-a
```

迁移内容：

- `auth.json` -> `teams/team-a/auth.json`
- `scanned-agents.json` -> `teams/team-a/scanned-agents.json`
- `agents/` -> `teams/team-a/agents/`
- `workspaces/` -> `teams/team-a/workspaces/`

不要自动迁移所有内容，避免误把旧默认团队的数据搬到错误团队。

## 12. 需要避免的反模式

- 不要让 `auth.json` 继续保持全局单例。
- 不要让 `DeviceRegistry` 继续以物理机器 ID 作为唯一在线 key。
- 不要在 sandbox path 中只使用 `agentId`，必须包含 team/profile。
- 不要让 connect command 被不同团队共享或覆盖。
- 不要为了省进程，把多团队隔离压进一个 daemon 的多 socket 管理里，除非后续有明确性能瓶颈。
- 不要把 `agent_network_publish` 当成本地隔离机制；它只是跨团队可见性机制。

## 13. 推荐实现顺序

优先级从高到低：

1. 新增 profile path API，统一本地路径。
2. `auth-store` 改成 profile-scoped，避免 token 覆盖。
3. 生成团队级 `deviceInstanceId`，解决多团队 daemon 互踢。
4. 服务端 `devices` 表新增 `machine_id`、`profile_id`，修正设备语义。
5. 更新 connect command，显式带 `--profile`。
6. 更新 scanner cache、local agents、sandbox workspace、runs/logs。
7. 补充多团队同时在线测试。
8. 最后做 profile 管理命令和系统后台服务集成。

## 14. 最终判断

团队级 daemon/profile 是 AgentBean 当前阶段最稳妥的多团队隔离方案。

它牺牲了一点进程数量和重复扫描成本，但换来更清楚的用户心智、更低的实现风险、更强的本地隔离边界。服务端继续保持按 `networkId` 的数据隔离；本地则通过 team profile 把 token、缓存、workspace、运行记录和 daemon 生命周期都绑定到团队。

后续如果确实出现大量团队同时在线导致资源浪费，可以再演进为“一个 controller 管多个 team worker”的模型，但 worker 仍应保留团队级进程或沙箱边界，而不是把所有团队状态混进一个普通 daemon 进程里。
