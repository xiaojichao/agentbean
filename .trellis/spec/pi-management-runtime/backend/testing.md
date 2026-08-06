# 测试：vitest node，边界测试是核心

## 何时适用

- 给本包写新测试、改现有测试。
- 判断「这个改动要不要跑边界测试」「该用哪种断言风格」。
- 本地复现 CI 红。

## 本地模式

### 运行器与配置
- 运行器：vitest，`environment: 'node'`，`include: ['tests/**/*.test.ts']`（`packages/pi-management-runtime/vitest.config.ts:1-8`）。
- 测试目录扁平：`tests/*.test.ts` + `tests/fixtures/`（反向 import 夹具）+ `tests/__snapshots__/`。
- 既有测试文件（5 个）：
  - `tests/public-api.test.ts`——导入边界（详见 `import-boundary.md`）。
  - `tests/tool-boundary.test.ts`——工具 allowlist / 影子 dry-run / 阶段 schema / Phase-2/3 校验（最大，约 800 行，`describe` 在 `:95`、`:697`、`:770`）。
  - `tests/pi-session-adapter.test.ts`——factory/session 行为。
  - `tests/openai-compatible-management-model-adapter.test.ts`——LLM adapter + wire 映射。
  - `tests/resource-loader.test.ts`——stub loader 行为。

### 代表测试：`tool-boundary.test.ts`
这是改动工具面时**必看**的测试。三个 `describe` 块：

1. `describe('management tool boundary', ...)`（`:95`）：18+ 用例覆盖
   - allowlist 冻结（`:96 'keeps the runtime tool surface identical to the Worker wire contract'`、`:363 'freezes the complete management tool allowlist'`）。
   - 阶段工具暴露（`:100` Phase-1 = 11、`:139` Phase-2 = 24、`:195` Phase-3 = 28）。
   - 影子模式（`:322 'records shadow write intent hashes without calling the real executor or exposing arguments'`）。
   - executor 前校验（`:422 'rejects Phase 2 tool calls before invoking the executor'`、`:451 'validates Phase 2 Task input before invoking the executor'`）。
   - effect/phase/schema 元数据冻结（`:418`）。
   - Skill 输入与 batch edges 透传（`:512`、`:587`，对应 #711/#954）。
2. `describe('Phase 3 Memory tool definitions', ...)`（`:697`）：Memory 工具 schema 与执行前 parser。
3. `describe('issue #719 AC#2 — PI inferences can only enter memory as Candidates', ...)`（`:770`）：断言不存在「直接创建 formal memory」工具——PI 写 memory 必须经 Candidate。

### 代表测试：`public-api.test.ts`
导入边界的唯一裁判（详见 `import-boundary.md`）。它**会触发一次完整 `tsc` 编译**（`tests/public-api.test.ts:12-16`），所以比其他测试慢；本地若没有写权限或 `dist/` 残旧可能误报。改公共 API 必跑。

### 反向夹具
`tests/fixtures/raw-pi-import.ts`（仅 3 行，`import { AgentSession } from '../../dist/index.js'`）被 `public-api.test.ts:48-61` 用独立 `tsc --noEmit` 编译，期望失败报 `has no exported member 'AgentSession'`。这是「外部拿不到 SDK 类型」的机器化保证。

## 风格约定

- 用 `describe`/`it`，断言用 vitest 的 `expect`（全仓一致）。
- 测试「executor 被不被调」用 spy/计数器（如 `tool-boundary.test.ts:322` 的影子测试断言 executor 零调用）。
- 测试「工具暴露面」直接读 `request.tools.map(t => t.name)`（与 `sea-smoke-entry.ts:27` 同手法）。
- 涉及 schema 的测试用 `getManagementToolMetadata`（`src/management-tool-catalog.ts:57`）拿 effect/phase，别硬编码。

## 佐证文件

- vitest 配置：`packages/pi-management-runtime/vitest.config.ts`
- 根级脚本：`package.json:15`（`test:pi-management-runtime`）、`package.json:20`（`test:packages` 把本包纳入）、`package.json:24-26`（`test:phase0/phase1/phase2` 均依赖本包测试先绿）
- 边界测试：`packages/pi-management-runtime/tests/public-api.test.ts`
- 工具边界测试：`packages/pi-management-runtime/tests/tool-boundary.test.ts`
- 反向夹具：`packages/pi-management-runtime/tests/fixtures/raw-pi-import.ts`
- SEA 烟雾二进制：`packages/pi-management-runtime/src/sea-smoke-entry.ts`（由 `scripts/build-pi-management-sea.mjs:155` 打包，`scripts/check-pi-management-sea.mjs:18` 验签）

## 反模式

- **只跑单文件就声明全绿**。`public-api.test.ts` 编译 `.d.ts` 才能跑；改了 `index.ts`/`types.ts` 必须跑它。声明全绿前跑完整 `test:pi-management-runtime`，不要只跑子集。
- **改了 SDK 依赖版本后不重跑全部测试**。`@earendil-works/*` 升级可能让 `.d.ts` 多带符号 → 边界测试红，而单测可能仍绿。
- **在测试里直接 import `@earendil-works/*`**。测试文件本身可以（不进发布），但若你写的是「消费方视角」的测试，应只 import `@agentbean/pi-management-runtime`，否则测的不是公共边界。
- **改 `tool-boundary.test.ts` 的硬编码工具数（11/24/28）而不改 `PHASE_*` 常量**。这些数字是 `PHASE_*.length` 的断言（如 `:100`），改数字要同步改 `types.ts:290/304/325`。

## 验证命令

```bash
# 标准入口（根目录，CI 用同一命令）
cd /Users/shaw/AgentBean && npm run test:pi-management-runtime

# 包内单跑边界测试
cd /Users/shaw/AgentBean/packages/pi-management-runtime && \
  ../../node_modules/.bin/vitest run tests/public-api.test.ts --config vitest.config.ts --api.host 127.0.0.1

# 包内单跑工具边界测试
cd /Users/shaw/AgentBean/packages/pi-management-runtime && \
  ../../node_modules/.bin/vitest run tests/tool-boundary.test.ts --config vitest.config.ts --api.host 127.0.0.1

# 类型检查（不产 dist）
cd /Users/shaw/AgentBean/packages/pi-management-runtime && ../../node_modules/.bin/tsc -p tsconfig.json --noEmit

# SEA 烟雾（CI 独立步骤，本地可选）
cd /Users/shaw/AgentBean && node scripts/build-pi-management-sea.mjs && node scripts/check-pi-management-sea.mjs
```
