# PI MVP 14：Team-local reliability 排序与 operation restriction（#714）

- 日期：2026-07-23
- 状态：切片核心（contracts + domain 纯规则 + 测试）已实现，待 review
- 关联：issue #714、ADR `0026-team-local-reliability-may-rank-but-not-rewrite-agent-skills`、重整计划 §4「候选排序」
- 依赖：#710（Agent Exposure Manifest + restriction fail-closed）、#712（Task Offer 四类响应）
- 范围：`packages/contracts`、`packages/domain`

## 1. 目标

让 PI 使用当前 Team 内**可观测且已确认归因**的履约事实对合格候选排序，并让 Team Owner/Admin
基于已确认失败限制已公开 operation——不改写 Agent 的公开 Skill，且 restriction 的事实依据对
Agent owner 可见并提供错误归因纠正入口；普通成员只看到理解当前 Task 匹配所需的理由。

## 2. 范围切片决策

沿用 PI MVP 切片节奏（cf. #712 contracts+domain 核心 + 延后 broker 接线）：本切片只交付
**reliability + restriction 纯策略核心**（contracts DTO/码 + domain 纯函数 + 全量单测）。

明确**不在本切片**（留作后续「接线」切片，类比 #712 延后的 broker AC#4）：

- Server 持久化：reliability attribution facts 表、restriction factual basis 列、attribution corrections 表、对应 migration。
- Server 服务方法：在 `agent-exposure-service` / 候选解析器接线 `evaluateTeamLocalReliability` +
  `reliabilityRankingScore` → `rankQualifiedCandidates`，restriction 写入带 basis，纠错记录 CRUD。
- 候选解析器（task-claim-broker / collaboration-service）消费 reliability tie-breaker。
- Web：PI Team 页 reliability/coverage 投影、Agent owner 纠错入口 UI、成员裁剪视图渲染。
- reliability attribution facts 的**采集**：从 Task 终态 / Invocation 终态 / claim relinquishment /
  子任务 acceptance 投影出 `ReliabilityAttributionFactDto`（依赖 #712 接线后的真实事件流）。

本切片的纯规则是上述接线的可单测决策核心；在采集与接线就绪前，规则本身已确定、可审计、可测试。

## 3. 契约（`packages/contracts/src/reliability.ts`）

### 3.1 AC#1/AC#2 已确认归因事实（closed union）

```ts
RELIABILITY_OUTCOME_KINDS = ['accepted','completed','manual_verified','timed_out','relinquished']
```

- 只有这五种「可观测且已确认归因」outcome 形成 reliability 事实。
- **刻意不含**：模型主观评价、未审核交付、self-reported、其他 Team 历史——它们没有合法
  outcome 值，结构性无法构造为 `ReliabilityAttributionFactDto`（AC#2 的类型层保证）。
- 正向（提升置信）：`accepted/completed/manual_verified`；负向（唯一能降分）：`timed_out/relinquished`。
- `ReliabilityAttributionFactDto` 锁定 `teamId`（跨 Team 事实由 domain 过滤丢弃）+ `operationKey`
  （归因到的公开 operation）+ `sourceRef`（可审计来源引用，不含主观正文）。

### 3.2 AC#3 reliability signal（排序 + 风险提示，无供给改写能力）

- `OperationReliabilityEntryDto`：per-operation `score ∈ [0,1]` + outcome 计数 + `riskHints`。
- `ReliabilitySignalDto`：`overallScore`（样本加权）+ perOperation 列表。
- `RELIABILITY_RISK_HINT`：`HIGH_TIMEOUT_RATE / HIGH_RELINQUISH_RATE / LOW_SAMPLE`（canonical 码）。
- reliability 输出是**标量 score + 提示**，唯一消费者是候选排序 tie-breaker；结构性永不补齐
  capability/skill 或删除 Manifest Skill（AC#3）。

### 3.3 AC#5 restriction 事实依据 + 错误归因纠正

- `RestrictionFactualBasisEntryDto`：禁用某 operation 时附带的已确认事实引用 + 简述（对 Agent owner 可见）。
- `AgentExposureRestrictionWithBasisDto`：#710 restriction + factualBasis（仍是「只能禁用已暴露 operation」）。
- `SubmitAttributionCorrectionInput` / `AttributionCorrectionRecordDto`：Agent owner 对错误归因提纠错（pending）。
- `ATTRIBUTION_CORRECTION_REASON_CODE`：6 个 canonical 码（recorded/downweighted/invalid_fact/invalid_reason/not_owner/not_authorized_to_resolve）。

### 3.4 AC#6 可见性裁剪

- `ReliabilityVisibilityLevel = 'owner' | 'member'`。
- `MemberVisibleReliabilityDto`：成员只看「与当前 Task 相关 operation」+「是否影响本次匹配」+ 单条提示；不含 overallScore/计数/纠错。
- `MemberVisibleRestrictionDto`：成员只看「哪些 operation 被禁用」+「是否有依据」；剥离 factualBasis/纠错/审计字段。

## 4. 域纯规则（`packages/domain`）

### 4.1 `reliability-policy.ts`

- `evaluateTeamLocalReliability(input)`（AC#1/AC#2/AC#7）：
  - 过滤：`teamId === 当前 && agentId === 当前`，排除 `excludedFactRefs`（AC#5 acknowledged 纠错降权）。
  - 分组：按 `operationKey`（lowercase）聚合 outcome 计数。
  - 打分：`score = positive/(positive+negative)`；**无任何事实 → neutral 1.0**（AC#2「无数据永不负面」）。
  - 风险提示：`timed_out/relinquished ≥ 2` → HIGH_*；`total < 3` → LOW_SAMPLE。
  - `overallScore` = 样本加权平均；无 entry → 1.0。
  - 确定性：perOperation 按 operationKey 升序，相同输入任意顺序 → 相同输出（AC#7）。
- `reliabilityRankingScore(signal, operationKeys)`（AC#3/AC#7）：折算为排序标量；无 required op / 无条目 → neutral 1.0。
- `redactReliabilityForTaskMatching(signal, {requiredOperations})`（AC#6）：成员裁剪视图。

### 4.2 `operation-restriction-policy.ts`

- `evaluateRestrictionFactualBasis(input)`（AC#5）：basis 引用必须解析到当前 Team 真实已确认事实；捏造/不存在 → fail-closed。不强制「每禁用必有依据」（governance 决定），但有依据必须真实。
- `evaluateAttributionCorrection(input)`（AC#5 纠错入口）：Agent owner 提交；非 owner / 引用不存在 / 空理由 → fail-closed；否则 recorded pending（**不自动删除**事实）。
- `resolveAttributionCorrection(input)`（AC#5 审阅）：Team Owner/Admin acknowledge → 产出 `downweightedFactRef`（供 reliability `excludedFactRefs` 降权）；reject → 驳回；非 owner/admin → denied。
- `redactRestrictionForMemberView(restriction)`（AC#6）：剥离 factualBasis/纠错/审计字段。

### 4.3 `agent-eligibility.ts` 集成（AC#3/AC#7）

- `QualifiedCandidate` 增加可选 `reliabilityScore?: number`。
- `rankQualifiedCandidates` 比较器插入 reliability tie-breaker：`hits → available → reliability → experience → load → 原序`。
- 向后兼容：reliability 缺省 0，既有候选（不传 reliabilityScore）排序行为不变。
- AC#3 结构性保证：reliability 只读标量并比较，排序前后候选的 `exposedSkills` 集合恒等（不增删 skill）。

## 5. AC 对照

| AC | 实现 |
|---|---|
| reliability 只来自当前 Team 已确认归因（accept/complete/timeout/relinquish/人工验收） | `evaluateTeamLocalReliability` team+agent 过滤 + 5-outcome closed union |
| 其他 Team/主观/未审核不能形成负面事实 | closed union（主观/未审核无合法 outcome）+ 无数据 neutral 1.0 + 跨 Team 过滤丢弃 |
| reliability 只排序 + 风险提示，不补 Cap/Skill、不删 Manifest Skill | reliability 标量仅入 `rankQualifiedCandidates` tie-breaker；排序前后 skill 集合恒等测试 |
| Team Owner/Admin 可禁用已暴露 operation，不能扩大供给/改 Manifest | #710 `evaluateRestriction` fail-closed（既有）；restriction 不 mutate manifest |
| restriction 依据对 owner 可见 + 纠错入口 | `RestrictionFactualBasisEntryDto` + `evaluateAttributionCorrection`/`resolveAttributionCorrection` |
| 普通成员只看 Task 匹配所需理由 | `redactReliabilityForTaskMatching` + `redactRestrictionForMemberView` |
| 候选排序确定可测试 | `evaluateTeamLocalReliability` 纯函数 + 排序确定性测试 |
| Vitest + 受影响 workspace build 通过 | test:contracts 95、test:domain 419、test:pi-runtime 55、build:packages 6 workspace exit 0、4 boundary checker 绿 |

## 6. 后续接线切片（不在本 PR）

1. migration：`reliability_attribution_facts`、restriction 增加 `factual_basis_json`、`attribution_corrections` 表。
2. 采集：从 Task/Invocation/claim/acceptance 终态投影 `ReliabilityAttributionFactDto`。
3. 服务：`agent-exposure-service` restriction 写入带 basis；纠错 CRUD；候选解析器消费 `reliabilityRankingScore`。
4. Web：PI Team coverage/reliability 投影、Agent owner 纠错入口、成员裁剪视图。
