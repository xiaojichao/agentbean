# PI Management Runtime 后端实战指南

本目录是面向 `@agentbean/pi-management-runtime`（`packages/pi-management-runtime/`）的实战编码指南。读者=未来接手的 AI agent 与新成员。所有规则均以真实源码路径与符号为锚，命令可直接复制运行。

## 这个包是什么

PI Management Runtime Adapter 是一层**薄边界层**：把上游 PI SDK（`@earendil-works/pi-ai` + `@earendil-works/pi-coding-agent`）包在 AgentBean 自有的 `ManagementSession` / `ManagementModelAdapter` / `ManagementToolExecutor` 接口背后，使仓库其余部分（`server-next`、`daemon-next`）从不直接 import SDK 类型。

它**不是**编排内核，**不是**命令 handler 所在。实际工具 handler 由调用方通过 `ManagementToolExecutor` 注入（`packages/pi-management-runtime/src/types.ts:358`）。EffectIdentity / offer / attestation / relinquishment / manifest-fencing 这些概念**不在本包**——它们住在 `@agentbean/contracts` 与 `apps/server-next`。

## 文档导航

| 文档 | 一句话摘要 |
|---|---|
| [architecture.md](./architecture.md) | 薄 adapter 角色、8 个源文件职责、factory/session/model-adapter/tool-executor/catalog 五大抽象与阶段工具名数组。 |
| [import-boundary.md](./import-boundary.md) | `public-api.test.ts` 声明式强制：发布产物只许 3 个 `.d.ts`、SDK 符号零泄漏，附允许泄漏的白名单。 |
| [conventions-and-gotchas.md](./conventions-and-gotchas.md) | allowlist 两次强制、工具名点号↔下划线 wire 映射、影子模式只拦 write、上下文深冻结、阶段由 `managementPhase` 选、Phase-1 schema 空对象门控。 |
| [testing.md](./testing.md) | vitest node 风格、代表测试 `tool-boundary.test.ts` / `public-api.test.ts`、根级 `npm run test:pi-management-runtime` 命令。 |

## 快速事实

- 包名与版本：`@agentbean/pi-management-runtime`，见 `packages/pi-management-runtime/package.json:2`。
- 模块系统：ESM（`"type": "module"`），Node `>=22.19.0`（`package.json:6-8`）。
- 直接依赖：`@agentbean/contracts`、`@earendil-works/pi-ai`、`@earendil-works/pi-coding-agent`（`package.json:28-32`）。
- 公共入口：`src/index.ts` 是唯一的公共桶；发布产物只含 3 个 `.d.ts`（`index`/`openai-compatible-management-model-adapter`/`types`，见 `package.json:17-22` 与 `tests/public-api.test.ts:42-46`）。
- 消费者：`apps/server-next`（`apps/server-next/package.json:25`，`file:` 协议本地依赖）、`apps/daemon-next`（`apps/daemon-next/package.json:29`，固定版本 `0.1.3`）。

## 通用规则（适用本目录全部文档）

1. **改本包先读 `import-boundary.md`**：任何让 SDK 符号泄漏到 3 个公共 `.d.ts` 的改动都会被 `public-api.test.ts` 拒绝。
2. **加工具先读 `conventions-and-gotchas.md`**：工具名要进 `MANAGEMENT_TOOL_NAMES` + 对应 `PHASE_*` 数组 + `toolPolicy` 三处，缺一会被 allowlist 测试挡下。
3. **声明全绿前跑完整 `npm run test:pi-management-runtime`**，不要只跑子集——边界泄漏只在编译 `.d.ts` 后断言，单测绿不代表边界绿。

## 相关 ADR（决策真相源）

本包是 PI 编排的**运行时 adapter**，其边界与职责由以下 ADR 治理：

- `docs/adr/0032-mvp-supports-only-server-hosted-pi-coordination.md` — PI 协调由 server 托管（本包被 server/daemon 注入执行）
- `docs/adr/0034-mvp-provider-protocol-is-openai-compatible-chat-completions.md` — provider 协议 OpenAI 兼容（对应 `openai-compatible-management-model-adapter`）
- `docs/adr/0022-pi-treats-agents-as-contractual-black-boxes.md` — agent 作为契约黑盒
- `docs/adr/0029-runtime-profiles-have-three-fixed-responsibility-slots.md` — runtime profile 三槽（对应 `PHASE_1/2/3_MANAGEMENT_TOOL_NAMES`）
- `docs/adr/0001-pi-manager-is-default-channel-coordinator.md` — PI Manager 默认协调者
