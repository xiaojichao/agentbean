# 第十四切片实现状态

本文记录 AgentBean Next 第十四切片当前已经落地的 daemon builtin scanner 边界。

## 契约对齐提醒

本文的已实现列表记录当前代码状态。其中“installed runtime 会生成 `executor-hosted` agent report”已被标记为契约偏差：已确认目标是 builtin scanner 只产出 runtime capability，不自动生成 visible product agent。后续接手建议见 `docs/contract-alignment-handoff.md`。

## 已实现

- `apps/daemon-next`
  - 增加 `scanner` module。
  - `scanBuiltinRuntimeAgents` 会扫描 known CLI runtimes：Claude Code、Codex CLI、Gemini CLI。
  - Runtime report 会包含 `adapterKind`、`name`、`command`、`cwd` 与 `installed`。
  - 只有 installed runtime 会生成 `executor-hosted` agent report。
  - 增加 `createBuiltinScanProvider`，可直接作为 daemon protocol client 的 `scan` provider 注入。
  - `DaemonRuntimeReport` 支持 `installed`，与 server-next `device:runtimes` input 对齐。

## 已验证

覆盖范围：

- Scanner 可以用 fake executable resolver 稳定发现 installed 与 missing runtimes。
- Missing runtime 只生成 offline runtime report，不生成 agent report。
- Builtin scan provider wrapper 可以作为 protocol rescan injection 使用。
- 既有 daemon-next protocol tests 继续通过。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第十四切片：

- Daemon-next CLI 入口与 Socket.IO runtime wiring。
- AgentOS gateway scanner。
- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。
