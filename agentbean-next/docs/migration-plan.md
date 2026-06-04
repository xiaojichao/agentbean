# 迁移计划

迁移应按垂直切片推进。每个切片都必须包含 server behavior、protocol contracts、minimal web integration、相关 daemon behavior，以及 tests。

逐任务执行请遵循 `docs/implementation-runbook.md`。
第一切片 persistence 与 repositories 请遵循 `docs/first-slice-schema-repositories.md`。
按 phase 设门的测试请遵循 `docs/verification-matrix.md`。

## Phase 0：冻结现有行为

目标：让当前产品足够可理解，以便替换。

输出：

- 当前行为规格：`docs/current-behavior.md`。
- 当前 Socket/HTTP 协议盘点：`docs/current-protocol-inventory.md`。
- 当前数据模型盘点：`docs/current-data-model-inventory.md`。
- 现有功能处置矩阵：`docs/feature-disposition.md`。
- Acceptance test list：`docs/acceptance-tests.md`。
- Verification matrix：`docs/verification-matrix.md`。
- Known gaps 与有意丢弃的实现假设：`docs/known-gaps.md`。

本阶段完成前，不要编写替代 app code。

完成定义：

- Product flows 的描述不依赖当前 file names。
- 当前 event surfaces 已映射到 keep、defer、merge 或 drop 决策。
- 当前 persistence concepts 已映射到 fresh-schema decisions。
- 第一条 implementation slice 已达成一致。
- 已识别保护第一切片的 tests。

## Phase 1：Contracts 与 Domain Core

目标：创建重写版的共享语言。

构建：

- `packages/contracts` 或等价 shared contract module。
- 来自 `docs/contracts-dto.md` 的 first-slice DTOs。
- User、team、agent、device、channel、message、task、artifact 与 dispatch 的 domain types。
- Domain services：
  - message routing
  - channel visibility
  - agent visibility
  - agent identity and dedupe，遵循 `docs/agent-identity-rules.md`
  - task status transitions

测试：

- Mention routing。
- Human mention behavior。
- No-online routing behavior。
- Private channel visibility。
- Agent publish visibility。
- `docs/agent-identity-rules.md` 中列出的 agent identity 与 dedupe cases。

完成定义：

- Domain tests 不依赖 Socket.IO、Express、Next.js 或 SQLite 即可运行。
- Web 与 daemon 不能导入 server implementation modules。

## Phase 2：Server Core Slice

目标：构建最小 server，使其能 authenticate、管理 team、注册 daemon、创建 channel、持久化 messages，并 dispatch 到 agent。

构建：

- App bootstrap。
- SQLite migration runner。
- 来自 `docs/first-slice-schema-repositories.md` 的 global 与 team-scoped repositories。
- Use cases：
  - `registerUser`
  - `loginUser`
  - `listTeams`
  - `registerDevice`
  - `registerDiscoveredAgents`
  - `createChannel`
  - `joinChannel`
  - `sendMessage`
  - `dispatchMessageToAgent`
  - `receiveAgentReply`
- 薄 `/web` 与 `/agent` Socket.IO adapters。
- 如果 dispatch 可以返回 text，本阶段可 stub artifact HTTP upload/download。

测试：

- 使用 in-memory 或 temp SQLite 的 use-case tests。
- 从 login 到 message send 的 socket integration test。
- 覆盖 daemon registration 与 dispatch result 的 agent namespace test。

完成定义：

- Daemon test client 可以注册一个 agent。
- Web test client 可以发送 message。
- Server 持久化 human 与 agent messages。
- Dispatch timeout 产生稳定 error code。

## Phase 3：Daemon Protocol 与 Execution

目标：把 daemon behavior 迁移到新的 protocol client 与 execution interface 后面。

构建：

- Agent protocol client。
- Device hello。
- Runtime scan report。
- Agent register batch。
- Dispatch request handling。
- Execution abstraction。
- 先迁移一个 local runtime adapter，优先 `codex` 或 stub executor。
- Workspace run creation。
- Artifact collection 与 upload interface。

测试：

- 来自现有 daemon suite 的 runtime scanner tests。
- Adapter stub dispatch test。
- Reconnect 与 rescan behavior。
- Dispatch result 与 dispatch error reporting。

完成定义：

- Daemon 可以连接 server-next。
- Daemon 可以上报 runtimes 与 agents。
- Daemon 可以执行 stub/local adapter 并返回 message。
- Server 可以根据 daemon activity 更新 device 与 agent status。

## Phase 4：Web Minimal Slice

目标：替换第一条端到端 workflow 的 UI 路径，而不是移植所有当前 pages。

构建：

- Session management。
- Login/register pages。
- Team shell。
- Channel list。
- Conversation view。
- Agent/device status summary。
- 新协议的 typed API clients。

测试：

- API client tests。
- Store/session tests。
- Message rendering 与 agent status 的 component tests。
- 如果 tooling 可用，添加一个 browser-level smoke test。

完成定义：

- 用户可以 log in。
- 用户可以看到 current team。
- 用户可以看到 connected daemon/agent status。
- 用户可以 create 或 join channel。
- 用户可以发送 message 并看到 agent reply。

## Phase 5：Feature Migration

按以下顺序迁移功能：

1. Device invite flow。
2. Agent publishing 与 custom agent creation。
3. Private channels 与 members。
4. DMs 与 thread behavior。
5. Artifacts 与 workspace runs。
6. Tasks。
7. Agent metrics 与 activity。
8. Search、saved messages、reminders 与其他 UX enhancements。

每个功能都应遵循同一循环：

1. 从旧代码和文档中抽取当前行为。
2. 添加或更新 contract types。
3. 添加 use case tests。
4. 实现 server use case。
5. 实现 transport adapter。
6. 实现 web/daemon integration。
7. 运行 regression tests。
8. 删除旧假设，而不是保留 compatibility shims。

## Phase 6：Cutover

目标：让新实现成为默认实现。

要求：

- 新实现的 fresh data/bootstrap plan。
- 面向未来生产使用的 backup/restore procedure。
- Web、Server 与 Daemon 的 deployment updates。
- 如果届时已有外部用户，提供 release notes。

完成定义：

- CI 可以通过单个 root command 验证所有 apps。
- Existing behavior acceptance tests 通过。
- Manual smoke test 同时覆盖 Web、Server 与 Daemon。
- Rollback instructions 存在。

## 兼容性策略

旧实现尚未发布，因此不要求兼容 old code、old SQLite files、old Socket.IO events 或 old daemon clients。

保留：

- Docs 与已接受行为中捕获的 product intent。
- 旧实现中发现的有用 domain rules。
- 描述期望行为、而不是旧 file shapes 的 tests。
- CLI/package names 只有在仍是最佳 product surface 时才保留，而不是因为旧实现用过。

不保留：

- 旧 Socket.IO event names 或 payload shapes。
- 现有 SQLite schemas 或 migration compatibility。
- Internal row shapes 与 IDs。
- 当前 module boundaries。
- UI-local workarounds。
- Transitional aliases。
- Legacy `standalone-cli` category。
- 不代表产品行为的 test stubs。
- 旧 daemon clients 的 backward compatibility。

如果某个行为只是因为当前实现需要 workaround 才存在，就把它重写为干净需求，或删除。

## 建议工作项

初始工作队列：

1. 创建 `packages/contracts`。
2. 将 message routing 移入 pure domain module。
3. 将 agent identity 与 dedupe rules 定义为 pure functions。
4. 为 users、teams、devices、agents、channels 与 messages 添加 temp-SQLite repository interfaces。
5. 实现 `/web` login 与 team list。
6. 实现 `/agent` device hello 与 agent register batch。
7. 实现 message send 与 stub dispatch。
8. 添加第一条 workflow 的 tiny web shell。
