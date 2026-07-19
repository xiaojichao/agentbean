# Phase 5A：用户级 Device Service 替换旧 npm Daemon

- 日期：2026-07-19
- 状态：实现规格
- 决策来源：[#664](https://github.com/xiaojichao/agentbean/issues/664)
- 相关设计：
  - `docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md`
  - `docs/superpowers/specs/2026-05-29-team-daemon-profile-isolation-design.md`
  - `docs/superpowers/specs/2026-06-26-daemon-dispatch-outbox-design.md`

## 1. 目标

Phase 5A 用一个长期运行的用户级 AgentBean Device Service 取代需要用户保持终端运行的 `agentbean-next-daemon`。首个生产切片是 macOS arm64 LaunchAgent；Linux 与 Windows 只冻结相同的平台 adapter 边界，后续实现。

本阶段复用现有 `apps/daemon-next` runtime、Profile 数据目录、Workspace、Local Memory、machine-id 和 outbox，不重写 Phase 1–4 的运行协议。

用户完成后应能：

```bash
agentbean device install
agentbean device start
agentbean device status
agentbean device logs
agentbean device restart
agentbean device stop
agentbean device uninstall
```

旧的前台命令在迁移窗口保留为兼容 shim，但新增产品文案、状态与命令统一使用 Device Service，不再暴露 Daemon 概念。

## 2. 非目标

- Linux x64 与 Windows x64 的生产实现。
- Apple Developer ID 公证、Windows MSI/AuthentiCode 和三平台生产供应链认证。
- Keychain、Secret Service、Credential Manager 的全面迁移；Phase 5A 保持当前凭证来源行为且不扩大暴露面。
- 内置 stable/preview 更新器、版本地板和自动回滚。
- 原生 crash facility、诊断包授权上传和 Server retention。
- 独立桌面 GUI、托盘菜单、通知中心和 Web 远程系统服务控制。
- 改写 ManagementRun、lease、checkpoint、dispatch outbox、management outbox 或 Memory 合同。

## 3. 当前事实

`apps/daemon-next` 已经具备可复用的业务 runtime：

- `createDeviceServiceCore()` 按 Dispatch Client → Task Claim Client → PI Manager Worker Host 启动，并按反序停止。
- `runDaemonNextCli()` 已支持保存 Profile、`--all-profiles`、machine-id、scan cache 和现有凭证加载。
- Workspace、Local Memory 与 management outbox 已按 Profile 存放在 `~/.agentbean/teams/<profile>/`。
- 现有入口 `agentbean-next-daemon` 仍以前台进程运行；没有用户级 Service Host、本地控制协议、状态文件或 LaunchAgent 注册器。
- `--all-profiles` 当前用同一进程内的多个异步调用承载 Profile；一个 Profile 启动失败不会终止其他 Profile，但缺少可查询的 Profile 生命周期状态和统一排空入口。

因此最短路径是给现有 runtime 增加 Supervisor/Service Host 外壳，而不是复制一套 daemon runtime。

## 4. 模块边界

### 4.1 DeviceServiceHost

`DeviceServiceHost` 是系统服务的进程入口，职责仅限：

- 取得单实例锁；
- 读取保存的 Profile registry；
- 为每个 Profile 创建和监督一个 `ProfileRunner`；
- 启动本地控制端点；
- 维护稳定、脱敏的 Service 状态；
- 处理 `SIGTERM`/`SIGINT` 和控制端点发起的两阶段排空；
- 所有 Runner 停止并完成 durable flush 后退出。

它不读取 Workspace 正文，不持有 Server 侧权限，也不重新实现 Dispatch 或 PI Manager 协议。

### 4.2 ProfileRunner

第一切片的 `ProfileRunner` 是对现有单 Profile runtime 的可停止封装。每个 Runner 必须暴露：

```ts
interface ProfileRunner {
  readonly profileId: string;
  start(): Promise<void>;
  beginDrain(deadlineMs: number): Promise<DrainResult>;
  stop(): Promise<void>;
  snapshot(): ProfileRuntimeStatus;
}
```

第一切片允许多个 Runner 位于同一 Node 进程，但接口不得依赖同进程实现。后续可把 Runner 切换为子进程隔离而不改变 Service Host、CLI 或平台 adapter。

### 4.3 PlatformServiceAdapter

平台 adapter 只处理系统注册和进程控制，不承载业务 runtime：

```ts
interface PlatformServiceAdapter {
  install(input: InstallInput): Promise<ServiceOperationResult>;
  start(): Promise<ServiceOperationResult>;
  stop(input: StopInput): Promise<ServiceOperationResult>;
  restart(input: StopInput): Promise<ServiceOperationResult>;
  status(): Promise<PlatformServiceStatus>;
  uninstall(): Promise<ServiceOperationResult>;
  logLocation(): string;
}
```

首个实现是 `MacOSLaunchAgentAdapter`。Linux systemd user 与 Windows 用户级任务必须实现相同接口，不进入本阶段 PR。

### 4.4 DeviceControlClient / Server

CLI 与 Service Host 通过当前用户目录下的本地 Unix socket 通信：

- socket：`~/.agentbean/service/control.sock`
- state：`~/.agentbean/service/state.json`
- lock：`~/.agentbean/service/service.lock`
- logs：`~/.agentbean/service/logs/device-service.log`

目录 mode 为 `0700`，文件为 `0600`，socket 只接受当前 UID。协议采用单行 JSON request/response；首版只提供 `status`、`begin-drain` 和 `shutdown`。

控制消息不得包含 token、Workspace 路径、Local Memory 正文、环境变量或自由文本错误。未知版本、未知 command 或不符合 schema 的消息返回稳定错误码并关闭连接。

## 5. 状态模型

### 5.1 Service 状态

```ts
type DeviceServicePhase =
  | 'starting'
  | 'running'
  | 'draining'
  | 'stopping'
  | 'stopped'
  | 'degraded'
  | 'failed';
```

状态快照只包含：schemaVersion、phase、pid、startedAt、updatedAt、version、profile counts、activeWorkCount、outboxPendingCount 和稳定 reason code。

状态文件使用同目录临时文件 + `rename` 原子替换。无法写状态文件时 Service 记录固定错误码并继续尝试安全停止，不把任意异常正文写入状态。

### 5.2 Profile 状态

```ts
type ProfileRuntimePhase =
  | 'starting'
  | 'healthy'
  | 'degraded'
  | 'draining'
  | 'stopped'
  | 'failed';
```

对外只暴露顺序编号或 opaque Profile reference，不暴露用户自定义 Profile 原名。单个 Profile 失败使 Service 进入 `degraded`，但不停止健康 sibling。

### 5.3 稳定 reason code

首版至少冻结：

- `SERVICE_READY`
- `SERVICE_ALREADY_RUNNING`
- `SERVICE_NOT_INSTALLED`
- `SERVICE_NOT_RUNNING`
- `SERVICE_CONTROL_UNAVAILABLE`
- `SERVICE_DRAIN_TIMEOUT`
- `SERVICE_STATE_WRITE_FAILED`
- `PROFILE_START_FAILED`
- `PROFILE_DRAIN_FAILED`
- `LAUNCH_AGENT_INSTALL_FAILED`
- `LAUNCH_AGENT_LOAD_FAILED`
- `LAUNCH_AGENT_UNLOAD_FAILED`

CLI 可以基于 code 输出本机恢复建议，但不得直接回显包含秘密或绝对路径的底层异常。

## 6. macOS LaunchAgent 合同

Label 固定为 `com.agentbean.device-service`。Phase 5A 使用用户级 LaunchAgent，不使用 LaunchDaemon、root、sudo 或共享账号。

plist 安装位置：

```text
~/Library/LaunchAgents/com.agentbean.device-service.plist
```

核心属性：

- `ProgramArguments` 指向已解析的绝对可执行文件，并以内部参数 `service run` 启动；
- `RunAtLoad = true`；
- `KeepAlive.SuccessfulExit = false`，只对异常退出重启；
- `ProcessType = Interactive`；
- stdout/stderr 写入 `~/.agentbean/service/logs/`；
- 不在 plist 写 token、Team/Profile 标识、模型凭证或完整环境。

操作顺序：

- `install`：校验当前平台 → 原子写 plist → `launchctl bootstrap gui/$UID` → 等待 control socket ready。
- `start`：`launchctl kickstart -k gui/$UID/com.agentbean.device-service` → 等待 ready。
- `stop`：先经 control socket `begin-drain`，完成后 `shutdown`；超时才调用 `launchctl kill SIGTERM`，不得先 bootout。
- `restart`：完成 stop 后 kickstart，不允许两个 Service Host 并存。
- `uninstall`：先 stop → `launchctl bootout` → 删除 plist 和 Service payload；保留 `~/.agentbean/teams`、machine-id、outbox、Workspace 与 Local Memory。

所有 `launchctl` 调用使用 argv 数组，不经过 shell；Label、UID 和路径均由本地可信输入构造。

## 7. 两阶段排空

1. Service Host 原子切换到 `draining`，停止接受新 Profile 启动和新本地控制变更。
2. 并发通知所有 Profile Runner `beginDrain(deadline)`。
3. 每个 Runner 停止接收新 Dispatch/Claim，等待活动执行在 deadline 内完成，并 flush dispatch outbox 与 management outbox。
4. 已完成的 Runner 执行 `stop()`；失败或超时记录稳定 reason code。
5. deadline 到达后 Service 进入 `stopping`，停止剩余 Runner 并退出非零，交给 launchd 按异常退出策略处理。
6. 全部完成时写 `stopped` 快照并正常退出；正常 stop 不触发 KeepAlive 重启。

重复 `begin-drain`、`shutdown` 和操作端重试必须幂等。`status` 在排空期间仍可用。

## 8. 旧 Daemon 迁移

Phase 5A 只实现安全的宿主所有权交接，不在此阶段迁移到系统凭证库。

- `agentbean device migrate plan` 检查保存 Profile、旧进程、目标 plist、Service 状态和数据目录可写性，不修改状态。
- `migrate start` 只有在用户显式调用时执行。
- commit 前：写 migration journal、安装但不启动接单、验证 Service Host 可启动到 migration-only healthy；失败则恢复旧前台运行方式。
- commit：持久化 `owner=device-service`，启动正式 Runner；从此不再自动恢复 Legacy Daemon。
- commit 后：旧 npm 命令变为兼容 shim，输出迁移后的 `agentbean device status/logs` 指引，不再启动第二个 runtime。
- Workspace、Local Memory、machine-id、outbox 与现有 auth 文件原地复用；scan cache 可以重建。

第一实现 PR 不需要完成完整 migration command，但必须预留 migration owner 检查，防止 Service 与旧 `--all-profiles` 同时运行。

## 9. CLI 行为

`agentbean device` 是操作入口；所有命令支持稳定退出码：

- `0`：目标状态已经达到或操作成功；
- `2`：用户输入错误；
- `3`：未安装或未运行；
- `4`：操作被当前生命周期状态拒绝；
- `5`：平台操作失败；
- `6`：排空超时或恢复失败。

`status --json` 输出稳定 schema；默认文本适合人读。`logs` 只定位或 tail AgentBean 自有本地日志。Web 页面只能复制这些本机命令，不调用 control socket。

## 10. 交付切片

### Slice 1：Service Host 与控制协议

- 新增单实例锁、原子状态存储、本地 Unix socket 和稳定 schema。
- 把现有单 Profile runtime 封装成可停止 `ProfileRunner`。
- 信号触发两阶段 drain；测试启动顺序、幂等停止、sibling 隔离和超时。

### Slice 2：统一 Device CLI 与 macOS adapter

- 新增 `agentbean device run/status/start/stop/restart/logs`。
- 生成并校验 LaunchAgent plist；实现 bootstrap/kickstart/bootout adapter。
- 使用 fake `launchctl` 做合同测试，并在 macOS 普通用户会话做无安装副作用 smoke。

### Slice 3：安装、卸载与数据保留

- 实现原子 plist/payload 安装和幂等卸载。
- 验证普通卸载不删除 Profile、Memory、Workspace、machine-id 或 outbox。
- 旧 `agentbean-next-daemon` 保持可用，尚未迁移时不改变行为。

### Slice 4：Legacy 显式迁移与兼容 shim

- 实现 plan/journal/migration-only health/commit owner fencing。
- commit 前故障恢复 Legacy；commit 后只恢复 Device Service。
- 旧命令在 commit 后拒绝启动第二实例并给出新 CLI 指引。

### Slice 5：macOS E2E 与发布准备

- 普通用户 LaunchAgent install/start/status/restart/stop/uninstall E2E。
- 进程崩溃、控制 socket 丢失、Profile 启动失败和 drain timeout 故障注入。
- 匹配的 Vitest 与 `npm run build:daemon-next` Green。

## 11. 验收矩阵

| 场景 | 必须结果 |
| --- | --- |
| 重复启动 | 只有一个 Service Host；返回 `SERVICE_ALREADY_RUNNING` |
| 一个 Profile 启动失败 | sibling 继续运行，Service 为 `degraded` |
| 正常 stop | 停止接单、活动工作完成、outbox flush、正常退出 |
| drain 超时 | 固定 reason code、非零退出、无静默丢结果 |
| SIGTERM | 进入同一 drain 路径，不绕过 flush |
| control socket 非当前用户 | 拒绝连接，不泄漏状态 |
| plist 重复 install | 幂等，内容与权限保持一致 |
| 普通 uninstall | plist/payload 删除，用户数据完整保留 |
| migration commit 前崩溃 | Legacy 可恢复，不产生双活 |
| migration commit 后崩溃 | 只恢复 Device Service，Legacy 被 fencing |

## 12. 完成定义

Phase 5A 实现完成需要：

- macOS 普通用户可以通过统一 CLI 安装和管理长期运行的 Device Service；
- 终端关闭后 Service 继续运行，登录后自动启动；
- 旧 Daemon 的现有 Profile 和本地数据可显式原地交接；
- 正常停止和迁移不会静默丢失活动结果或 durable outbox；
- 旧命令不会在迁移后启动第二个 runtime；
- 定向 Vitest、`npm run build:daemon-next` 和 macOS 生命周期 smoke 全绿；
- Linux/Windows 与 Release Hardening 项保持 Open，但不阻塞上述结论。
