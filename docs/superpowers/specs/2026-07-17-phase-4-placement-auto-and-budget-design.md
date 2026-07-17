# Phase 4 第二阶段：Placement 策略完善（auto + 预算配置 + Web 配置面）

> 父设计：`2026-07-10-agentbean-pi-management-agent-design.md` §7.4 / §8.1 / §9 / §15.1
> 第一阶段：Issue #622（已收口，PR#641 合入 main `2f61399a`）
> 状态：草案，待评审后开母 issue

## Problem Statement

Phase 4 第一阶段上线了受控 Server-hosted Manager Worker，但总设计 §8.1 定义的 placement 体系只落地了一半：

1. **`auto` placement 有合同值、无决策语义**。`ManagerPlacement = 'managed' | 'device' | 'auto'` 已在合同合法，`normalizePlacementPolicy`（`management-router.ts:382`）透传 `auto`，但调度层没有任何"根据隐私、在线状态、模型和负载选择"的逻辑——`device-worker-scheduler` 的 placementAllowed 判定是 `placement !== 'managed'`，即 **`auto` 当前隐式等于 `device`**。Team 显式选择 `auto` 时得到一个名不副实的行为。
2. **Web 配置面缺失**。`ManagementPolicyPanel` 把 placement 写死为 `device`（`DEFAULT_PLACEMENT`），没有 placement 类型选择、没有 `allowServerContext` / `preferredProvider` / `preferredModel` 入口。owner/admin 想开启 `managed` placement 只能裸调 socket 事件，且 UI 没有任何关于"授权内容将发送至 Server provider"的隐私提示。
3. **预算硬编码**。`PHASE_1_BUDGET`（1/1/1）与 `PHASE_2_BUDGET`（20/3/20）写死在 `management-router.ts`，Team 无法按任务复杂度调整 `maxSubtasks` / `maxDepth` / `maxExternalInvocations`，尽管 `ManagementRun.budget` 字段早已在合同与持久化层存在。

## Solution

补齐总设计 §8.1 的 placement 体系，分四个切片：

1. **Web placement 配置面**：`ManagementPolicyPanel` 暴露 placement 类型（`device` / `managed`）、`allowServerContext`、`preferredProvider` / `preferredModel`，配知情授权文案。复用现有 `managementPolicy.update` socket 与 `updatePolicy` 校验，**不动 server 写路径**。
2. **`auto` placement 决策**：domain 新增纯函数 `resolveAutoPlacement`，输入 Team policy、授权 Device 在线状态、Server Worker 池可用性与 credential 状态，输出确定性的 `device` | `managed` 决定与理由码。决定结果**冻结进 ManagementRun.placementPolicy**（resolved placement 随 run 持久化，不随后续状态漂移），路由决定与 `managedFallbackBarrier` 写入同一事务。
3. **Team 预算配置**：`TeamManagementPolicyV2Dto` 增加可选 `budgetOverrides`，router 用它替代硬编码 Phase 默认值；domain 提供上下限钳制；Web 面板暴露配置。
4. **Run 用量可见性**：从既有 management events 派生 run 级计数（子任务数、外部调用数、深度峰值），在 run 详情端点暴露，为后续成本策略积累数据面。

安全不变量（全切片共享）：

- `allowServerContext === false` 时 `auto` **永不**选择 `managed`；此时若无授权在线 Device，fail closed 返回明确不可用，**不静默迁移 Device-only 上下文**（总设计 §8.1 红线）。
- `auto` 的决定对每个 run 只发生一次且可审计；运行中的 run 不因 Device 上线/下线改变 placement。
- `managedFallbackBarrier` 语义不变：`auto` 解析为 `managed` 后越过 barrier 的，与显式 `managed` 同等对待，禁止 direct 逃生。

## User Stories

1. 作为 Team owner，我希望在 Web 设置里直接选择 placement 类型（device/managed），以便不用裸调 API 开启 Server Worker。
2. 作为 Team owner，我希望开启 managed 前看到明确的隐私提示（哪些内容会发给 Server provider），以便知情授权。
3. 作为 Team owner，我希望配置 preferredProvider/preferredModel，以便 Device Worker 选择符合团队模型偏好。
4. 作为 Team owner，我希望把 placement 设为 `auto`，以便 Device 全离线时任务仍可由 Server Worker 承载。
5. 作为普通成员，我希望 `auto` 只在 owner 授权范围内选择（`allowServerContext=false` 时永不上 Server），以便 Device-only 内容不意外离开本地。
6. 作为用户，我希望看到某个 run 的 `auto` 决定结果和理由（为什么选了 managed/device），以便理解任务在哪执行。
7. 作为审计人员，我希望 `auto` 决定写入审计记录，以便事后追溯每个 run 的 placement 依据。
8. 作为用户，我希望 `auto` 在 Device 离线且未授权 Server 时看到明确失败，以便决定是开启授权还是等 Device 上线。
9. 作为 Team owner，我希望调整 Team 的子任务数/深度/外部调用上限，以便复杂任务不被 Phase 默认预算误杀。
10. 作为运维人员，我希望预算配置有上下限钳制，以便误配置不会压垮调度或让限制形同虚设。
11. 作为产品维护者，我希望 run 用量计数可读，以便评估后续成本策略的基线数据。
12. 作为开发者，我希望 Phase 4 第一阶段行为（显式 device/managed、权限、recovery、队列超时）完全回归，以便第二阶段是增量而非改写。

## Implementation Decisions

- `resolveAutoPlacement` 放 domain 层，纯函数，不触碰 socket/DB；输入显式枚举（`allowServerContext`、在线授权 Device 数、Server Worker 池 snapshot、credential 状态），输出 `{ placement: 'device' | 'managed'; reasonCode: AutoPlacementReason }`。理由码枚举进合同，供审计与 UI 展示复用。
- `auto` 解析时机：router 在创建 ManagementRun 前解析一次，把 resolved placement 写入 run 的 `placementPolicy`（合同已允许该字段携带具体 placement）；run 的后续调度、recovery、审计全部消费 resolved 值，不再感知 `auto`。
- 决策输入快照与 barrier 同事务：解析用到的 Device 在线状态 / Server Worker 可用性不落库，但决定结果与理由码随 run-started event 与 `management_access_audits` 各留一份。
- `auto` 的负载信号第一版只用布尔级（有无可用容量），不引入排队深度、成本或响应时间加权——总设计「先验证正确性」纪律。
- Team 预算：`TeamManagementPolicyV2Dto` 加可选 `budgetOverrides: Partial<ManagementBudgetDto>`；缺省字段回落 Phase 默认值。domain `clampManagementBudget` 定义每字段上下限（如 maxDepth 1–5、maxSubtasks 1–50、maxExternalInvocations 1–100，评审时可调），钳制发生在 updatePolicy 写路径，读路径信任已钳制值。
- Web 面板 placement 类型选项第一阶段只暴露 `device` / `managed`；`auto` 选项在切片 2 落地后再开放，避免提前暴露无语义的值。
- managed 的隐私提示文案与 `management_access_audits` 的已有字段对齐（授权投影范围见 #626），不新造概念。
- Run 用量计数从 events 派生（task-created / invocation terminal 计数、深度峰值从 parentTaskId 链算），不新增持久化表。

## Testing Decisions

- domain：`resolveAutoPlacement` 决策矩阵参数化全覆盖（allowServerContext × Device 在线 × Server 可用 × credential 状态），安全不变量（false → 永不 managed）单独参数化断言；`clampManagementBudget` 边界值测试。
- server：`updatePolicy` 接受/拒绝 `auto` + `budgetOverrides` 的校验矩阵；`auto` run 的 placementPolicy 冻结断言（决定后 Device 上线不改变 run）；理由码进审计断言。
- web：面板表单状态/校验纯函数下沉 lib 并单测（沿用 [[web-next-test-conventions]]，不测组件）。
- e2e：扩展 `phase-4-managed-server-worker-smoke` 模式，加一个 `auto` 场景（Device 离线 + 授权 Server → managed 交付成功；理由码可见）。
- 回归：Phase 1–3 retained boundaries、Phase 4 第一阶段 scheduler/pool/kernel/recovery 测试全绿。

## Out of Scope

- Team 自带 API key、凭据上传、密钥轮换 UI、secret vault 产品面（同 #622，凭据管理面成熟前不做）。
- 动态成本/价格策略、provider 多 credential 池与优选调度（切片 4 只出用量数据面，不做定价）。
- 新 Team 默认 `managed`（总设计目标态；待 `auto` 灰度验证后再议）。
- `auto` 决策的队列深度/响应时间/成本加权信号。
- 请求级 placementPolicy 覆盖 Team policy 的 Web 入口（保持 Team 级统一管控）。

## Further Notes

- 切片顺序建议：1（Web 配置面，纯 UI 低风险）→ 2（auto 决策，核心）→ 3（预算配置）→ 4（用量可见性）。切片 1 与 2 无依赖可并行，但 2 落地前 UI 不暴露 `auto` 选项。
- `auto` 当前隐式等于 `device` 的行为在切片 2 落地后改变：显式选择 `auto` 的 Team 会开始得到真实决策。由于第一阶段 Web 面板无法选择 `auto`（只有裸 socket 能设），实际受影响面接近零，不需要迁移。
- 与总设计 §9 `managedFallbackBarrier` 的交互是本阶段最高风险点：`auto` 解析为 managed 的 run 必须与显式 managed 走完全相同的 barrier 路径，任何"auto 特殊照顾"都会破坏单向门禁。切片 2 的测试必须包含 barrier 语义断言。
