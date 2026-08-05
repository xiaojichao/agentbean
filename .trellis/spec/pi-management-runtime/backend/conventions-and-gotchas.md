# 约定与陷阱

## 何时适用

- 给本包加工具、改 schema、动 `toolPolicy`、调影子模式行为、改阶段选择逻辑时。
- 排查「模型发出的工具调用被拒」「read 工具在影子模式还是真执行」「Phase-1 工具 schema 加了字段但模型不产出」类问题。

## 本地模式与陷阱清单

### 陷阱 1：allowlist 被强制两次

工具 allowlist 在**两个独立位置**断言，缺一不可：

1. **流构造时**（`src/pi-session-adapter.ts:165-166`）：从 `context.tools` 取实际工具名，调 `assertExactManagementToolAllowlist(effectiveToolNames, expectedToolNames)`。模型若发了非预期工具名，下一行（`:181-183`）抛 `P0_MODEL_TOOL_REJECTED`。
2. **会话注册后**（`src/pi-session-adapter.ts:457-458`）：`session.getActiveToolNames()` 拿 SDK 实际激活的工具，再调 `assertExactManagementToolAllowlist` 比对。这一道抓「SDK 静默丢了/多了工具」。

`assertExactManagementToolAllowlist`（`src/management-tool-catalog.ts:67-78`）对 missing / extra / 重复都敏感，抛 `P0_TOOL_ALLOWLIST_MISMATCH`。

**陷阱**：加新工具只在 `MANAGEMENT_TOOL_NAMES` 加、忘了进 `PHASE_*` 数组 → 第二道断言会在注册后才发现「实际激活的工具集与期望不一致」。三处都得改：`MANAGEMENT_TOOL_NAMES`（`types.ts:259`）+ 对应 `PHASE_*`（`types.ts:290/304/325`）+ `toolPolicy`（`management-tool-catalog.ts:23-55`）。

### 陷阱 2：工具名 wire 映射——点号 ↔ 下划线

catalog 内部用点号名（如 `context.get_root_message`），但 DeepSeek/OpenAI 的函数名语法只许 `[a-zA-Z0-9_-]`，**不允许点号**。`openai-compatible-management-model-adapter.ts` 做双向映射：

- `toProviderSafeToolName`（`:147-149`）：`name.replace(/\./g, '_')`，`context.get_root_message` → `context_get_root_message`。
- `buildToolNameWireMap`（`:151-172`）：构造 `toWire` / `fromWire`。**冲突即拒**：若两个 catalog 名映射到同一 wire 名（极不可能但理论上 `a.b` 与 `a_b` 会撞），抛 `MANAGEMENT_MODEL_REQUEST_INVALID`（`:161`）。
- **宽容回显**：`originalByWire.set(original, original)`（`:166`）——provider 直接回显 catalog 原名（带点号）也能识别。

**陷阱**：不要在 catalog 工具名里用点号以外的分隔符（如 `:`），`replace(/\./g, '_')` 不会处理它们，provider 端会拒。所有 28 个工具名都遵守 `<namespace>.<verb>` 形态（`types.ts:259-288`）。

### 陷阱 3：影子模式（shadow）只拦 write，不是 no-op

影子模式的 gate 是 `metadata.effect === 'write'`（`src/management-tool-catalog.ts:272`），**只**对 write-effect 工具走 dry-run：

- 发 `shadow-tool-intent` 事件，带参数的 SHA-256 哈希（`:273-279`，用 `canonicalJson` `:239-251` 规范化后 `createHash('sha256')`）。
- 返回 `dry_run_recorded`，**不调用**真实 executor（`:280-284`）。

**read-effect 工具即使在影子模式也真打 executor**（`management-tool-catalog.ts:291` 之后的分支无 shadow gate）。这是有意设计：read 无副作用，影子会话仍需真实上下文。

**陷阱**：以为「开影子模式 = executor 不被调」。write 工具确实不调，但 read 工具（如 `context.get_visible_thread`、`tasks.wait`、`memory.search`）仍调——executor 实现里别假设「影子模式一定不进来」。

### 陷阱 4：上下文深冻结，别想就地改

`cloneAndFreeze`（`src/pi-session-adapter.ts:51-60`）：`structuredClone` 后递归 `Object.freeze` 每一层。会话创建时 context 立即被冻结（`:390`），catalog 拿到的 `sessionContext.scope`（`:294`）是冻结快照。

**陷阱**：在 executor 里想缓存 `call.scope` 的某个字段后续改用——frozen 对象写入会静默失败（非严格模式）或抛错（严格模式）。需要可变副本就自己 `structuredClone(call.scope)`。

### 陷阱 5：阶段由 `managementPhase` 选，不是 `schemaVersion`

工具面选择逻辑在 `src/pi-session-adapter.ts:391-395`：

```ts
const effectiveToolNames = [...(input.context.schemaVersion === 2
  ? (input.context.managementPhase === 3
    ? PHASE_3_MANAGEMENT_TOOL_NAMES
    : PHASE_2_MANAGEMENT_TOOL_NAMES)
  : PHASE_1_MANAGEMENT_TOOL_NAMES)];
```

- `schemaVersion === 1` → 永远 Phase 1（11 个工具），不论 mode。
- `schemaVersion === 2` → 看 `managementPhase`：`3` 选 PHASE_3（28 个），其余（`2`）选 PHASE_2（24 个）。
- `managementPhase` 只在 `ManagementSessionContextV2` 上存在（`src/types.ts:151-160`，类型为 `2 | 3`）。

**陷阱**：以为升 `schemaVersion` 就自动拿 Phase 3 工具——还得显式传 `managementPhase: 3`。V2 context 的 `managementPhase` 类型已收窄到 `2 | 3`（`:153`），传 `1` 会被 TS 拒；但运行时若传了非法值，`assertSessionContext`（`:66-92`）会抛 `P1_SESSION_CONTEXT_INVALID`。

### 陷阱 6：Phase-1 工具的 schema 是空对象门控

`schemaFor`（`src/management-tool-catalog.ts:227-237`）对 Phase-1 工具返回 `Type.Object({}, { additionalProperties: true })`（`:236`）——空 properties + 允许任意额外属性。Phase-2 task 工具（`:228-230`）与 Phase-3 memory 工具（`:233-234`）才有真 schema。

**陷阱**：给 Phase-1 工具（如 `agents.invoke`、`channel.post_management_status`）在 catalog 里加 `required` 字段——会静默破坏模型产出。Phase-1 工具的参数验证由消费方 executor 自己负责，catalog 不挡。只有 Phase-2/3 工具走 `parsePhase2TaskToolInputV1` / `parsePhase3MemoryToolInputV1`（`management-tool-catalog.ts:286-290`，来自 `@agentbean/contracts`）做强校验。

注意例外：`agents.invoke` 虽是 Phase-1 effect（`toolPolicy` 里 `phase: 1`，`:33`），但在 V2 context 下走 Phase-2 task schema（`:229` 的 `|| name === 'agents.invoke'`）——因为它需要 `taskId`/`claimLeaseId` 等结构化输入。

### 陷阱 7：runtime 一次性 provider，base URL 是假的

factory 每次创建会话都新建一个内存 provider（`src/pi-session-adapter.ts:396-424`）：`AuthStorage.inMemory()` + `ModelRegistry.inMemory()`，`baseUrl: 'http://agentbean.invalid'`。真实 LLM 调用走的是注入的 `ManagementModelAdapter`（通过 `createStreamSimple` `:151-240` 拦截 `streamSimple`），`baseUrl` 永远不会被 HTTP 请求。

**陷阱**：看到 `agentbean.invalid` 别以为是配置 bug——这是隔离设计。`dispose` 时 `modelRegistry.unregisterProvider(providerId)`（`:461`）清掉。

### 陷阱 8：dispose 必须幂等且可重入

`PiManagementSession.dispose`（`src/pi-session-adapter.ts:364-377`）用 `disposePromise ??=` 缓存，多次调用共享同一个 promise。`sea-smoke-entry.ts:97` 显式测 `Promise.all([session.dispose(), session.dispose()])`。

**陷阱**：消费方别在 dispose 后再调 `prompt`/`subscribe`——SDK session 已 `abort`+`dispose`，行为未定义。

## 佐证文件

- allowlist 双闸：`src/pi-session-adapter.ts:165-166`、`src/pi-session-adapter.ts:457-458`、`src/management-tool-catalog.ts:67-78`
- 工具名 wire 映射：`src/openai-compatible-management-model-adapter.ts:147-172`
- 影子模式 gate：`src/management-tool-catalog.ts:271-285`
- 深冻结：`src/pi-session-adapter.ts:51-60`、`:390`
- 阶段选择：`src/pi-session-adapter.ts:391-395`、`src/types.ts:151-160`
- Phase-1 空 schema：`src/management-tool-catalog.ts:227-237`
- 一次性 provider：`src/pi-session-adapter.ts:396-424`
- dispose 幂等：`src/pi-session-adapter.ts:364-377`、`src/sea-smoke-entry.ts:97`
- 工具策略表：`src/management-tool-catalog.ts:23-55`

## 反模式汇总

- 加工具只改一处（见陷阱 1）。
- 工具名用点号以外分隔符（见陷阱 2）。
- 假设影子模式不调 executor（见陷阱 3）。
- 就地改 `call.scope`（见陷阱 4）。
- 以为升 schemaVersion 就拿 Phase 3（见陷阱 5）。
- 给 Phase-1 工具加 required schema 字段（见陷阱 6）。
- 把 `agentbean.invalid` 当真 URL 去「修」（见陷阱 7）。
- dispose 后继续用 session（见陷阱 8）。

## 验证命令

```bash
# 跑工具边界测试（覆盖陷阱 1/3/5/6）
cd /Users/shaw/AgentBean/packages/pi-management-runtime && \
  ../../node_modules/.bin/vitest run tests/tool-boundary.test.ts --config vitest.config.ts --api.host 127.0.0.1

# 跑全部测试（含 adapter 的 wire 映射陷阱 2）
cd /Users/shaw/AgentBean && npm run test:pi-management-runtime

# 快速确认 toolPolicy 三处一致（工具名应在 MANAGEMENT_TOOL_NAMES + 对应 PHASE_* + toolPolicy 同时出现）
cd /Users/shaw/AgentBean && grep -c "'" packages/pi-management-runtime/src/types.ts && \
  grep -n "effect:" packages/pi-management-runtime/src/management-tool-catalog.ts | wc -l
```
