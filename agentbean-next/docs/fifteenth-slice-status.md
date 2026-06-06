# 第十五切片实现状态

本文记录 AgentBean Next 第十五切片当前已经落地的 Agent public contract alignment 边界。

## 契约对齐状态

第十四切片确认 builtin scanner 只产出 runtime capability，不自动生成 visible product agent。第十五切片先把 public Agent contract 与文档收口，避免后续 custom agent 创建/绑定流程继续扩散旧命名。

## 已实现

- `packages/contracts`
  - 增加可运行时验证的 `ADAPTER_KINDS`、`AGENT_CATEGORIES`、`AGENT_SOURCES` 与 `AGENT_STATUSES`。
  - `AgentSource` 统一为 `custom`、`self-register`、`scanned`。
  - `AgentCategory` 统一为 `executor-hosted`、`agentos-hosted`。
  - `AgentStatus` 统一为 `connecting`、`online`、`busy`、`offline`、`error`。
  - `AgentDto` 补齐 custom agent 所需的 owner、command、args、cwd、envKeys 与 lastError public fields。
  - `DiscoveredAgentDto` 改为 daemon/gateway report input，不再要求 persisted id 或 discoveredAt。
  - `RuntimeDto` 不再暴露派生 `status`，runtime availability 由 `installed` 与 capability fields 表达。
- `packages/domain`
  - Message routing 接受新的 agent status 集合，但仍只会 dispatch 给 `online` agent。
- `apps/server-next`
  - Runtime mapper 与 SQLite repository 不再向 public `RuntimeDto` 注入 runtime status。

## 已验证

覆盖范围：

- Contract tests 会验证 Agent public constants 与 custom/self-register fixtures。
- Full phase tests 继续覆盖 contracts、domain、server-next、daemon-next 与 web-next。
- Build 覆盖所有 packages/apps 的 TypeScript 输出。

本地命令：

```bash
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ../../node_modules/.bin/vitest run --config vitest.config.ts --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH ./node_modules/.bin/vitest run packages/contracts/tests packages/domain/tests apps/server-next/tests apps/daemon-next/tests apps/web-next/tests --environment node --api.host 127.0.0.1
PATH=/Users/shaw/.nvm/versions/node/v24.15.0/bin:$PATH npm run build:packages
```

## 暂未实现

这些不属于第十五切片：

- `agent:create` custom agent 创建/绑定 use case。
- Custom agent raw env 的持久化与 dispatch-only secret transport。
- Daemon-next CLI 入口与 Socket.IO runtime wiring。
- Web-next custom agent 创建 UI。
