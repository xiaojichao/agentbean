# 第四十切片实现状态

本文记录 AgentBean Next 第四十切片当前已经落地的 preview runtime replay 与 custom agent UI 可用性修复。

## 已实现

- `apps/server-next/src/transport/socket-server.ts`
  - web 端执行 `device:list` 并成功订阅 devices 后，会对返回的每台 device replay 已持久化的 runtimes。
  - 解决 daemon 早于 web 订阅上报 runtimes 时，preview 右侧 Runtime 下拉为空的问题。
- `apps/server-next/src/full-preview.ts`
  - full preview 默认使用稳定 `machineId=agentbean-next-preview:<hostname>`。
  - 解决本地 preview 重启时持续创建重复 device 的问题。
- `apps/web-next/preview/index.html`
  - runtimes 改为按 `deviceId` 分组保存。
  - Custom Agent 的 Runtime 下拉只展示当前 Device 的 runtimes。
  - 如果当前选中的旧 device 没有 runtimes，而另一个 device replay 了 runtimes，preview 会自动切到有 runtime 的 device。
  - Runtime 下拉按 Codex、Claude、Gemini 的 preview 优先级排序，避免默认 `Codex` 名称选到 Gemini runtime。
- `apps/server-next/tests/socket-integration.test.ts`
  - 覆盖 late web subscriber 在 `device:list` 后仍能收到已持久化 runtimes。
- `apps/server-next/tests/full-preview.test.ts`
  - 覆盖 full preview 默认稳定 machine id。
- `apps/web-next/tests/preview-page.test.ts`
  - 覆盖 Runtime options 按选中 device 过滤。
  - 覆盖当前 device 没有 runtimes 时自动切到有 runtime 的 device。
  - 覆盖 preview runtime 排序让 Codex 优先。

## 已验证

本地验证：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/preview-page.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run tests/full-preview.test.ts tests/socket-integration.test.ts --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
```

本地 UI 验证：

- 重新启动 `npm run dev:agentbean-next`。
- in-app browser 打开 `http://127.0.0.1:4100/`。
- 晚订阅 `device:list` 后，Runtime 下拉可见 `Codex CLI`、`Claude Code`、`Gemini CLI`。
- 在 Custom Agent 表单中点击 `创建 Agent` 后，Events 出现 `agent:create: ok`。
- Agents 列表出现 `Codex online · custom`。
- browser console 无 error/warn。

## 暂未实现

这些不属于第四十切片：

- 对真实 `codex` / `claude` / `gemini` CLI 执行一次完整 UI 消息回复验证。
- 清理本机旧 `.agentbean-next` preview 数据中已经存在的重复 device 行。
- production deploy flip。
- production browser smoke。
