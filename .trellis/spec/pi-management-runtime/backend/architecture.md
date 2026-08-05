# 架构：薄 adapter，包住上游 SDK

## 何时适用

- 在本包新增/修改源文件、调整公共接口、或把更多上游 SDK 能力暴露给 AgentBean 时。
- 判断「某段逻辑该写在本包还是写在 `server-next`/`daemon-next`」时。

## 本地模式：薄边界层，handler 注入

本包的全部价值是**隔离**：上游 `@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent` 的类型与运行时（`AgentSession`、`AuthStorage`、`ModelRegistry`、`createAgentSession`、`createAssistantMessageEventStream` 等）只允许在 `src/pi-session-adapter.ts` 与 `src/management-tool-catalog.ts` 内部出现。仓库其余部分拿到的是本包重定义的 `ManagementSession` / `ManagementModelAdapter` / `ManagementToolExecutor` 接口（`src/types.ts:67`、`src/types.ts:254`、`src/types.ts:358`）。

关键设计：**工具 handler 不在本包**。本包只负责把工具调用转发给调用方注入的 `ManagementToolExecutor`（`src/types.ts:358` 的 `(call: ManagementToolCall) => Promise<ManagementToolResult>`）。`server-next` 的命令 handler 在创建 factory 时注入（见 `apps/server-next/src/application/capability-summarizer.ts:23`、`apps/server-next/src/application/channel-coordination-coordinator.ts:20` 等的 import）。

运行时模型同理：调用方注入 `ManagementModelAdapter`（`src/types.ts:254`），本包提供唯一的官方实现 `createOpenAiCompatibleManagementModelAdapter`（`src/openai-compatible-management-model-adapter.ts:51`），把 OpenAI 兼容的 Chat Completions 端点适配成该接口。

## 源文件结构（8 个，扁平）

`packages/pi-management-runtime/src/` 共 8 个 `.ts`，无子目录：

| 文件 | 职责 | 关键导出/符号 |
|---|---|---|
| `index.ts` | 唯一公共桶，重新导出公共 API | 见 `src/index.ts:1-50` |
| `types.ts` | 全部领域类型 + 工具名常量 + executor 类型 | `ManagementSession`(`:67`)、`ManagementModelAdapter`(`:254`)、`ManagementToolExecutor`(`:358`)、`MANAGEMENT_TOOL_NAMES`(`:259`)、`PHASE_1/2/3_MANAGEMENT_TOOL_NAMES`(`:290/:304/:325`) |
| `pi-session-adapter.ts` | factory + session 实现，唯一深度依赖 SDK 的文件 | `createManagementRuntimeFactory`(`:471`)、`PiManagementRuntimeFactory`(`:380`)、`PiManagementSession`(`:309`)、`cloneAndFreeze`(`:51`) |
| `management-tool-catalog.ts` | 工具定义/schema/影子模式 gate | `createManagementToolCatalog`(`:261`)、`assertExactManagementToolAllowlist`(`:67`)、`getManagementToolMetadata`(`:57`)、`toolPolicy`(`:23-55`) |
| `openai-compatible-management-model-adapter.ts` | OpenAI 兼容 LLM adapter 实现 + 工具名 wire 映射 | `createOpenAiCompatibleManagementModelAdapter`(`:51`)、`toProviderSafeToolName`(`:147`)、`ManagementModelAdapterError`(`:22`) |
| `provider-adapter.ts` | 响应归一化、telemetry、stop reason 映射 | `normalizeManagementModelResponse`(`:59`)、`safeProviderFailureTelemetry`(`:104`)、`toPiStopReason`(`:121`) |
| `management-resource-loader.ts` | stub：禁用 SDK 的扩展/技能加载，只回系统提示 | `createManagementResourceLoader`(`:3`)，所有方法返回空数组 |
| `sea-smoke-entry.ts` | SEA 单文件烟雾二进制入口（CI 用） | `runSmoke`(`:12`)，`__AGENTBEAN_PI_VERSION__` 由 `scripts/build-pi-management-sea.mjs:164` 注入 |

## 五大核心抽象

### 1. Factory：`ManagementRuntimeFactory`
- 接口：`createSession(input): Promise<ManagementSession>`（`src/types.ts:170-172`）。
- 唯一实现：`PiManagementRuntimeFactory`（`src/pi-session-adapter.ts:380`），由导出函数 `createManagementRuntimeFactory`（`:471`）构造，入参为 `CreateManagementRuntimeFactoryInput { model, toolExecutor }`（`src/types.ts:360-363`）。
- 创建会话时做 5 件事（`src/pi-session-adapter.ts:383-468`）：① 校验系统提示与 context（`:384-388`，失败抛 `P0_SYSTEM_PROMPT_INVALID` / `P1_SESSION_CONTEXT_INVALID`）；② 深冻结 context（`:390`）；③ 按 `managementPhase` 选工具名数组（`:391-395`）；④ 在内存里注册一次性 provider（`:396-424`，`AuthStorage.inMemory()` + `ModelRegistry.inMemory()`，`baseUrl: 'http://agentbean.invalid'`）；⑤ 注册后再断言一次有效工具与 allowlist 完全一致（`:458`）。

### 2. Session：`ManagementSession` / `PiManagementSession`
- 接口 6 方法：`prompt` / `steer` / `followUp` / `compact` / `abort` / `waitForIdle` / `subscribe` / `dispose`（`src/types.ts:67-76`）。
- 实现 `PiManagementSession`（`src/pi-session-adapter.ts:309`）把调用委托给内部 `AgentSession`，事件经 `normalizeEvent`（`:242`）转成 `ManagementRuntimeEvent`（`src/types.ts:29-65`）。
- `dispose` 幂等：用 `disposePromise ??=` 缓存（`:365`），先 `abort` 再 `dispose` 再 `cleanup`（注销 provider）。

### 3. ModelAdapter：`ManagementModelAdapter`
- 接口：`id` + `respond(request, state): Promise<ManagementModelResponse>`（`src/types.ts:254-257`）。
- 官方实现：`createOpenAiCompatibleManagementModelAdapter`（`src/openai-compatible-management-model-adapter.ts:51`），封装 OpenAI 兼容 Chat Completions，带超时/中止/错误码（`ManagementModelAdapterErrorCode` `:9-20`）。

### 4. ToolExecutor：`ManagementToolExecutor`
- 类型别名：`(call: ManagementToolCall) => Promise<ManagementToolResult>`（`src/types.ts:358`）。
- 本包**不实现**任何 handler，全靠调用方注入。catalog 在 `execute` 里校验完 schema 后转发给 executor（`src/management-tool-catalog.ts:291-298`）。

### 5. Catalog + 阶段工具名
- 工具策略表 `toolPolicy`（`src/management-tool-catalog.ts:23-55`）映射每个工具名 → `{ effect: 'read'|'write', phase: 1|2|3 }`。
- `createManagementToolCatalog`（`:261`）把工具名数组转成 SDK 的 `ToolDefinition[]`，是工具暴露给模型的唯一构造点。
- 阶段工具名数组（`src/types.ts`）：
  - `MANAGEMENT_TOOL_NAMES`（`:259`）= 28 个全集。
  - `PHASE_1_MANAGEMENT_TOOL_NAMES`（`:290`）= 11 个（context 4 + agents 4 + channel/user/review 各 1）。
  - `PHASE_2_MANAGEMENT_TOOL_NAMES`（`:304`）= 24 个（P1 + 13 个 task/handoff）。
  - `PHASE_3_MANAGEMENT_TOOL_NAMES`（`:325`）= 28 个（P2 + 4 个 memory）。

## 佐证文件

- 接口与常量：`packages/pi-management-runtime/src/types.ts`
- Factory/Session 实现：`packages/pi-management-runtime/src/pi-session-adapter.ts`
- 工具目录：`packages/pi-management-runtime/src/management-tool-catalog.ts`
- LLM adapter：`packages/pi-management-runtime/src/openai-compatible-management-model-adapter.ts`
- 公共桶：`packages/pi-management-runtime/src/index.ts`
- 消费方接线示例：`apps/server-next/src/application/capability-summarizer.ts:23`、`apps/daemon-next/src/pi-manager-worker-host.ts:11`

## 反模式

- **把 handler 逻辑写进本包**。本包是 adapter，handler 属于 `server-next`/`daemon-next`。正确做法：定义 `ManagementToolExecutor` 并在创建 factory 时注入（`src/types.ts:358`、`src/pi-session-adapter.ts:431-432`）。
- **新增「第 9 个」源文件并让它出现在公共桶**。公共 `.d.ts` 只能是 3 个（见 `import-boundary.md`）。新内部文件不应被 `index.ts` 重新导出。
- **在 `management-resource-loader.ts` 里接真扩展/技能加载**。当前是 stub（`src/management-resource-loader.ts:10-20` 全返回空），改它会破坏「PI 会话只回系统提示、无外部技能」的隔离前提。
- **绕过 factory 直接构造 `PiManagementSession`**。类未导出（只在 `pi-session-adapter.ts:309` 定义，未进 `index.ts`），正确入口只有 `createManagementRuntimeFactory`。

## 验证命令

```bash
# 编译 + 全部测试（边界测试会先 tsc 编译再断言 .d.ts）
cd /Users/shaw/AgentBean && npm run test:pi-management-runtime

# 只看类型是否通过
cd /Users/shaw/AgentBean/packages/pi-management-runtime && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit

# 确认公共桶只重新导出预期符号
cd /Users/shaw/AgentBean && grep -n "^export" packages/pi-management-runtime/src/index.ts
```
