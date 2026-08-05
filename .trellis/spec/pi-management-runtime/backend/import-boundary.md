# 导入边界：SDK 符号零泄漏

## 何时适用

- 修改 `index.ts`、`types.ts`、`openai-compatible-management-model-adapter.ts`（这 3 个文件的类型会进发布的 `.d.ts`）。
- 在 `pi-session-adapter.ts` / `management-tool-catalog.ts` 里新增对 `@earendil-works/*` 的 import。
- 新增源文件，拿不准要不要把它加进 `index.ts` 的重新导出。
- review 本包 PR 时，判断一个类型是不是「泄漏」。

## 本地模式：声明式强制的 3 道闸门

边界**不是靠口头约定，而是靠测试编译后断言**。`tests/public-api.test.ts` 是唯一权威，它设了 3 道闸门：

### 闸门 1：编译必须过
先 `tsc -p tsconfig.json`，构建失败直接红（`tests/public-api.test.ts:12-16`）。

### 闸门 2：3 个公共 `.d.ts` 不能出现 SDK 符号
读取 `dist/index.d.ts`、`dist/openai-compatible-management-model-adapter.d.ts`、`dist/types.d.ts` 拼接后，**不允许**匹配以下正则（`tests/public-api.test.ts:18-25`）：

```
/@earendil-works|AgentSession|DefaultResourceLoader|AuthStorage|ModelRegistry|createCodingTools/
```

这意味着：哪怕是 `import type { AgentSession } from '@earendil-works/...'` 放在 `types.ts`，只要类型被公开导出，`.d.ts` 就会带这个名字，测试就红。**所以 SDK 类型只能在 `pi-session-adapter.ts` / `management-tool-catalog.ts` / `management-resource-loader.ts` / `provider-adapter.ts` / `sea-smoke-entry.ts` 这些不发布 `.d.ts` 的内部文件里出现。**

### 闸门 3：`npm pack` 只许 3 个 `.d.ts`
`npm pack --dry-run --json` 的产物里，`.d.ts` 文件必须**恰好**是这 3 个，顺序与内容精确匹配（`tests/public-api.test.ts:32-46`）：

```
dist/index.d.ts
dist/openai-compatible-management-model-adapter.d.ts
dist/types.d.ts
```

这由 `package.json:17-22` 的 `files` 字段声明（`dist/**/*.js` + 上述 3 个 `.d.ts`）。`management-tool-catalog.d.ts`、`pi-session-adapter.d.ts`、`provider-adapter.d.ts`、`management-resource-loader.d.ts`、`sea-smoke-entry.d.ts` **不会进包**——所以它们内部用 SDK 类型是安全的。

### 反向闸门：外部根本 import 不到 SDK 类型
`tests/fixtures/raw-pi-import.ts` 只有一行 `import { AgentSession } from '../../dist/index.js'`（`tests/fixtures/raw-pi-import.ts:1-3`）。测试用独立 `tsc --noEmit` 编译它，期望**失败**且报错匹配 `has no exported member 'AgentSession'`（`tests/public-api.test.ts:48-61`）。这保证消费方就算想绕过也绕不过——`AgentSession` 压根没从 `index.js` 导出。

## 允许泄漏的符号白名单

测试同时做**正向断言**，以下符号是**允许且预期**出现在公共 `.d.ts` 里的（`tests/public-api.test.ts:26-30`）：

| 符号 | 来源文件 | 含义 |
|---|---|---|
| `ManagementSessionContextV1` | `types.ts:137` | V1 上下文，消费方需用它构造 session |
| `ManagementModelTelemetry` | `types.ts:244` | telemetry 事件载荷，消费方订阅事件时要用 |
| `PHASE_1_MANAGEMENT_TOOL_NAMES` | `types.ts:290` | 阶段工具名数组，消费方（如 `daemon-next`）按阶段裁剪工具面 |
| `createOpenAiCompatibleManagementModelAdapter` | `openai-compatible-management-model-adapter.ts:51` | 唯一官方 LLM adapter 工厂 |
| `ManagementModelAdapterErrorCode` | `openai-compatible-management-model-adapter.ts:9` | adapter 错误码字面量联合，消费方 catch 时要判别 |

（`index.ts:1-50` 重新导出的完整清单也以此为边界：`createManagementRuntimeFactory`、`ManagementModelAdapterError`、`toProviderSafeToolName`、全部 `PHASE_*` 常量、以及一大票 `Management*` 类型。新增导出前先问：它会不会把 SDK 符号带进 `.d.ts`？）

## 为什么仓库其余部分永不直接 import SDK

1. **SDK 是可变上游**：`@earendil-works/pi-ai` / `pi-coding-agent` 版本随 PI 能力演进而 breaking（当前 `0.80.6`，`package.json:30-32`）。把 SDK 类型锁在 adapter 里，升级时只改本包一处。
2. **消费方多入口**：`server-next`（`apps/server-next/package.json:25` 用 `file:` 本地依赖）与 `daemon-next`（`apps/daemon-next/package.json:29` 固定 `0.1.3`）接线方式不同，但都只依赖本包的稳定接口。
3. **运行时注入而非类型耦合**：handler 通过 `ManagementToolExecutor` 注入（`types.ts:358`），模型通过 `ManagementModelAdapter` 注入（`types.ts:254`）——本包对「具体怎么执行工具、调哪个模型」一无所知，自然不该把 SDK 的 `AgentSession` 暴露给消费方。

## 佐证文件

- 声明式边界测试：`packages/pi-management-runtime/tests/public-api.test.ts`
- 反向夹具：`packages/pi-management-runtime/tests/fixtures/raw-pi-import.ts`
- 发布文件清单：`packages/pi-management-runtime/package.json:17-22`
- 公共桶：`packages/pi-management-runtime/src/index.ts:1-50`
- 内部文件用 SDK 的合法样例：`src/pi-session-adapter.ts:1-16`（import `AgentSession`/`AuthStorage`/`ModelRegistry` 等）、`src/management-tool-catalog.ts:2-9`（import `Type`/`defineTool`/contracts parser）

## 反模式

- **在 `types.ts` 里 `import type { AgentSession }`**。即使只做类型，发布 `types.d.ts` 也会带 `AgentSession` 字样 → 闸门 2 红。
- **把 `pi-session-adapter.ts` 加进 `index.ts` 重新导出**。它内部 import 了 `AgentSession`/`AuthStorage`/`ModelRegistry`，导出它就泄漏全部 SDK 符号。
- **用 `export *` 从内部文件转发**。会把内部符号连同 SDK 依赖一起带进公共面。`index.ts` 用的是逐项 `export { ... }` / `export type { ... }`（`src/index.ts:1-50`），照此办理。
- **改 `package.json` 的 `files` 字段多塞 `.d.ts`**。闸门 3 会精确比对只许 3 个，多塞直接红。
- **以为「vitest 绿就等于边界绿」**。闸门 1 先 `tsc` 编译，闸门 2/3 在编译成功后才断言 `.d.ts`——本地若跳过 build 不会有 `dist/`，测试会因读不到 `.d.ts` 而红（不是绿）。

## 验证命令

```bash
# 完整边界测试（含编译 + .d.ts 断言 + npm pack 断言 + 反向夹具）
cd /Users/shaw/AgentBean && npm run test:pi-management-runtime -- -- test:pi-management-runtime 2>/dev/null || \
  (cd packages/pi-management-runtime && ../../node_modules/.bin/vitest run tests/public-api.test.ts --config vitest.config.ts --api.host 127.0.0.1)

# 单独验证「外部 import 不到 AgentSession」
cd /Users/shaw/AgentBean/packages/pi-management-runtime && \
  ../../node_modules/.bin/tsc --noEmit --module NodeNext --moduleResolution NodeNext --target ES2022 --strict --skipLibCheck tests/fixtures/raw-pi-import.ts
# 期望：报错 "has no exported member 'AgentSession'"

# 检查发布物里 .d.ts 数量
cd /Users/shaw/AgentBean/packages/pi-management-runtime && npm pack --dry-run --json --ignore-scripts 2>/dev/null | grep '\.d\.ts'
# 期望恰好 3 行：index / openai-compatible-management-model-adapter / types
```
