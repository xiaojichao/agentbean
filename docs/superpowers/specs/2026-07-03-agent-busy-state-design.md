# AgentBean 智能体「忙碌」状态恢复设计

- **日期**：2026-07-03
- **状态**：待实现（Spec 已审）
- **作者**：shaw + Claude
- **方向**：复刻 legacy 行为，聚焦 server-next，daemon 不动、web 几乎不动
- **相关文件**：`apps/server-next/src/application/usecases.ts`、`apps/server-next/src/transport/socket-handlers.ts`、`apps/server-next/src/transport/socket-server.ts`、`apps/server-next/src/dev-server.ts`、`apps/web-next/components/agent-status-badge.tsx`

---

## 1. 背景与目标

### 1.1 用户诉求
> 「在旧版本的 AgentBean 中，智能体有在线、离线、忙碌等几种状态。当智能体正在处理任务时，该智能体状态应该显示为忙碌。具体请参考旧版本的做法。」

### 1.2 目标
恢复 agent 在处理任务时的「忙碌」显示与状态翻转，行为对齐 legacy（`apps/server` + `apps/web`）。

### 1.3 非目标（Out of Scope）
- 不改 daemon-next（无需 daemon 上报 busy，server 端驱动即可）
- 不引入 `error` 状态用于 dispatch 失败（保留 next 现状：失败 → `offline` + `lastError`）
- 不做 active-dispatch 引用计数（路由已保证单 dispatch，布尔语义足够）
- 不新增轻量单 agent 推送 helper（复用现有 `refreshAgentSubscribers` 全量扇出；如未来 dispatch 频率过高再优化）
- 不改 `DispatchStatus` 状态机（`queued/sent/accepted/...` 维持现状，本次只动 `AgentRecord.status`）

---

## 2. 现状分析（Legacy vs Next）

| 维度 | Legacy（参考实现） | Next（生产现状） |
|---|---|---|
| `busy` 是否存在 | 活的，dispatch 驱动 | **死值**——合约有 `'busy'`，server 从不写 |
| 状态存储 | 纯内存 `AgentRegistry`（agents 表无 status 列） | `AgentRecord.status` 持久化字段 |
| busy 触发点 | `dispatch()` 发出那一刻 `markBusy`（`apps/server/src/namespaces/agent.ts:878`） | dispatch 下发**不动** agent.status |
| busy 回落 | 5 点：reply/超时/取消/error_event | 终态只写 online（成功）/ offline（失败），**无 busy 回落** |
| 派发并发模型 | 串行单任务 | **可能并发**——只要 online 就被路由 |
| web 展示 | 多组件文案/配色不一致 | `AgentStatusBadge` 已支持 busy，但与 `member-detail` 文案/配色不一致 |

### 2.1 关键事实
- `AGENT_STATUSES` 已含 `'busy'`（`packages/contracts/src/agent.ts:12`），类型层零改动。
- `AgentRecord['status']` 直接复用 `AgentStatus`（`apps/server-next/src/application/repositories.ts:70`），持久化字段已就绪。
- **next 路由层当前只认 `online`**：`isEligibleOnlineAgent`（`packages/domain/src/routing.ts:94`）和 DM 分支（`usecases.ts:4150`）。因此**一旦 agent 变 `busy`，路由会自动不再派新任务给它**，天然串行化——路由层一行都不用改。
- web-next 的 `AgentStatusBadge` 早已认识 `busy`，store 的 `agentStatusRank`（`apps/web-next/lib/store.ts:72-78`）也给 busy 预留了最高权重。**展示层基本就绪**，缺的只是一个会真正写 `busy` 的生产者。

---

## 3. 设计决策

### 3.1 方向：复刻 legacy
用户确认（参考旧版本）。引入 busy 后，agent 在处理任务期间显示忙碌，且因 next 路由 online-only 的现状，**busy 的 agent 自动不被派新任务**（串行单任务），与 legacy domain 路由行为一致。

### 3.2 方案：A（最小还原）
- **busy 触发点**：dispatch 落库即 busy（`usecases.ts:2437` 之后），而非 emit 前。理由：dispatch 表是 next 的单一事实源，落库时刻即「任务已派给该 agent」的确定时刻，覆盖所有调用路径。
- **并发语义**：布尔。路由保证同一 agent 至多 1 条 active dispatch，无需引用计数。
- **持久化**：写进现有 `AgentRecord.status`，不新增字段/表。
- **推送**：复用 `refreshAgentSubscribers`，不新建 helper。
- **回落守卫**：取消/超时只在 `status === 'busy'` 时翻回 `online`，绝不复活已被级联置 offline 的 agent。

---

## 4. 状态机与翻转规则

### 4.1 状态值
`busy` 复用 `AgentStatus` 已有值，写入 `AgentRecord.status`，与 `online`/`offline` 同字段、同持久化。

### 4.2 进入 busy
`sendMessage` 在 `dispatches.create({ status: 'queued', ... })`（`usecases.ts:2437`）之后，把目标 agent 置 `'busy'` 并触发推送。

### 4.3 回落规则

| 触发 | 落点 | 回落到 | 现状 | 守卫 |
|---|---|---|---|---|
| dispatch **成功** | `receiveDispatchResult` `usecases.ts:3097` | `online` | ✅ 已有 | 无需（写 online 幂等） |
| dispatch **失败** | `receiveDispatchError` `usecases.ts:3134` | `offline`（带 lastError） | ✅ 已有 | 无需（写 offline 幂等） |
| dispatch **取消** | `cancelDispatch` `usecases.ts:2939` | `online` | 🆕 补 | `if status === 'busy'` |
| dispatch **超时** | `failTimedOutDispatches` `usecases.ts:2957` | `online` | 🆕 补 | `if status === 'busy'` |
| **device 掉线** | `markDeviceAndHostedAgentsOffline` `usecases.ts:3768` | `offline` | ✅ 已有（无条件级联） | 自动清 busy |
| **device 重连**（custom agent 恢复） | `usecases.ts:1440` | 保留 `busy`（跳过） | 🆕 改 | deviceHello 跳过 busy（`status === 'busy'` 不恢复）；交由超时调度（≤ timeoutMs）回落 online |

### 4.4 并发保证
路由 online-only → busy agent 不被派新任务 → 同一 agent 至多 1 条 active dispatch → 布尔语义足够。

---

## 5. server-next 改动落点（共 3 处 + 守卫）

### 5.1 派发 → busy（新增）
`usecases.ts` 的 `sendMessage`，在每条 `dispatches.create`（`:2437`）之后，把该 dispatch 的 `agentId` 对应的 agent 置 `'busy'`（`routeMessage` 通常产出单条 dispatch，遍历以稳健处理多条）：
```ts
await repositories.agents.updateStatus({
  agentId: dispatch.agentId,
  status: 'busy',
  // lastSeenAt 等沿用现有签名
});
// 触发推送（见 §7）
```

### 5.2 取消 → online（补缺口）
`cancelDispatch`（`usecases.ts:2939`，`markCancelled` 之后）补：
```ts
const agent = await repositories.agents.findById?.({ agentId: dispatch.agentId });
if (agent && agent.status === 'busy') {
  await repositories.agents.updateStatus({ agentId: dispatch.agentId, status: 'online', ... });
  // 触发推送
}
```

### 5.3 超时 → online（补缺口）
`failTimedOutDispatches`（`usecases.ts:2957`，`markTimedOut` 循环内）每条补同样的守卫回落。

### 5.4 守卫逻辑
取消/超时两处回落均带 `if (agent.status === 'busy')`，只把 busy 翻回 online，绝不复活已被级联置 offline 的 agent。成功/失败两处现状写 online/offline 天然幂等，**不加守卫、不动**。

### 5.5 接口签名
确认 `repositories.agents` 是否已有 `findById`/等价读取；若仅有 `updateStatus`，则守卫需通过 dispatch 记录的 agentId + 一次 agent 读取实现。实现时核对 `apps/server-next/src/application/repositories.ts:223` 的 `updateStatus` 签名与可用读取方法。

---

## 6. 边界与自愈

next 现有 device 生命周期机制天然清理 busy，**无需新增扫表逻辑**：

- **device 掉线**：`markDeviceAndHostedAgentsOffline`（`:3768`）无条件把非 offline 的 agent 置 offline → busy 自动清除。
- **server 重启后 daemon 重连**：`device:hello` 触发 `upsertHello` + custom agent 恢复（`:1440`），但恢复循环**跳过 `busy`**（`status === 'busy'` 不被覆盖回 online，避免误清还在 dispatching 的 agent）；busy 的回落交给超时调度器兜底（若 dispatch 实已死，≤ timeoutMs 内 `failTimedOutDispatches` 触发守卫回落）。scanned agent 由 daemon `registerDiscoveredAgents` 重新上报置 online → busy 被清。
- **兜底**：若 daemon 既未重连也未触发掉线（极端），dispatch 超时调度器（默认 300s 超时 / 5s 轮询，`dev-server.ts:204`）会跑 `failTimedOutDispatches` → 触发守卫回落。

对比 legacy（纯内存，重启全丢、靠 daemon 重新 register 重建），next 有持久化 + 重连恢复 + 超时三层兜底，busy 不会真卡死。

### 6.1 口径排查（实现阶段任务）
引入 busy 后，**任何「只把 `online` 当在线」的判断**都可能误伤 busy agent。实现时 grep `apps/server-next/src` 与 `packages/domain/src` 全部 `status === 'online'` / `status !== 'online'`，逐个判定：
- 该认 busy 的（如「算在线用于展示/可见性」）→ 改成 `online || busy`
- 不该认的（如路由 `isEligibleOnlineAgent`）→ 保持 online-only

已知：
- ✅ 路由 `isEligibleOnlineAgent`（`domain/routing.ts:94`）—— 保持 online-only（正是我们要的 busy 不路由）
- ✅ DM 分支（`usecases.ts:4150`）—— 同上
- ⚠️ 待排查：agent 可见列表过滤、device 解析等其他状态口径

---

## 7. 推送机制（复用现成桥接）

### 7.1 现有桥接
next 的推送桥接是 `bind(socket, EVENT, app, usecaseName, afterAgentMutation)` 模式（`socket-handlers.ts:373-374`）：daemon 发 `dispatch.result`/`dispatch.error` → 跑 usecase → **自动**调 `afterAgentMutation` → `refreshAgentSubscribers`（`socket-server.ts:474`）全量扇出。

成功/失败路径已接此桥接，**不用动**。

### 7.2 需接桥接的路径

| 改动点 | 现状推送 | 要做的 |
|---|---|---|
| 成功 `receiveDispatchResult` | ✅ 已接 `afterAgentMutation`（`:373`） | 不动 |
| 失败 `receiveDispatchError` | ✅ 已接（`:374`） | 不动 |
| 派发 `sendMessage`（写 busy） | ⚠️ message:send 路径（`socket-handlers.ts:281`）未接 agent refresh | 接上：写 busy 后触发 refresh（teamId 从返回 dispatches 取） |
| 取消 `cancelDispatch` | ⚠️ 自定义回调（`socket-handlers.ts:302`）只推 dispatchStatus | 扩展回调：加 agent refresh |
| 超时 `failTimedOutDispatches` | ⚠️ 定时器路径（`dev-server.ts:310`）只推 dispatchStatus | 加：对返回 dispatches 涉及的 team 触发 refresh |

全部复用 `refreshAgentSubscribers`（全量扇出），不新建 helper。

---

## 8. web 文案统一

现状不一致：
- `apps/web-next/components/agent-status-badge.tsx`：`busy` = **「处理中」/ 天蓝**（`bg-sky-100 text-sky-800`）
- `apps/web-next/components/member-detail.tsx:35-41,86-98` 等多数组件：`busy` = **「忙碌」/ 琥珀**（`bg-amber-50 text-amber-700`、`text-amber-500`）

按用户原话「显示为忙碌」，统一为 **「忙碌」/ 琥珀**：改 `AgentStatusBadge` 对齐多数派（改 1 个组件，`agent-card`、agent 详情页等全局生效）。其余组件已就绪，无需改动。

web 层无 schema/store/socket 改动——`AgentStatusBadge`、`agentStatusRank`、`applyAgentStatus` 均已支持 busy。

---

## 9. 测试策略

### 9.1 usecases 单测（核心）
- `sendMessage` 后目标 agent = `busy`
- `cancelDispatch`：busy → online ✅；守卫——非 busy（offline）的不被复活成 online
- `failTimedOutDispatches`：同上守卫
- 已有 `receiveDispatchResult`/`receiveDispatchError` 路径回归（status 仍正确）

### 9.2 路由测试
- busy agent 不被 `routeMessage` 命中（`packages/domain` 现有测试补充/固化，防回归）
- DM 分支同理

### 9.3 口径排查测试
- 实现时对 §6.1 排查出的每个判定点，该认 busy 的加测试

### 9.4 集成测试
- 一条 dispatch 走完 busy → online 全链路（含 web 收到 `agent:status` 事件、store 正确合并）

---

## 10. 风险与回滚

| 风险 | 缓解 |
|---|---|
| busy 卡死（终态未回落） | 三层自愈（device 掉线级联 / 重连恢复 / 300s 超时兜底）+ 守卫防复活误判 |
| 口径遗漏：某处只认 online 把 busy 当离线 | §6.1 排查任务 + 测试覆盖 |
| 全量扇出性能（dispatch 频繁 + agent 多） | 当前可接受；如需优化，方案 B（轻量 helper）独立可加 |
| 升级时已有并发 active dispatch（历史数据） | 路由已变 online-only，新任务不再并发；历史 dispatch 走正常终态回落即可 |

**回滚**：全部改动集中在 server-next 的 3 个 usecase 点 + 2 条推送接线 + 1 个 web 组件文案。回滚即还原这些点，`busy` 重新成为死值，无 schema 迁移、无不可逆变更。
