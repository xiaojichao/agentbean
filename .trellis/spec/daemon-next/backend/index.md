# daemon-next 后端编码指南

## 这个包是什么

`@agentbean/daemon-next`（`apps/daemon-next`）是跑在用户机器上的设备端守护进程。职责单一：拉起编码 agent（claude-code / codex / gemini / hermes / openclaw / kimi-cli），把 dispatch 进来的 prompt 喂给 agent，再把产出物与进度通过 `socket.io-client` 桥回 server。它不直接持有业务状态，所有权威数据在 server 侧。

## 运行时要求

- Node **24.x**。依据：根 `.nvmrc` 为 `v24.18.0`；根 `package.json` 的 `engines.node` 为 `24.x`。
- 作为 macOS LaunchAgent 后台服务运行时，`process.env.PATH` 极简（`/usr/bin:/bin:/usr/sbin:/sbin`），详见 [runtime-detection.md](runtime-detection.md)。

## 入口与 bin 别名

两个 bin 别名指向同一产物 `./dist/apps/daemon-next/src/bin.js`（`apps/daemon-next/package.json` 的 `bin` 字段）：`agentbean` 与 `agentbean-next-daemon`。分发逻辑见 [architecture.md](architecture.md)。

## 主题表

| 指南 | 何时读 |
| --- | --- |
| [architecture.md](architecture.md) | 改动入口分发、src 结构、socket 管线、LaunchAgent 装载 |
| [agent-spawning.md](agent-spawning.md) | 新增/修改 agent adapter、动 PTY/pipe 路由、异步审批 |
| [runtime-detection.md](runtime-detection.md) | 动可执行文件发现、PATH 目录、版本管理器扫描 |
| [release.md](release.md) | 发版、bump 版本、动 canonical daemon dist-tag |
| [artifacts-and-fs.md](artifacts-and-fs.md) | 动产出物收集、reported 路径、fs:read 白名单 |
| [testing.md](testing.md) | 写/跑测试、加测试清单 |

## 测试命令

```bash
# 仅跑 daemon-next（根目录）
npm run test:daemon-next

# 纳入全包门禁（必须加 --api.host 127.0.0.1，否则 socket 握手打不开）
npm run test:packages
```

`npm run test:daemon-next` 等价于 `cd apps/daemon-next && ../../node_modules/.bin/vitest run tests --config vitest.config.ts`（根 `package.json` 第 18 行）。`test:packages` 中 daemon-next 段带 `-- --api.host 127.0.0.1`（根 `package.json` 第 20 行）。

## 相关 ADR（决策真相源）

本包约定由以下 ADR 治理（spec 讲"怎么动手"，ADR 讲"为什么"）：

- `docs/adr/0036-user-device-support-is-macos-only.md` / `docs/adr/0037-macos-support-includes-intel-x64.md` — 仅 macOS（含 Intel x64），对应 LaunchAgent 装载
- `docs/adr/0050-device-connect-hands-off-to-user-service.md` — device connect 交接
- `docs/adr/0052-artifact-paths-do-not-determine-delivery-role.md` — 产出物路径不决定交付角色（reported-path 收集中立）
- `docs/adr/0053-artifact-previews-use-asynchronous-derivatives.md` — 预览用异步 derivatives
- `docs/adr/0055-channel-files-use-a-server-owned-index.md` — 频道文件 server-owned 索引（fs:read 白名单对齐 snapshots）
- `docs/adr/0019-agent-skill-coverage-is-runtime-reported-and-time-bounded.md` — agent skill 运行时上报（descriptor-scanner）
