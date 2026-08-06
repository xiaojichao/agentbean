# 架构与入口分发

## 何时适用

改动入口分发（`src/bin.ts`）、新增 bin 别名、调整 socket 管线、动 LaunchAgent 装载/卸载、重组 `src/` 文件集群。

## 入口分发

两个 bin 别名 `agentbean` 与 `agentbean-next-daemon` 都指向 `./dist/apps/daemon-next/src/bin.js`（`apps/daemon-next/package.json` 的 `bin` 字段）。`src/bin.ts` 按 argv 第一段分发：

- `device` → `runDeviceCli(argv.slice(1))`（`src/bin.ts:14`，导入自 `src/device-cli.ts:75`）
- `update` → `runUpdateCli(argv.slice(1))`（`src/bin.ts:16`）
- `service run`（即 argv[1]=`run` 的 service 模式）→ `runDeviceCli(['run'])`（`src/bin.ts:18`）
- 其它 → `runDaemonNextCli()`（`src/bin.ts:46`，导入自 `src/cli.ts`，跑 legacy daemon 主循环）

导入见 `src/bin.ts:3-5`。`device` 子命令集见 `src/device-cli.ts:32` 的 `DeviceCliCommand` 联合类型：`'run' | 'connect' | 'install' | 'uninstall' | 'status' | 'start' | 'stop' | 'restart' | 'logs' | 'migrate'`；用法串在 `src/device-cli.ts:80`。

## 本地模式

- **入口只做分发**：所有副作用在对应 `run*Cli` 内。新增子命令时改 `DeviceCliCommand` 联合类型与 `src/device-cli.ts` 内的 switch，不要在 `bin.ts` 加业务分支。
- **bin 别名是部署锚点**：canonical `@agentbean/daemon` 与 `@agentbean/daemon-next` 共用同一 `dist/apps/daemon-next/src/bin.js`，发版脚本把产物复制到 canonical 包（见 [release.md](release.md)）。改 bin 路径会同时影响两个包。

## src 结构

`src/` 扁平约 60 个文件（加 `memory/` 子目录），无深层目录。按职责分集群：

- **executors**：`executor.ts`（pipe 主路径）、`executor-pty.ts`（codex TTY 路径）、`executor-helpers.ts`（子进程 PATH 修复等）。路由细节见 [agent-spawning.md](agent-spawning.md)。
- **device-service 运行时**：`device-service-core.ts` / `device-service-runtime.ts` / `device-service-host.ts` / `device-service-state.ts` / `device-service-paths.ts` / `device-service-filesystem.ts` / `device-service-lock.ts` / `device-service-profile-runner.ts`，加 `device-cli.ts`、`device-platform-service.ts`、`device-runtime-owner.ts`、`legacy-linux-device-service.ts`、`legacy-runtime-registration.ts`。
- **workspace IO**：`workspace-run.ts`、`workspace-publish-delivery.ts` / `workspace-publish-http-client.ts` / `workspace-publish-output.ts` / `workspace-publish-recovery.ts`、`workspace-apply.ts`、`workspace-snapshot.ts`。
- **artifacts**：`artifact-collector.ts`、`artifact-uploader.ts`、`file-reader.ts`、`directory-lister.ts`、`directory-picker.ts`、`attachments.ts`。产出与文件读写见 [artifacts-and-fs.md](artifacts-and-fs.md)。
- **runtime 支持**：`scanner.ts`、`descriptor-scanner.ts`、`skill-scanner.ts`、`executable-paths.ts`、`scan-cache.ts`、`auth-store.ts`、`env-fetcher.ts`、`config.ts`、`profile-paths.ts`、`rescan.ts`。可执行检测见 [runtime-detection.md](runtime-detection.md)。
- **PI worker**：`pi-manager-worker-host.ts`、`management-credential-provider.ts`、`management-durable-outbox.ts`、`management-model-adapter.ts`、`management-worker-protocol.ts`。
- **OS 集成**：`macos-launch-agent.ts`、`machine-id.ts`、`system-info.ts`、`device-migration.ts`、`outbox.ts`。
- **入口/分发**：`bin.ts`、`cli.ts`、`index.ts`、`update-cli.ts`、`device-control-client.ts` / `device-control-protocol.ts` / `device-control-server.ts`。

## 超大文件：index.ts

`src/index.ts` 约 2043 行，是 daemon 的运行时核心：持 socket.io-client 连接、dispatch 事件分发管线、心跳循环。心跳见 `src/index.ts:251-257`（`setInterval` + `socket.emit(AGENT_EVENTS.dispatch.progress, ...)`，`clearInterval` 在 :257）。改这个文件优先考虑拆分到集群文件，不要继续往里堆。

## LaunchAgent（macOS）

- label 常量 `DEVICE_SERVICE_LAUNCH_AGENT_LABEL = 'com.agentbean.device-service'`（`src/macos-launch-agent.ts:12`）。
- plist 路径 `~/Library/LaunchAgents/com.agentbean.device-service.plist`（`src/macos-launch-agent.ts:49`）。
- 装载/卸载走 `bootstrap()`（:29）/ `bootout()`（:32），底层调用 `launchctl bootstrap|kickstart|bootout`。
- Linux 用 `legacy-linux-device-service.ts` 的 systemd 等价路径，**不要**把 macOS 专用逻辑漏进 platform 抽象。

## 佐证文件

- `apps/daemon-next/src/bin.ts:3-5,14,16,18,46`
- `apps/daemon-next/src/device-cli.ts:32,75,80`
- `apps/daemon-next/src/index.ts:251-257`
- `apps/daemon-next/src/macos-launch-agent.ts:12,29,32,49`
- `apps/daemon-next/package.json`（`bin`、`name`、`version`）

## 反模式

- 在 `bin.ts` 写业务逻辑：它只读 argv 第一段再分发，业务逻辑属于对应 `run*Cli`。
- 直接改 `com.agentbean.device-service` label 字符串：已有常量，改 label 会失配已部署设备的 plist。
- 往 `src/index.ts` 继续塞功能而不拆集群文件：它已 2000+ 行，新功能优先落到上述集群文件。

## 验证命令

```bash
# 确认 bin 分发行为
cd apps/daemon-next && grep -nE 'runDeviceCli|runUpdateCli|runDaemonNextCli' src/bin.ts
# 确认 LaunchAgent label 单一来源
grep -n 'DEVICE_SERVICE_LAUNCH_AGENT_LABEL' src/macos-launch-agent.ts
# 确认 index.ts 体量与心跳位置
wc -l src/index.ts && grep -n 'setInterval' src/index.ts
```
