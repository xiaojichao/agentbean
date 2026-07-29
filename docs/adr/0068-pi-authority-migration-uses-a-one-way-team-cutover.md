---
status: accepted
---

# PI 权威迁移采用按 Team 的单向切换

ADR-0062 已用结构化 Promotion gate、Server-owned root Task 与 PI orchestration run 取代旧的每消息 Channel Coordinator、coordination job/cycle、Device-only coordination 和 Team 自动协调开关。迁移必须让每个 source lineage 在任一时刻只有一套写权威，不能以兼容、rollout 或故障回退为名继续双写。

## 权威切换

Server 为每个 Team 持久维护单调的 PI authority epoch 与迁移状态：`legacy → shadow → cutover_pending → new_authority → legacy_read_only → retired`。状态是可恢复、可审计的 Server 事实，不由 worker 环境变量决定；同一 Team 不按用户、消息比例或进程随机分流。跨 Team 来源选择一个明确 owning Team，并使用其 epoch。

Message 提交与 cutover 在同一 Team migration revision 上线性化。`Message + InboxItem` 事务记录当时的 authority epoch，source lineage 后续异步处理、重试和相同 `clientMessageId` replay 必须沿用该 epoch。先于 cutover 提交的旧工作适用 legacy drain 规则；后于 cutover 提交的消息只适用当前 Promotion gate，不得创建 coordination job。

最终 cutover 由合法 Team Owner/Admin 发起，但只有 Server readiness gate 通过后才能完成。Server 签发绑定 Team、目标 epoch、migration revision、readiness snapshot、操作者和有效期的一次性 token；接受 token 与推进 epoch、fencing legacy writer、audit 和 outbox 原子提交，重复接受幂等返回同一结果。自动 rollout policy 只能提出 cutover proposal，平台运维可以暂停迁移或 emergency-stop，但不能替 Team 绕过授权和 readiness。

## 存量工作与历史事实

cutover 不批量把旧 job、cycle、decision、dispatch 或 ManagementRun 改写成 root Task、PI run 或新 event。终态 legacy facts 保持不可变并通过只读 compatibility projection 查询；报表在查询层跨时代聚合，不能通过伪造新事实制造连续性。

尚未开始的 legacy job 在 cutover 时取消。已经派发或执行的 lineage 可以在隔离边界与 deadline 内完成当前执行单元并写回结果，但不得吸收新消息、继续拆解、重试、再派发或扩大 scope。仍需后续工作的 lineage 必须暂停并形成 Legacy migration proposal；合法确认后才幂等创建唯一新 root Task，并记录绑定旧 lineage、cutover version、确认人和 scope snapshot 的不可变 Legacy migration relation。该关系只证明来源与接续，不继承旧权限、claim、Invocation authorization 或 Action approval。

合法迟到结果只通过 Legacy drain bridge 接收。Server 校验已登记 lineage、drain lease、fencing token、deadline 与幂等键后，以当前 `Message + InboxItem` 事务提交带 legacy provenance 的结果；该消息不得自动触发 Promotion evaluator、root Task 或新 coordination job。重复结果返回原消息。过期、已终结或无法安全解释的结果不改变权威状态，只进入诊断或 `legacy_recovery_pending`，等待合法人工恢复。

## API、daemon 与故障边界

兼容期内旧查询接口可以返回只读 Legacy compatibility projection。cutover 后，legacy 创建、派发、重试等写接口统一返回结构化 `LEGACY_COORDINATION_RETIRED`，并提供替代入口、cutover version 与 correlation ID；Server 不把旧请求静默转换成 proposal、Task 或 PI run，因为旧请求没有新合同要求的结构化授权与 freshness basis。

旧 daemon 可继续收发普通消息，并在有效 drain 权利内完成 cutover 前已经派发的执行单元；它不能创建 coordination job、root Task、DAG 或 PI run，也不能取得 orchestration claim 或 driver lease。Server 通过协议版本与 capability negotiation 执行该边界，新子 Task 只派给通过当前执行协议校验的 daemon。daemon 升级失败只影响领取能力，不能让 Team 降级回 legacy。

cutover 后不允许语义回滚或重新启用 legacy writer。消息投递保持运行；Promotion gate 可以进入 `proposal-only` 或 `off`，PI runtime 可以 emergency-stop，已提交 Task/run/event 继续作为权威事实。恢复只从 Server facts、events 与 checkpoint 前滚。旧只读 projection 可以辅助诊断，但不得成为故障 fallback。

## 兼容层退役

删除 compatibility layer 必须满足证据门槛：所有生产节点使用同一 cutover version；数据库约束阻止新增旧事实；legacy writer 与已登记旧客户端调用在观察窗口内持续为零；不存在未终态 drain lineage 或 `legacy_recovery_pending`；旧只读调用方已有替代方案；历史 provenance 和审计导出已验证；emergency-stop、积压恢复和前滚演练通过。

满足门槛后先移除运行时入口，再在后续版本删除旧存储结构，不能在同一次不可逆发布中完成。旧 ADR 保留原文并标记 `superseded`；`Channel Coordinator`、coordination job/cycle 与 Device-only coordination 只用于 legacy、迁移和历史审计，新 API、event、schema、配置和产品文案不得继续使用。

本决策规定 ADR-0001、0003、0010、0012、0032、0049 与 0061 被 ADR-0062 取代后的迁移和兼容路线，并补全 ADR-0067 留给 #899 的旧 API、数据、rollout 与回退边界。它不重新设计当前 Promotion、PI orchestration、Task lifecycle 或 Command registry，也不授权本 ADR 之外的实现细节。
