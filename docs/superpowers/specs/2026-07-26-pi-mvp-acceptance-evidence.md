# PI Agent MVP 全链路验收与发布证据（#725）

> 基线：`main@27aa9a49`
> 验收分支：`worktree-issue-725-acceptance`
> 本文只记录可公开的状态、测试名、CI/部署链接槽位与判定；不记录 Credential、业务 prompt 或模型思维链。

## 1. 验收矩阵

| AC | 自动化/证据 | 当前判定 | 合并后证据 |
| --- | --- | --- | --- |
| AC1 普通聊天不建 Task；点名 Agent 拒绝不改派 | `pi-acceptance/ac1-no-task.test.ts`：普通聊天/明确 Task 走真实 Socket + SQLite + HTTP Provider；拒绝场景以公开 task:create 后补 coordination fixture，再走真实 broker + Agent Socket respond | 普通聊天链路 Green；targeted 拒绝协议 Green；“消息 @Agent→Offer”尚无单测贯通 | CI URL：待回填 |
| AC2 required 硬过滤、coverage、显式接受 | `pi-acceptance/ac2-offer-flow.test.ts` 覆盖 required Skill 与 accept/reject；`agent-eligibility-service.test.ts` 覆盖父 Task 门槛可由两个子 Task/Agent 联合覆盖 | 硬过滤/显式响应 Green；preferred production wiring 已接入但尚无 Socket 端到端排序断言 | CI URL：待回填 |
| AC3 自动协调关闭/高风险确认 | 既有 `channel-coordination-coordinator.test.ts` 覆盖 suggested 与 high-risk blocked | Green；MVP 将 blocked 作为终态，不新增确认消费通道 | CI URL：待回填 |
| AC4 模型故障消息仍保存且副作用暂停 | `pi-acceptance/ac4-model-failure.test.ts` 覆盖 401、超时、非 JSON；Message=1，Task/Offer/Claim/Memory=0；无 legacy fallback 由新协调路径与旧 route 不互调的结构边界保证 | 故障保存/暂停 Green；未新增 legacy dispatch 观测断言 | CI URL：待回填 |
| AC5 Team 角色不见供给身份 | `pi-acceptance/ac5-no-credential-leak.test.ts` 以 owner/admin/member 三种 Team 角色扫描公开健康、PI policy、Team 列表、频道历史，并验证供给管理事件均 FORBIDDEN；`web-next/tests/pi-management-panel.test.ts` 验证 Team DOM 只消费公开健康投影 | 全角色 Socket/API 与 Web 静态边界 Green；浏览器 smoke 待合并 CI 补充 | CI URL：待回填 |
| AC6 Memory scope/Candidate/Archive/Pack | 既有 memory source invalidation、candidate、formal memory、archive 与 experience pack 测试 | 既有自动化 Green；本次未新增 AC6 文件 | CI URL：待回填 |
| AC7 重启/重放幂等 | `pi-acceptance/ac7-idempotent-replay.test.ts`：关闭并用同一 SQLite 重启 Server，重放同一 Job；`task-claim-broker.test.ts` 验证同一 Offer 重复接受仅生成一个 Claim；`management-tool-executor.test.ts` 验证并发重放同一 Memory 写命令只执行一次副作用 | Decision/Task/系统消息、Offer/Claim、Memory 写入三层幂等 Green | CI URL：待回填 |
| AC8 测试、build、migration/FK | Node 24 下目标 Vitest、`build:server-next`；最终 `npm run test:ci` 与 `npm run build:packages` | 本地全量 Green（Node 24.18.0） | CI URL：待回填 |
| AC9 main CI/CD 与生产 smoke | 合并后 main CI/CD、Railway 生产部署、strict cutover audit、public entry smoke 与 business smoke | Green | [main CI/CD](https://github.com/xiaojichao/agentbean/actions/runs/30183371318) |
| AC10 darwin-arm64/x64 | `pi-sea-compatibility.yml` 在 GitHub `macos-15` 与 `macos-15-intel` runner 分别验证 arm64/x64 SEA 构建、启动与 fail-closed 聚合判定；边界见同目录 compatibility runbook | Green；x64 是 CI 兼容目标，不构成 Intel Device 产品支持 | [四平台 SEA 与聚合判定](https://github.com/xiaojichao/agentbean/actions/runs/30183371319) |
| AC11 公开状态、Token unknown、无秘密 | 公开健康码仅 `PI_UNAVAILABLE/PI_DEGRADED`；Token usage 缺失继续使用 unknown/null 语义 | 本地代码与既有测试覆盖；CI 待证 | CI URL：待回填 |

## 2. 本次修复

| 缺口 | 修复 |
| --- | --- |
| F1 | Task Claim Broker 同时读取有效 Manifest Skill 与 Team restriction；required Skill 缺失即移出候选 |
| F2 | 生产 `createDefaultApp` 将真实 broker 接入 decomposition eligibility service |
| F3 | 生产 allocation service 使用 `rankQualifiedCandidates` 与 `decideOfferAllocationPolicy`；新增 SQLite preferred Skills 持久化 |
| F4 | Team 可见健康诊断码映射为 `PI_UNAVAILABLE` / `PI_DEGRADED`，不暴露底层供给术语 |

## 3. 已知边界

- 高风险动作的 `blocked` 是 MVP 终态；#725 不创建 `confirm_high_risk` 或 `confirm_suggested` 消费入口。
- AC9 的 main CI/CD、Railway 部署与生产 smoke 已由合并后工作流验证。
- 根据 ADR 0056，AC10 只验收 `darwin-x64` 的构建、SEA 启动与平台判定兼容性；Intel Device Service、Agent、本地文件/Workspace、安装升级与签名公证不属于产品支持或发布阻塞条件。
- 公开证据只允许公开 PI 状态和脱敏对象 ID；Provider、Model、Endpoint、Credential、业务 prompt 与切换历史不得进入本文或 CI artifact。

## 4. 最终验证记录

| 命令 | 结果 |
| --- | --- |
| `npm run test:ci` | Green（Node 24.18.0；含 packages、server-next、daemon-next、web-next 与 retained boundaries） |
| `npm run build:packages` | Green（Node 24.18.0；含 contracts、domain、PI runtime、server-next、daemon-next、web-next production build） |
| `npm run build:server-next` | Green（Node 24.18.0） |
| `vitest run tests/pi-acceptance/*.test.ts` | Green（5 files / 8 tests） |
