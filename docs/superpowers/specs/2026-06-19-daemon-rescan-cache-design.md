# daemon-next 定时重扫 + scan 缓存 设计

- 日期：2026-06-19
- 范围：`apps/daemon-next`（纯 daemon 侧，server-next 零改动）
- 关联：`agentbean-next/docs/known-gaps.md`（Reconnect Guarantees：scan interval 待定义）

## 1. 背景与目标

原版 `apps/daemon` 有三项定时机制：10s 应用层心跳、5min 定时重扫、scan 缓存(`scanned-agents.json`)。`daemon-next` 收敛为轻量执行器时**全部缺失**——只在 server 主动 `device:scan-requested` 时被动扫描，本机 runtime/agent 变化(新装 Claude Code、agent 上下线)不会自动上报。

本设计补全**定时重扫 + scan 缓存**两项。

### 为什么不做应用层心跳（已澄清）

原版应用层心跳的价值在原 server 的 `heartbeat-scanner`(30s 超时判 offline)。但 **server-next 架构不同**：纯靠 socket.io `disconnect` 事件判 offline，**无 heartbeat handler、无 heartbeat-scanner**。socket.io 内置 engine.io ping/pong(默认 pingInterval 25s)已覆盖「连接连着但 daemon 挂了」的半开/网络分区场景——ping 超时即 disconnect。叠加应用层心跳需改 server-next 加 handler，且重复 socket.io 已做的事，**边际价值低、不在本 scope**。

### 成功标准

- daemon-next 连接后，每 5min 自动重扫本机 runtime/agent，**有变化才**重新上报 snapshot（避免无意义广播）。
- 首次连接优先用本地 scan 缓存快速 announce，后台立即刷新对比；缓存变化才上报并更新缓存。
- 缓存写到 `~/.agentbean/{profileId}/scanned-agents.json`，重启后首次 announce 更快。
- server-next 与 contracts 零改动。

## 2. 基线

### 2.1 原版 apps/daemon（参考）

- **定时重扫**（`device-daemon.ts:285,405-409`）：`RESCAN_INTERVAL_MS = 5*60*1000`；扫 `scanRuntimes()`/`scanAgentOSAgents()`/`scanLocalAgents()`；结果对比 `latestRuntimes`，**变化才** `emitRegister()` 重新注册。
- **scan 缓存**（`profile-paths.ts:33`、`device-daemon.ts:337-372`）：`~/.agentbean/teams/{profileId}/scanned-agents.json`；首次连接读缓存→立即注册→后台扫描对比(JSON.stringify 排序后的 command 列表)→变化才重新注册+写缓存。
- **对比策略**：runtime/agent 的 `command` 列表排序后字符串比较。

### 2.2 daemon-next 现状（缺口）

- `apps/daemon-next/src/index.ts` `createDaemonProtocolClient`：`start()` 里 `announceDeviceSnapshot`（hello + runtimes + registerBatch）一次，之后只在 server `device:scan-requested` 时被动 `scan()` + `reportDeviceSnapshot`。**无定时重扫**。
- `apps/daemon-next/src/scanner.ts` `createBuiltinScanProvider()`：返回 `DaemonScanProvider = () => Promise<DaemonScanSnapshot>`，`DaemonScanSnapshot = { runtimes: DaemonRuntimeReport[]; agents: DaemonAgentReport[] }`。仅扫 builtin runtime(Claude/Codex/Gemini)。
- `apps/daemon-next/src/cli.ts` `runDaemonNextCli`：`const snapshot = await createBuiltinScanProvider()();` 同步等待首次扫描，再创建 client。**无缓存**——每次启动都 `which()` 探测。
- reconnect（`index.ts:138` `socket.onReconnect`）：重连后重新 announce（已正确，复用 snapshot）。

### 2.3 关键事实

- `scan` 已作为 `CreateDaemonProtocolClientInput.scan?` 注入（`cli.ts` 传 `createBuiltinScanProvider()`）。
- `reportDeviceSnapshot(socket, teamId, deviceId, runtimes, agents)` 已存在（`index.ts`），可复用。
- socket.io reconnection + ping/pong 已覆盖连接活性（不加心跳的理由）。

## 3. 设计决策

| 决策 | 选定 | 理由 |
|------|------|------|
| scope | 定时重扫 + scan 缓存 | 真实价值（runtime 变化捕捉 + 首次快）；心跳延后（socket.io ping/pong 已覆盖） |
| 重扫 interval | 5min | 对齐原版 `RESCAN_INTERVAL_MS` |
| 变化才上报 | 是 | 对比 lastSnapshot，无变化不 report（避免无意义广播，原版模式） |
| 缓存路径 | `~/.agentbean/{profileId}/scanned-agents.json` | 对齐原版；profileId 来自 cli config |
| 首次策略 | load 缓存→快速 announce→后台立即刷新对比→变化才 report+save | 避免过时窗口（不等 5min） |
| 对比策略 | runtime+agent 的 (adapterKind,name,command) 排序后 JSON.stringify | 对齐原版「command 列表」比对，容忍顺序差异 |
| 定时器 | `setInterval` + `unref()` | 不阻止进程退出 |

## 4. 架构

### 4.1 定时重扫（`index.ts` `createDaemonProtocolClient`）

在 `start()` 里，`announceDeviceSnapshot` 之后启动定时器（仅当 `scan` provider 存在）：

- 维护 `lastSnapshot`（初始 = announce 用的 snapshot）。
- `setInterval(async () => { const fresh = await scan(); if (hasChanged(lastSnapshot, fresh)) { await reportDeviceSnapshot(socket, device.teamId, currentDeviceId, fresh.runtimes, fresh.agents); lastSnapshot = fresh; } }, RESCAN_INTERVAL_MS)`。
- 定时器 `.unref()`。
- reconnect 时（`onReconnect`）重置 `lastSnapshot` 为重 announce 的 snapshot，定时器继续（socket.io 重连不重启 setInterval，但要确保 `currentDeviceId` 已更新）。

`hasChanged(a, b)`：runtime+agent 的 `(adapterKind, name, command)` 三元组排序后 JSON.stringify 比较（顺序无关）。

### 4.2 scan 缓存（新文件 `scan-cache.ts` + `cli.ts`）

新文件 `apps/daemon-next/src/scan-cache.ts`：

- `loadScanCache(profileId?): DaemonScanSnapshot | null`：读 `~/.agentbean/{profileId或'default'}/scanned-agents.json`，解析失败/不存在返回 null。
- `saveScanCache(snapshot, profileId?): void`：写同路径（mkdir recursive），失败 console.warn 不抛。
- `scanCachePath(profileId?)`：路径计算（复用 cli 的 profileId 概念，默认 `'default'`）。

`cli.ts` `runDaemonNextCli` 改首次扫描：

- `const cached = loadScanCache(config.profileId);`
- `const initial = cached ?? await createBuiltinScanProvider()();`
- `if (!cached) saveScanCache(initial, config.profileId);`（首次无缓存，写一次）
- 用 `initial.runtimes`/`initial.agents` 创建 client（快速 announce）。
- **后台立即刷新**：client.start() 后触发一次 fresh scan + 对比 `cached`/`initial`，变化则 report + save（不等 5min）。

### 4.3 后台刷新与定时重扫的统一

两者都用 `hasChanged` 对比 + `reportDeviceSnapshot` + 更新 lastSnapshot/save cache。定时重扫在 `createDaemonProtocolClient` 内（持有 socket + lastSnapshot）；后台首次刷新可在 `cli.ts`（client.start 后）或并入 `start()` 的「立即执行一次再 setInterval」模式。

**推荐**：`start()` 里 `scheduleRescan()` = 立即执行一次（首次后台刷新）+ `setInterval`（5min）。这样后台刷新与定时重扫统一在 `start()`，cli.ts 只负责缓存 load/save + 传入 initial snapshot + scan provider。

## 5. 端到端数据流

```
cli.ts runDaemonNextCli
  ├─ loadScanCache(profileId) → cached?
  ├─ initial = cached ?? await scan()
  ├─ if (!cached) saveScanCache(initial)
  ├─ createDaemonProtocolClient({ runtimes: initial.runtimes, agents: initial.agents, scan, ... })
  └─ client.start()
       ├─ announceDeviceSnapshot(initial) → lastSnapshot = initial
       ├─ scheduleRescan():
       │    ├─ 立即 fresh = await scan()
       │    ├─ hasChanged(lastSnapshot, fresh)? → reportDeviceSnapshot + lastSnapshot=fresh + saveScanCache
       │    └─ setInterval(同上, 5min).unref()
       └─ onReconnect: announce → lastSnapshot 重置
```

## 6. 错误处理与边界

| 场景 | 处理 |
|------|------|
| scan() 抛错（which 失败等） | 定时器内 try/catch，console.warn，跳过本次（下次重试），不崩 |
| loadScanCache 解析失败/不存在 | 返回 null，走 fresh scan |
| saveScanCache 写失败（权限/磁盘） | console.warn，不抛（缓存是优化，非必需） |
| 重扫无变化 | 不 report、不 save（减少广播 + IO） |
| disconnect 期间定时器触发 | scan 可跑（本地），report 会失败/socket 未连——在 report 前检查或在 report try/catch；reconnect 后 lastSnapshot 由 announce 重置 |
| scan provider 未注入 | 跳过定时重扫（保持现状：被动 device:scan-requested） |
| 定时器泄漏 | setInterval 句柄保存；进程退出时 unref 自然清理（daemon 是长驻，无需显式 clear，但提供 cleanup 钩子供测试） |

## 7. 测试策略（vitest）

- **hasChanged**：相同内容不同顺序→false（无变化）；增/删/改 runtime/agent→true；空 vs 非空→true。
- **scan-cache**：load（存在/不存在/损坏 JSON）、save（写 + 读回一致）、路径按 profileId 隔离。
- **定时重扫（createDaemonProtocolClient 集成）**：注入 fake scan（首次返回 A，定时器触发返回 B 变化）+ fake clock/短 interval；断言变化时 reportDeviceSnapshot 被调用、lastSnapshot 更新；无变化时不调用。注入 fake socket 记录 emit。
- **cli 首次缓存**：mock loadScanCache 返回缓存→用缓存 snapshot 创建 client（不调 fresh scan）；无缓存→调 fresh + save。

## 8. 改动文件清单

| 文件 | 改动 |
|------|------|
| `apps/daemon-next/src/scan-cache.ts` | 🆕 `loadScanCache`/`saveScanCache`/`scanCachePath` |
| `apps/daemon-next/src/rescan.ts`（或并入 index.ts） | 🆕 `hasChanged` + `scheduleRescan` 定时器逻辑（可测试纯函数 + 定时器） |
| `apps/daemon-next/src/index.ts` | 改：`start()` 启动 scheduleRescan（持有 lastSnapshot + scan + socket）；接口加可选 rescan interval |
| `apps/daemon-next/src/cli.ts` | 改：首次 loadScanCache → initial → saveScanCache；传 scan + initial 给 client |
| `apps/daemon-next/tests/*.test.ts` | 🆕 hasChanged / scan-cache / 定时重扫集成 / cli 缓存测试 |
| `packages/contracts` / `apps/server-next` | **零改动** |

## 9. 非目标（out of scope）

- 应用层心跳 + server-next heartbeat handler/scanner（socket.io ping/pong 已覆盖连接活性）。
- AgentOS gateway 扫描 / 本地 agents 目录扫描（builtin runtime 扫描已够第一版）。
- workspace 定时同步（原版 2min，属另一能力）。
- scan 缓存 TTL/失效策略（原版也无显式 TTL，靠后台刷新对比）。

## 10. 风险与待验证

- **`profileId` 在 cli 与缓存路径的一致性**：`config.profileId`（默认 `'default'`）用于缓存路径；确认 sanitize（如路径非法字符）。原版 `profileRoot(profileId)`。
- **定时器与 disconnect 竞态**：disconnect 期间定时器触发，report 会失败。设计上 report 前 socket 应已重连（socket.io reconnection），但需在 report try/catch 兜底。
- **hasChanged 对比粒度**：`(adapterKind, name, command)` 三元组忽略 version/installed 等字段变化——若 runtime version 升级需上报，要纳入对比字段。第一版用三元组（对齐原版 command 列表比对），version 变化靠手动 rescan。
- **测试 fake clock**：vitest 用 `vi.useFakeTimers` 推进 5min，或注入短 interval（如 10ms）测定时触发。
