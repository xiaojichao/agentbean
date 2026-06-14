# AgentBean Web D 类 payload 对等性审计（apps/web × server-next）

> 日期：2026-06-13
> 前置：`2026-06-13-web-protocol-parity-audit.md`（A/B/C 类事件名审计）
> 目的：逐事件枚举 **请求 payload + 响应 payload** 的双向字段差异（D 类），把"事件名对、payload 错"的雷一次性排出来。
> 触发：本地对接探针发现"注册进工作台"一条流程踩了 6 层 D 类 gap，证明逐事件救火不可行，必须系统枚举。
> 数据源：web 侧 `apps/web/lib/socket.ts`（各 `*Events` 的 emit payload + Promise 返回类型）；server 侧 `apps/server-next/src/application/usecases.ts`（use case input/output 签名，以 `makeSuccess` 实际 key 为准）。

---

## 一、摘要：系统性模式（最重要）

逐事件比对后，D 类 gap 高度集中在这几个**系统性模式**（修一个模式 = 修一批事件）：

| # | 系统性模式 | 影响范围 | 性质 |
|---|---|---|---|
| **D1** | **Team 域响应字段 `network*` → `team*`**：web 期望 `networks`/`network`/`fallbackNetwork`，server 返回 `teams`/`team`/`currentTeam`/`fallbackTeam` | team.list/create/switch/update/delete **全部响应** | PR #202 只迁了**事件名**（`network:*`→`team:*`），**响应字段名没迁**。web 端遗留。 |
| **D2** | **请求 ID 字段命名差**：web 发 `id`/`userId`/`networkId`，server 要 `taskId`/`agentId`/`targetUserId`/`teamId`/`memberUserId` | task.update/delete/reorder、agent.updateConfig/publish、member.updateHuman、device.get | 系统性字段名漂移 |
| **D3** | **register/login 响应 扁平↔嵌套**：web 期望 `res.token/userId/username/networkPath` 扁平，server 返回 `{token, user:{...}, currentTeam:{...}}` 嵌套 | auth.register/login | register 已修（分支），login 同型 |
| **D4** | **whoami 请求 token**：web 发 `{}`，server `whoami({token})` 要 token | auth.whoami | token 应由 socket session 注入，但 web 不发 + bind 注入链路未闭环 |
| **D5** | **email 全缺**：server `toUserDto` 不含 email，web 多处期望 `user.email` | register/login/whoami/member 响应 | server DTO 缺字段 |
| **D6** | **web 多余字段**：register `email/inviteToken/sessionId`、task.create `status`、channel.update `description`(server 是 `title`) | 多事件 | server 静默忽略，非致命但易漂移 |
| **D7** | **概念未对齐**：web `networkId`（agent.publish/create）↔ server `teamId`/`targetTeamId`；channel.update `description`↔`title` | agent/channel | network→team 概念迁移残留 |

**结论**：D 类 gap **不是 46 个孤立点**，而是 ~7 个**系统性模式**的投影。修这 7 个模式（尤其 D1/D2/D3）能一次解决大半。

---

## 二、方法论

对每个 socket 事件做**双向比对**：

- **请求方向**：web `emit(payload)` 的字段 vs server use case input 的字段
  - gap 类型：字段缺失 / 多余 / 命名差（web `id` vs server `taskId`）/ 类型差
- **响应方向**：web `Promise<{...}>` 期望的 ack 字段 vs server `makeSuccess({...})` 返回的 key
  - gap 类型：扁平↔嵌套 / 字段名差（`network` vs `team`）/ 字段缺失（email）

**图例**：✅ 对齐 ｜ ⚠️ 差异（命名/结构/缺失，非致命或可适配） ｜ ❌ 缺失/不匹配（致命，接不通） ｜ ➕ web 多发（server 忽略）

> 注：`userId`/`teamId` 在 server 多由 socket session（`withAuthenticatedUserId`）注入，web 不发视为正常（标 ✅，除非注入链路断裂如 whoami）。

---

## 三、逐域矩阵

### 3.1 AUTH

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `auth:register` | web `{username,password,email,inviteToken,sessionId}` vs server `{username,password,teamName?,joinCode?}`：缺 `teamName`(✅#206)、`inviteToken`↔`joinCode` 命名差、➕`email/sessionId` | web 期望扁平 `userId/username/email/role/networkPath`，server 嵌套 `{token,user,currentTeam,defaultChannel}`；缺 `email`(D5)、`networkPath`↔`currentTeam.path` | ❌ D3/D5（register 已修分支） |
| `auth:login` | web `{username,password,joinCode}` vs server `{username,password,joinCode?}` ✅ | 同 register：扁平↔嵌套（D3）；缺 email | ❌ D3/D5 |
| `auth:whoami` | web `{}` vs server `{token}`：**web 不发 token**（D4） | web `{user}` vs server `{user,currentTeam}` ✅（res.user 对齐） | ❌ D4（探针第 5 层根因） |
| `auth:device-login` | web `{inviteCode,username,password}` | server 无对应 use case | ❌ B 类（contracts 无） |
| `auth:change-password` | web `{currentPassword,newPassword}` | server 无 | ❌ B 类 |
| `invite:create` | web `{networkId,purpose}` | server 无（应为 `device-invite:create`/`join:create`） | ❌ B 类 |

### 3.2 TEAM（系统性重灾区 D1）

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `team:list` | web `{}` vs server `{userId}`（注入）✅ | web `{networks}` vs server `{currentTeamId,teams}`：**字段名 networks↔teams**（D1）+ web NetworkSummary↔TeamDto | ❌ D1 |
| `team:create` | web `{name,path,description,visibility}` vs server `{userId,name}`：➕path/description/visibility | web `{network}` vs server `{team,defaultChannel}`：network↔team（D1） | ❌ D1 |
| `team:switch` | web `{teamId}` vs server `{userId,teamId}` ✅ | web `{network}` vs server `{currentTeam}`：network↔currentTeam（D1） | ❌ D1 |
| `team:update` | web `{name}` vs server `{userId,teamId,name}`：web 缺 teamId（用 currentTeam?） | web `{network}` vs server `{team:{id,name,path}}`（D1） | ❌ D1 |
| `team:delete` | web `{teamId}` vs server `{userId,teamId}` ✅ | web `{fallbackNetwork}` vs server `{fallbackTeam}`（D1） | ❌ D1 |
| 订阅 `teams:snapshot` | — | **✅ 回填核实（2026-06-14）：server-next 已在 team mutation 后广播 `teams:snapshot`**，覆盖团队列表实时刷新 | ✅ |

### 3.3 MEMBER

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `members:list` | `{}` vs `{userId,teamId}`（注入）✅ | web `{humans,agents}` vs server `{humans,agents}` ✅（但 server agents 恒空） | ✅ |
| `member:update-human` | web `{userId,description}` vs server `{userId,teamId,targetUserId,description}`：**web `userId`↔server `targetUserId`**（D2） | web `{human}` vs server `{human}` ✅ | ⚠️ D2 |
| `member:update-role` | web `{targetUserId,role}` vs server `{userId,teamId,targetUserId,role}` ✅ | `{member}` ✅ | ✅ |
| `member:remove` | web `{targetUserId}` ✅ | `{userId}` ✅ | ✅ |
| `member:transfer-owner` | web `{targetUserId}` ✅ | web `{team,member}` vs server `{team:{id,name},member}` ✅ | ✅ |

### 3.4 CHANNEL

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `channel:update` | web `{channelId,name,description,visibility}` vs server `{userId,teamId,channelId,name,title,visibility}`：**`description`↔`title`**（D7） | web `{ok}` vs server `{channel}` ✅ | ⚠️ D7 |
| `channel:members` | web `{channelId}` vs server `{userId,teamId,channelId}`（注入）✅ | web `{humans,agents}` vs server `{humanMemberIds,agentMemberIds,humans,agents}` ✅ | ✅ |
| `channel:add-agent`/`add-member`/`remove-*` | web `{channelId,agentId/userId}` vs server `{...,memberUserId/agentId}`：add-member web `userId`↔server `memberUserId`（D2） | `{channel}` ✅ | ⚠️ D2（add/remove-member） |
| `channel:archive`/`delete` | `{channelId}` ✅ | `{channel}` ✅ | ✅ |
| `channel:leave` | `{channelId}` | server 无 | ❌ B 类 |
| `channel:stop-agents` | `{channelId}` | server 无 | ❌ B 类 |
| `message:search`（channel 域调用） | web `{query,limit}` vs server `{userId,teamId,query,limit}` ✅ | `{messages}` ✅ | ✅ |

### 3.5 MESSAGE / REACTION

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `message:send` | web（组件）`{channelId,body,...}` vs server `{userId,teamId,channelId,threadId?,body,artifactIds?,...}` ✅ | server `{message,dispatches[],route}` | ✅（待 UI 验证） |
| `message:react` | web `{messageId,on,emoji}` vs server `{userId,teamId,messageId,emoji?,on}` ✅ | `{messageId}` ✅ | ✅ |
| `message:save` | web `{messageId,on}` ✅ | `{messageId}` ✅ | ✅ |
| `message:list-saved` | web `{}` vs server `{userId,teamId}`（注入）✅ | `{messages}` ✅ | ✅ |
| 订阅 `message:dispatch-status` | — | server 有 | ✅ |

### 3.6 TASK

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `task:create` | web `{title,description,status,assigneeId,channelId,tags}` vs server `{userId,teamId,title,description,channelId,assigneeId,tags}`：➕`status`（server createTask 无 status） | `{task}` ✅ | ⚠️ D6 |
| `task:list` | web `{channelId}` vs server `{userId,teamId,channelId?}` ✅ | `{tasks}` ✅ | ✅ |
| `task:update` | web `{id,...}` vs server `{userId,teamId,taskId,...}`：**`id`↔`taskId`**（D2） | `{task}` ✅ | ⚠️ D2 |
| `task:delete` | web `{id}` vs server `taskId`：D2 | ✅ | ⚠️ D2 |
| `task:reorder` | web `{id,sortOrder}` vs server `taskId`：D2 | `{task}` ✅ | ⚠️ D2 |
| 订阅 `tasks:snapshot`/`task:updated` | — | `task:updated` ✅ 已在 task mutation 后广播；`tasks:snapshot` ✅ 已随 channel subscription 的 team 任务上下文广播 | ✅ |

### 3.7 DEVICE

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `device:list`（A 类已修） | web `{}` vs server `{teamId,userId}`（注入）✅ | `{devices}` ✅ | ✅ |
| `device:get` | web `{id}` vs server `{userId,deviceId}`：**`id`↔`deviceId`**（D2） | `{device}` ✅ | ⚠️ D2 |
| `device:scan` | web `{deviceId}` ✅ | `{request}` ✅ | ✅ |
| `device:agents:list` | `{deviceId}` | server 无（B 类） | ❌ B |
| `device:select-directory`/`delete`/`rename` | — | server 无 | ❌ B |
| 订阅 `devices:snapshot`/`device:status` | — | `devices:snapshot` ✅ 有；`device:status` ✅ 已随 device subscriber refresh 增量广播 | ✅ |

### 3.8 AGENT

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `agent:create` | web `{name,adapterKind,command,...,deviceId?,networkId?}` vs server `{userId,teamId,deviceId,runtimeId?,...}`：**`networkId`↔`teamId`**（D7），web deviceId optional vs server required | `{agent}` ✅ | ⚠️ D7 |
| `agent:update-config`（A 类已修） | web `{id,name,...}` vs server `{userId,teamId,agentId,...}`：**`id`↔`agentId`**（D2） | `{agent}` ✅ | ⚠️ D2 |
| `agent:publish`/`unpublish` | web `{agentId,networkId}` vs server `{userId,teamId,agentId,targetTeamId}`：**`networkId`↔`targetTeamId`**（D7） | `{agent}` ✅ | ⚠️ D7 |
| `agent:delete` | web `{agentId}` ✅ | `{agent}` ✅ | ✅ |
| `agent:custom:list` | `{deviceId?}` | server 无（B 类） | ❌ B |
| `agent:metrics` | `{}` | server-next 已绑定 `summarizeAgentMetrics` request/ack，用 dispatch history 汇总 | ✅ |
| 订阅 `agents:snapshot`/`agent:status`/`agents:discovered` | — | `agents:snapshot` ✅ 有；`agent:status` ✅ 已随 agent subscriber refresh 增量广播；`agents:discovered` ✅ 已通过 `device:scan` → daemon report 回传扫描结果 | ✅ |

### 3.9 DM

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `dm:start` | web `{agentId}` vs server `{userId,teamId,agentId}`（注入）✅ | web `{dm:{id,name,dmTargetId,createdAt}}` vs server `{dm:{channel,agent}}`（结构差） | ⚠️ 响应结构 |
| `dm:list` | `{}` vs `{userId,teamId}`（注入）✅ | web `{dms}` vs server `{dms}` ✅ | ✅ |
| 订阅 `dms:snapshot` | — | ✅ | ✅ |

### 3.10 JOIN

| 事件 | 请求 gap | 响应 gap | 状态 |
|---|---|---|---|
| `join:create` | web `{maxUses,expiresAt}` vs server `{userId,teamId,expiresAt?,maxUses?}` ✅ | web `{link:{...}}` vs server `{link,team}` ✅ | ✅ |
| `join:validate`（A 类已修） | web `{code}` ✅ | web `{networkName,expiresAt}` vs server `{link,team}`（字段差） | ⚠️ 响应 |
| `join:list` | `{}` | server 无（B 类） | ❌ B |
| `join:revoke` | `{code}` | server 无 | ❌ B |

---

## 四、Gap 分类汇总

| 类别 | 数量 | 性质 | 处置 |
|---|---|---|---|
| **D1** team 响应 `network*`→`team*` | 5 事件响应 | 系统性字段名 | web 改 `network*`→`team*`（或 server alias） |
| **D2** 请求 ID 命名差 | 7 事件 | 系统性字段名 | web 改 `id`→`taskId`/`agentId`/`deviceId`、`userId`→`targetUserId`/`memberUserId`、`networkId`→`teamId` |
| **D3** register/login 扁平↔嵌套 | 2 事件响应 | 结构 | web 适配 `res.user.*`/`res.currentTeam.*`（register 已修分支，login 同型） |
| **D4** whoami 不发 token | 1 事件 | session 注入 | 确认 `withAuthenticatedUserId` 是否注入 token；否则 web 发 `{token}` |
| **D5** email 缺失 | DTO 层 | server DTO | server `toUserDto` 加 `email`（从 users 表读，表有 email 列） |
| **D6** web 多余字段 | 多事件 | 非致命 | 清理 web 多余字段或 server 显式忽略 |
| **D7** networkId↔teamId / description↔title | agent/channel | 概念迁移 | web 改 `networkId`→`teamId`、`description`→`title`（channel.update） |
| **B 类**（contracts 无定义） | 13 项 | device 长尾/auth/join/channel/agent | 逐项决策补 server 还是裁 UI |
| **C 类**（2026-06-15 续核实） | 0 项 | 原 7 项已全部收敛 | `teams:snapshot`、`task:updated`、`tasks:snapshot`、`agent:status`、`device:status`、`agents:discovered` 已回填；`agent:metrics` 已作为 request/ack 实现。`tasks:snapshot` 语义收敛为复用 `channels:subscribe` 的 team 任务上下文。 |

---

## 五、修复策略与路线

### 优先级（按"解锁流程"排序）

1. **D3 + D4 + D5**（auth 域）：修通 register/login/whoami → web 能进工作台。register 已修分支，补 login + whoami(token) + email。
2. **D1**（team 响应 network→team）：进工作台后第一件事是 team:list，networks↔teams 不通则看不到团队。**一个模式修 5 个事件**。
3. **D2**（请求 ID 命名）：task/agent/device 操作的核心字段。**一个模式修 7 个事件**。
4. **D7**（概念迁移）：agent publish/create、channel update。
5. **B/C 类**：长尾，按 UI 用到程度排。

### 修复方向（沿用 A 类决策：改 web 对齐 server）

D1/D2/D3/D7 都是 **web 端遗留旧协议**，方向统一为**改 web 对齐 server-next**（server 是新契约基准）。D5（email）是 server 缺字段，改 server。

### 建议执行方式

- **批量 PR**：按 D1/D2 系统性模式各开一个 PR（一个模式改 N 处 web 字段，一次性解决一批），而非逐事件 PR。
- **每批后探针验证**：修完 auth 域(D3/D4/D5)→探针验证进工作台；修完 D1→探针验证 team 显示；以此类推。
- **web 事件常量迁移**：`apps/web/lib/socket.ts` 已将 contracts 已定义事件迁到 `@agentbean/contracts` 的 `WEB_EVENTS`；仍保留的硬编码项均是 contracts 尚未定义的长尾事件，需单独协议决策后再收敛。

### 预期效果

修完 D1-D5（系统性模式）后，web 应能**注册→进工作台→看团队→操作 task/agent/device** 的主干流程跑通，即可推进生产 UI 入口切换。B/C 类是长尾，不阻塞主干。

---

## 六、端到端验证结论（2026-06-14，回填）

D1-D5 + D7 全部修完后（PR #205/#208/#209/#210/#211/#212），已实测验证主干流程跑通，详见 `2026-06-14-e2e-parity-verification.md`。摘要：

- ✅ **browser smoke 19/19 全过**（含 `browser-console-clean`）—— server-next 协议实现健康
- ✅ **apps/web 注册→进工作台实测通过**：D3（嵌套结构）/D4（token session）/D1（currentTeam.path）在客户端验证
- ✅ **cutover readiness 31/31**
- ✅ **cutover 后 React #185 修复回填**：apps/web 进工作台后的 `Uncaught (in promise)` 最终真源不是 `emitWithTimeout`，而是 `NetworkLayout` render 期间调用 `router.replace('/default/chat')` 触发 Router 更新循环；最终修复与验证见 `2026-06-14-e2e-parity-verification.md` §八
- ✅ **D2/D7 客户端适配测试**：`apps/web/tests/socket.test.ts` 已覆盖 taskId / agentId / deviceId / memberUserId 与 networkId→teamId/targetTeamId payload 映射

**审计既定目标「修完 D1-D5 主干跑通」达成。**
