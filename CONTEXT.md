# AgentBean 协作执行上下文

本上下文描述 AgentBean 中 PI Manager 与外部 Agent 协作执行的核心语言，避免 Phase 4 设计混用 Device、Server 与用户可见执行概念。

## Device Service

macOS 当前用户唯一的 AgentBean 后台系统服务，承载该用户全部已授权 Device Profile，并在终端退出或用户重新登录后继续提供设备能力。
_Avoid_: 每 Team Daemon、前台连接进程、系统级 root 服务。

## Device Profile

Device Service 中一份 Team 范围的本地连接身份与凭据；同一用户可以保存多个 Profile，由同一个 Device Service 统一运行。
_Avoid_: 独立系统服务、Team Daemon、历史邀请命令。

## Message delivery

AgentBean 在 Server 侧原子提交 Message 与必要的接收方 Inbox 投影，并允许接收方按权威顺序拉取的底层能力；它不解释消息意图，也不创建执行 ownership。
_Avoid_: PI coordination、Task promotion、notice 发送、消息即任务、投递即执行。

## Message visibility

用户或 Agent 基于成员关系与权限读取频道、Thread 或 DM 内容的授权边界；可见不表示消息会进入其 Inbox。
_Avoid_: Inbox membership、Unread、频道成员必须接收每条消息。

## Inbox item

Message 产生时按当时权限、关注与通知规则，面向特定接收方形成的不可追溯改写的待处理投影；发送者自己的 Message 不进入其自身 Inbox。
_Avoid_: 可见消息全集、频道历史副本、状态变化后重算历史投影、自己的消息成为自己的 Unread、隐式工作 ownership。

## Message target

Message delivery 中独立排序并独立维护 Read boundary 的会话范围，至少区分频道主时间线、每个 Thread、每个 DM 与 DM Thread。
_Avoid_: Team 全局消息流、成员全局游标、频道与其全部 Thread 共用边界。

## Delivered

Server 已为接收方持久化 Inbox item 的权威投递状态；它不表示任何 notice 通道成功，也不表示接收方已经读取、理解或准备处理。
_Avoid_: Notice delivered、Read、Seen、Acknowledged、已处理。

## Notice delivery

daemon、websocket、push 或系统通知等通道携带稳定 inbox item 身份发出的派生唤醒信号；它允许延迟、失败、重复与重放，接收方以 message check 恢复权威 Inbox。
_Avoid_: Delivered、权威消息事实、Read、notice 失败撤销 Message、notice 成功即已读。

## Read boundary

每个接收方通过明确的 message check/read，在某个 Message target 对应的 Inbox 投影上连续确认到的 Server 权威位置；它只能单调推进，且不能跨过未确认的 Inbox item。
_Avoid_: target 全量消息游标、Delivered boundary、稀疏已读集合、跨过未读 Inbox item、客户端本地未读状态、打开页面即已读、收到 notice 即已读。

## Read candidate

Server 为 message check 实际返回的连续 Inbox 前缀签发，并绑定接收方、Message target 与 Inbox 投影位置的不透明 token；它证明 Server 返回了哪些上下文，但在接收方确认前不改变权威边界。
_Avoid_: Read boundary、客户端提交任意 target seq、跳页确认、拉取即已读、未确认的游标推进。

## Read acknowledgement

接收方确认已纳入某个 Read candidate 后提交的显式幂等动作；有效旧 token 可以成功 no-op，新增 Inbox item 不影响推进到原 candidate，过期、篡改或身份与 target 不匹配的 token 不产生副作用。
_Avoid_: Delivery acknowledgement、网络接收成功、任意游标写入、以 token 有效替代 freshness 校验、隐式页面访问。

## Freshness basis

一次 send 或 claim 明确声明并经 Server 校验的决策依据，包括对应 Message target 的 Read candidate，以及可选的依据 Message 或关联 Task；只有与这些依据相关的并发变化才影响本次操作的新鲜度。
_Avoid_: 全 Team 最新状态、所有未读消息、普通无关频道闲聊、隐式客户端快照。

## Freshness hold

Freshness basis 之后出现相关消息或上下文变化、但操作本身仍然有效时，Server 在不产生发送、领取或 Read acknowledgement 副作用的前提下暂停操作，并返回增量上下文与新的 Read candidate；草稿可以保留，待接收方修订、重试或明确放弃。Task 权威状态已经使 claim 失效时，优先返回 Claim conflict。
_Avoid_: 已失效 claim、失败后自动已读、静默重试、无关消息阻塞、hold 即提交。

## Claim conflict

Task 的权威状态已经使旧 claim 不再成立时返回的并发结果，例如 Task 已被领取、关闭、取消、归档或调用方失去权限；它不改变责任状态，也不推进 Read boundary。
_Avoid_: Freshness hold、自动重试、失败后已读、部分建立 ownership。

## Attention state

Inbox item 对特定接收方是否仍需注意或采取动作的状态；它与 Unread 正交，只能由回应、执行、解除责任或明确忽略等业务动作结束。
_Avoid_: Read、Unread、读过即处理、Read boundary 推进即完成责任。

## PI Manager

AgentBean 内置的系统协调者，只在权威 PI orchestration trigger 成立后编排根 Task；它不是 Team 成员，也不监听或默认理解每一条普通消息，不替代外部 Agent 完成用户领域工作。本条冻结 #894 决议后的目标术语；与之冲突的每消息协调 accepted ADR 在被显式 supersede 前仍约束当前 runtime，本 glossary 不授权静默迁移实现。
_Avoid_: PI Agent、每消息 Channel Coordinator、普通聊天 Agent、用户任务执行 Agent。

## PI orchestration trigger

允许 PI Manager 开始根 Task 编排的结构化、可审计事实，来自人类明确动作、合法 Agent 升级或 Team promotion policy；普通自然语言、关键词、@Agent、DM 或 Thread owner 本身都不是 trigger。
_Avoid_: Channel coordination decision、每消息 coordination job、关键词触发、自然语言自动建单、隐式入口。

## Promotion proposal

在目标、交付、作用域、必要权限与成功标准已经明确后，把一条尚未成为 Task 的 Message 建议提升为根 Task 的授权候选；它保留来源、目标与提出理由，但在被合法确认前不创建 Task，也不产生编排 ownership。
_Avoid_: Clarification、Root task、PI orchestration trigger、模型分类结果、暗中自动建单。

## Promotion clarification

Message 可能表达工作意图、但尚不能唯一确定目标、交付、作用域、必要权限或成功标准时，对同一来源 lineage 提出的单一关键问题；答案充分前不得生成 Promotion proposal 或 Task。
_Avoid_: Promotion proposal、一次性表格访谈、预建 Task、澄清即授权。

## Promotion authorization

原始人类 requester 或 Team-owned 入口指定 approver 使用 Server 签发、绑定 proposal revision 与授权边界的 token，对 Promotion proposal 作出的明确接受；成功原子创建唯一根 Task、来源关系、trigger audit 与 PI orchestration claim，但不授予 Task 内高风险或外部副作用的执行权。
_Avoid_: Action approval、Owner/Admin 代替个人 requester、自然语言同意、过期或跨 revision 授权、accept 后部分建单。

## Agent orchestration escalation

合法责任 Agent 发现当前请求需要持续跟踪或协作时，绑定来源、Freshness basis、目标与理由提交的结构化升级；原授权边界内可形成 PI orchestration trigger，扩大范围、风险、成本或数据权限时只能形成 Promotion proposal。
_Avoid_: 旁观 Agent 升级、自然语言暗示、升级即获得编排权、借升级扩大授权。

## Team promotion policy

由 Team Owner/Admin 在系统治理上限内管理、以版本化规则把预授权结构化入口提升为根 Task 的 Team 规则；正文关键词、模型语义分类或频道惯例只能命中 Promotion proposal，不能直接 promotion。
_Avoid_: 每消息自动分类、自然语言自动建单、覆盖 chat-only、突破权限或数据边界、无版本隐式规则。

## Semantic promotion rollout

自然语言或模型 proposal 策略的 Team 运行状态，只允许 `off`、不打扰用户的 `shadow` 与展示可确认建议的 `proposal-only`；语义策略永不进入自动 promotion，确定性结构化入口不属于此阶梯。
_Avoid_: semantic auto-promote、shadow 建 Task、未审计切换、紧急停用后继续接受旧 proposal token。

## Promotion evaluator

受 Semantic promotion rollout 与消息作用域授权控制、对普通自然语言给出 No promotion、Promotion clarification 或 Promotion proposal 的 Server 无副作用判定器；它不取得 claim、不创建 Task，也不是 PI Manager。
_Avoid_: 每消息 PI Manager、Channel Coordinator、direct dispatch、模型失败回滚 Message、跨频道或 DM ambient access。

## Message-to-task promotion

由权威 PI orchestration trigger 从来源 Message 派生保留不可变来源关系的唯一根 Task；Message 继续作为沟通事实，Task 成为独立工作事实，同一来源 lineage 不得因重试、回复或并行入口重复创建根 Task。
_Avoid_: 移动或替换原消息、复制消息为 Task、每条回复新建根 Task、@Agent 自动升级、无来源 Task。

## Root Task responsibility

根 Task 上由来源 requester、PI orchestration claim、人类验收权与各子 Task 的 Agent execution claim 分别承担的责任关系；根 Task 本身没有单一 owner、assignee 或普通 Agent claim。
_Avoid_: root Task ownership、根 Task assignee、创建者即执行者、PI claim 等同人类验收权、普通 Agent 认领根 Task。

## Human review authority

允许对根 Task 交付执行接受或退回的可审计权力：人类来源默认属于原 requester，Team-owned workflow 属于入口预声明 approver，也可通过显式 delegation 转交；PI Manager 与普通 Owner/Admin 角色本身都不取得该权力。
_Avoid_: PI 自动验收、任意 Team member 改 done、Owner/Admin 默认代验收、创建者字段即授权、proposal approver token 跨阶段复用。

## Root Task terminal outcome

根 Task 停止继续工作的权威结果，区分经合法验收的 `done`、对仍有效未完成工作明确叫停的 `cancelled`，以及因重复、替代、错误创建或行政原因不表达执行取消的 `closed`。
_Avoid_: cancelled 与 closed 混用、failed 自动终结根 Task、waiting/blocked 充当终态、未验收直接 done、删除 Task 表示收口。

## Root Task termination authority

允许把非终态根 Task 推进为 `cancelled` 或 `closed` 的人类治理权，属于原 requester、当前 Human review authority 或有合法治理原因的 Team Owner/Admin；PI Manager 与普通 Agent 只能建议、等待、报告 blocked 或 relinquish。
_Avoid_: PI 因 deadline/失败/预算自动终结、Agent 取消根 Task、无 reason close、取消不做 orchestration closeout、删除历史与 provenance。

## Root Task terminal immutability

根 Task 一旦进入 `done`、`cancelled` 或 `closed` 就不再恢复为非终态；后续工作通过保留 lineage 的 follow-up、continuation 或 replacement root Task 表达，错误终态只能追加保留原事件的行政纠正。
_Avoid_: reopen terminal Task、删除终态事件、复用旧 claim/run、cancelled 改回 in_progress、把 `in_review → in_progress` 退回称为终态 reopen。

## Root Task activation

根 Task 从 `todo` 进入 `in_progress` 的唯一边界：当前 PI driver 首次成功提交会改变工作事实的 orchestration command，例如确认分诊、建立首版 Task DAG 或创建首个子 Task；排队、读取、模型调用、获取 lease 或失败命令都不构成激活。
_Avoid_: promotion 即 in_progress、driver lease 即开工、planning attempt 即进度、失败命令推进状态、waiting 把根 Task 退回 todo。

## Root Task lifecycle

根 Task 的最小权威状态集合为 `todo`、`in_progress`、`in_review`、`done`、`cancelled` 与 `closed`；分诊、拆解、派发、执行、等待和汇总属于 PI orchestration run 的 phase/event 投影，不增加 TaskStatus。
_Avoid_: triaging/decomposing/aggregating TaskStatus、waiting 根状态、Task 与 run 两套阶段锁步、failed 根状态、UI 展示阶段充当权威事实。

## Root Task transition graph

根 Task 只允许 `promotion → todo → in_progress → in_review → done`，其中人类退回以新 revision 执行 `in_review → in_progress`；任一非终态可经合法权力进入 `cancelled` 或 `closed`，三种终态都没有普通出边。
_Avoid_: todo/in_progress 直接 done、in_review 退回 todo、终态 reopen、未列出的自由状态更新、跨过 review、失败自动终结。

## Root Task review readiness

允许 PI 提交根交付并把根 Task 与 run 原子推进到 `in_review` 的权威判断：当前 root Task revision 与 Task DAG revision 下的 required 节点均已被接受、依赖已满足，所有未完成 optional 节点已被显式退休且不再持有 claim/Offer/invocation，根交付绑定完整 contributing deliveries 与 evidence。
_Avoid_: Agent 自报完成即 ready、只数 done 子 Task、忽略 required dependency、复用旧 revision 交付、可选节点仍在活动时提交根审核。

## Root Task review decision

Human review authority 对当前 root Task revision、Task DAG revision 与 review delivery 作出的原子接受或退回：接受推进 `done` 并完成 orchestration closeout；退回记录理由、递增 Task revision、使旧交付与受影响权利失效，并以同一 orchestration claim 恢复 `in_progress`。
_Avoid_: PI 代替人类决定、覆盖旧交付、退回即新根 Task、旧 token 跨 revision 使用、Task/run/claim 分步提交。

## Root Task review wait

根 Task 与 run 在 `in_review` 等待合法 Human review authority 决定的非终态；review deadline 只能产生 attention/reminder 与唤醒，不能自动接受，等待期间保留 orchestration claim 但不占 PI driver lease。
_Avoid_: 超时自动 done、Owner/Admin 默认代验收、等待占用 worker、提醒改变状态、无 review decision 完成 closeout。

## Task transition authority

Server 为一次 Task 状态变化校验的角色化并发依据：PI 使用 run revision、driver lease/fencing 与 expected Task/DAG revision，Agent 使用 claim lease、Task revision 与 attempt，人类使用绑定 review 或 termination authority 和当前 revision 的 Server token。
_Avoid_: 通用 updateTask 任意改状态、只凭登录身份、不同角色共用 token、过期凭证推进、冲突时部分写入、状态失败推进 Read boundary。

## Task transition command

表达一条合法 Task 状态边的具名 Server 领域命令，例如接受 claim、提交/验收交付、取消或关闭；它携带对应 Task transition authority，并原子写入状态、event、audit 与必要 closeout，通用 Task 编辑不能直接指定目标状态。
_Avoid_: `updateTask(status=...)`、客户端 PATCH 状态、只写 Task 不写 event、一个万能 transition API、UI 权限替代领域门禁。

## Promotion source relation

Message-to-task promotion 创建的不可变 provenance，连接来源 Message/target/requester、trigger、创建时目标与作用域快照，并在 proposal accept 入口记录 proposal revision 与确认人；来源后续编辑或删除只产生 attention/tombstone，不静默改写或取消 Task。
_Avoid_: 为无 proposal 的结构化 trigger 虚构 revision 或确认人、Task 正文副本、可变来源指针、删消息即删 Task、编辑消息即改 Task。

## Promotion gate

Server 接受人类结构化 trigger、Agent escalation、Team promotion policy 与 proposal accept 的唯一根 Task 创建边界；它按 source lineage、Freshness basis、目标和授权快照完成去重、冲突判断与原子 promotion。
_Avoid_: 多入口各自建 Task、先到先得、客户端直接创建编排根 Task、部分 promotion。

## Promotion conflict

同一 source lineage 的并发 promotion 请求在目标、作用域、风险或权限边界上不一致，因而不能安全收敛时的无副作用结果；必须由原 requester 明确选择或修订，不能由 Server 按到达顺序代决。
_Avoid_: Freshness hold、静默覆盖、隐式合并、先写入者获胜。

## Orchestration need

请求确实需要多工作单元或跨 Agent 协作、依赖与恢复、结果聚合、持续跟踪或人工审核生命周期的可审计事实；它是 Agent escalation 与 policy direct promotion 的必要门槛。
_Avoid_: 文本长度、复杂措辞、任务关键词、多个 @、模型主观复杂度、单 Agent 可直接完成的请求。

## PI orchestration run

与一个根 Task 一一对应、由 Server 持久维护的编排生命周期事实，汇集当前 orchestration claim、Task DAG 进度、deadline 与恢复位置；PI Manager 只取得可替换、带 fencing 的临时驱动权，不拥有本地权威状态。
_Avoid_: 多个 run 竞争同一根 Task、PI 本地 session、daemon orchestration、worker 进程记忆、重启后重新拆解。

## PI driver

在 AgentBean Server 受控环境中临时驱动一个 PI orchestration run 的可替换执行单元，只能读取 Server-authorized context，并须以有效 lease/fencing 提交命令；它不是 Team 成员、普通 Agent 或 Device 进程。
_Avoid_: Manager Worker、Device Worker、根 Task owner、daemon、永久进程身份、本地权威状态。

## PI orchestration claim

Server 持久记录的系统级编排归属，表示一个非终态根 Task 由 PI Manager 负责组织工作；它跨 worker 与 Server 重启存在，不属于具体进程，也不允许普通 Agent 抢占根 Task。
_Avoid_: PI driver lease、根 Task assignee、Agent execution claim、worker ownership、进程退出即释放。

## PI driver lease

Server 向当前 PI worker 授予的限时编排驱动权，携带单调递增的 fencing token；lease 过期只允许新 worker 接管 PI orchestration run，不结束 PI orchestration claim。
_Avoid_: PI orchestration claim、永久 worker ownership、无 fencing 接管、daemon lease、普通 Agent Task claim。

## PI scheduling state

Server 持久维护的 run 调度资格与恢复条件，区分 `queued`、`runnable`、`waiting`，并记录可调度时间、入队时间、优先级与 scheduling revision；runnable 顺序是这些事实的确定性投影，不是独立的队列位置事实。
_Avoid_: 当前第 N 位、进程内 heap、consumer cursor、不可重建队列、waiting run 占用 worker。

## PI orchestration wait

PI orchestration run 在等待子 Task、外部条件、deadline 或人类 review 时保留恢复条件与 orchestration claim、但释放 PI driver lease 的非终态；条件满足后由 Server 重新投影为 `runnable`。
_Avoid_: worker heartbeat 保活等待、waiting 占用 capacity、释放系统责任、旧 fencing token 恢复写入。

## PI orchestration closeout

根 Task 确认终态、取消/关闭或明确终止编排时，Server 原子结束 orchestration claim、关闭 run 并撤销未完成 lease、deadline 与 Offer 的收尾事实；历史 Task、event、audit 与 provenance 继续保留，迟到输入不能自动重启。
_Avoid_: 删除历史、进程退出即 closeout、迟到 notice 复活 run、waiting 等同终态、隐式 reopen。

## PI reconciliation

任一 Server 副本根据持久事实重复发现非终态 run、过期 lease/deadline、可运行调度项、待投递 outbox 与恢复异常，并以 revision、幂等身份、唯一约束和 fencing 只提交一次修复的恢复过程；单例 leader 可以降噪，但不是正确性前提。
_Avoid_: 单进程内存恢复、多副本重复提交、leader 丢失即停摆、按 daemon 在线状态猜进度、重做已有 event。

## Task DAG revision

Server-owned Task DAG 的不可变结构版本，PI 只有携带当前预期 revision 与有效 driver lease 才能原子新增或替代节点、依赖与验收关系；Agent 子 Task 状态仍由各自 claim/revision 推进，并通过 Server event 唤醒 PI 重新评估。
_Avoid_: PI lease 锁住所有 Task 写入、原地删除已执行节点、Agent 修改 DAG、并发状态静默覆盖、无关子 Task 阻塞整图。

## PI orchestration command

当前 PI driver 携带 run revision、有效 lease/fencing 与 idempotency key 向 Server 提交的一次原子编排变更；Server 在同一事务中校验并提交 Task/DAG、run、调度、deadline、event、audit 与 outbox，失败不产生部分事实。
_Avoid_: PI 本地写状态、拆分事务、先发 notice 后落库、重复派发、部分 DAG、过期 driver 写入。

## PI orchestration event

只描述已成功提交的 PI orchestration command 所产生权威变化的不可变 Server 事实，用于恢复、重放与投影；失败或被拒绝的命令不产生此类 event。
_Avoid_: 命令尝试日志、失败即事件、notice delivery、模型推理、重复请求产生第二条业务事实。

## Orchestration attempt audit

Server 对编排命令或恢复动作的发起者、依据、revision/lease/fencing、幂等身份与成功或拒绝原因保存的最小可审计记录；拒绝 audit 可以存在，但不得推进 Task、DAG 或 run 事实。
_Avoid_: PI orchestration event、完整 prompt、secret、越权上下文副本、失败 audit 触发业务 outbox。

## PI planning attempt

PI worker 基于特定 run revision 与 driver lease/fencing 发起的非权威管理模型调用，可因超时或接管而重复或失效；模型响应只有经当前 driver 重新验证并成功提交 PI orchestration command 后才形成编排事实。
_Avoid_: 模型响应即 Task/DAG、exactly-once provider call、旧 lease 响应写入、prompt cache 充当 checkpoint、chain-of-thought 恢复事实。

## PI recovery checkpoint

绑定 run revision、最后 event sequence、schema version 与内容校验值的 Server 编排快照，只用于加速重放；它可以被丢弃或重建，不能包含未提交事实，也不能覆盖权威 Task/DAG/run 与 domain events。
_Avoid_: 第二事实源、PI 内存快照、daemon cache、未提交草稿、checkpoint 缺失即丢失编排。

## PI recovery pending

Server 无法用当前兼容规则安全恢复一个非终态 PI orchestration run 时的显式停写状态；它保留既有事实、停止新编排并等待兼容恢复或人工处理，不允许猜测进度继续执行。
_Avoid_: 自动跳过未知 event、从模型上下文补事实、静默重启、带不完整状态继续派发。

## Protocol expiry

Server 对 driver lease、Offer、acceptance 或授权 token 等限时协议权利执行的权威失效；到期可以直接、幂等地撤销继续使用该权利的资格，不需要 PI Manager 作业务判断。
_Avoid_: Task SLA、业务失败、PI 自报到期、客户端本地 timer、到期后继续写入。

## PI deadline wake

业务 deadline 到期时由 Server 只产生一次、使等待中的 PI orchestration run 重新可调度的事实；它记录到期并触发恢复，不直接把 Task 判为失败、取消或改派。
_Avoid_: Protocol expiry、timer 直接改变业务结果、重复 deadline event、进程内 timer、Server 自动创建替代 claim。

## Orchestration outbox item

与 PI orchestration command 同事务创建、要求某个 PI worker、daemon 或 Agent 重新检查 Server 最新事实的持久唤醒意图；派生 notice 可以重复或丢失，收到或确认通知都不授予 lease、claim 或业务进度。
_Avoid_: 权威 job payload、exactly-once notice、notice ack 即已处理、daemon 本地队列、推送失败回滚编排事实。

## Task execution compatibility baseline

Agent acceptance 时由 Server 固定的子 Task 执行协议与必要 capability revision，用于判断 daemon 版本变化后当前 claim 是否仍可安全履行；版本字符串变化本身不取消 claim，不兼容或安全撤权才阻断新的执行写入并唤醒 PI 恢复。
_Avoid_: daemon 版本即 claim revision、升级后自动重做、为旧 daemon 降级 Server 事实、本地兼容性自判、迟到结果绕过 claim 校验。

## Task allocation

PI Manager 为一个结构化 Task 选择定向指派或开放认领的协作决定；显式 @Agent 必须形成定向指派，多能力任务可以在分解后分别决定分配方式。显式 @ 是主执行者硬约束：PI 不得静默改派；仅在该 Agent 拒绝、超时或 relinquish 后才可另荐，且改派对用户可见。派发与 Task offer 的候选硬边界是当前频道 agent 成员（且 Team 可见、能力与权限匹配）；不得静默指派或邀请未加入该频道的 Team Agent。
_Avoid_: Agent 争抢原始频道消息、所有任务统一抢占、PI 任意改写显式目标、把 @ 当作可静默覆盖的软提示、跨频道静默拉人执行。

## Task assignment projection

子 Task 当前定向邀请或优先候选的可重建展示事实，不授予执行权；根 Task 不存在 assignment，子 Task 只有 active Agent execution claim 才表示当前履约责任，兼容 `assigneeId` 不能用于授权。
_Avoid_: assignee 即 claim、根 Task assignee、残留 assignee 表示仍负责、用 projection 校验 invocation、显式 @ 自动建立 claim。

## Uncoordinated message intake

不存在权威 PI orchestration trigger 时，人类频道消息进入 Agent 工作的路径只有：显式 @Agent 的 Simple agent request，或已经绑定到既有 Tracked task 的跟进。Semantic promotion rollout 关闭、旁路或不可用不影响确定性结构化 trigger 进入 Promotion gate；原始消息本身不可被 Agent claim，也不因「频道内谁先在线」而隐式指定负责人。
_Avoid_: evaluator 关闭即禁用结构化 trigger、PI 自动协调总开关、原始消息抢答、隐式 fallback 负责人、谁先 claim 谁负责（针对聊天消息）、把未 @ 直派当作日常默认。

## Coordinated message intake

Message delivery 之后只有权威 PI orchestration trigger 可以进入根 Task 编排；普通消息、Simple agent request 与既有 Task follow-up 各自保持原语义，不经过每消息协调入口。
_Avoid_: 每消息 Channel coordination decision、legacy 未 @ fallback Dispatch、asTask/@Agent/DM/Thread owner 并行触发编排。

## Task offer

向通过当前 Channel eligibility 硬门槛的 Agent 发布的结构化认领机会；候选唯一、用户明确指定合格 Agent、排名存在可审计的明显赢家，或敏感上下文要求最小披露时使用 targeted Offer，多个相近候选时使用有界 candidate-set Offer。两种模式都要求有效接受后才原子形成唯一 claim，且从不针对原始频道消息开放抢答。
_Avoid_: 原始聊天广播、强制定向指派、重复 Dispatch、无约束抢答、频道外 Offer、对原始消息的 claim。

## Agent execution claim

Agent 明确接受仍有效的 Task offer 后取得、绑定子 Task revision 与 attempt 的限时履约责任，只授权执行、提交交付、报告 blocked 或 relinquish；它不授予修改 Task DAG、认领根 Task 或把自身交付标记为 `done` 的权力。
_Avoid_: PI orchestration claim、根 Task ownership、assignment 即 claim、自报完成即验收、跨 revision 复用、claim 自动改 DAG。

## Subtask acceptance authority

当前 PI driver 依据冻结验收条件与 Server evidence 对子 Task 交付作出接受或退回的受 fencing 权力；需要主观、人类或高风险判断时必须转为等待人类，不能由 PI 或执行 Agent 代验收。
_Avoid_: Agent 自验收、claim 包含 done 权、模型输出即接受、旧 driver 验收、人类门槛静默降级。

## Subtask human acceptance authority

子 Task 创建时按 acceptance kind 预先绑定的可审计人类验收权：普通主观验收默认属于当前 root Human review authority，高风险或受管动作属于该动作策略预声明 approver；其 Server token 绑定子 Task revision、attempt 与 delivery，只能通过具名 accept/reject command 原子执行 `in_review → done` 或失效旧 claim/delivery、递增 attempt 并退回 `todo`。
_Avoid_: 任意 Team member 验收、PI 代替人类、复用 root review token、action approval 自动等同交付验收、等待人类但没有合法状态边。

## Subtask retry attempt

子 Task 交付被退回或一次有效执行失败后形成的新履约轮次；Task 回到 `todo`、旧 claim/delivery 失效并递增 attempt，PI 重新 allocation，只有目标、范围或验收条件变化才同时递增 Task revision。
_Avoid_: 退回后自动续租旧 claim、attempt 等同 Task revision、原 Agent 永久保留责任、覆盖旧 delivery、失败直接终结根 Task。

## Task execution start

Agent 取得 execution claim 后，Server 首次接受绑定该 claim、Task revision 与 attempt 的显式 `start-execution` command 或首个授权 Invocation 时写入的不可变事件；claim 建立会让子 Task 进入 `in_progress`，但只有该事件证明本轮已实际开工。
_Avoid_: Offer accept 自动等同开工、heartbeat/notice 推断开工、客户端时间戳、无 claim Invocation、重试覆盖首次开工证据。

## Task allocation round

PI 为同一子 Task revision/attempt 寻找并确认执行 Agent 的一次分配轮次；Offer 拒绝、过期、无人接受，或 claim 建立后尚无 Task execution start 事件时 relinquish，只结束当前 allocation round，不递增 execution attempt。
_Avoid_: Offer 失败等同执行失败、每次候选通知递增 attempt、assignment 即 claim、用 TaskStatus 猜测是否开工、无人领取自动终结根 Task。

## Subtask transition graph

可执行子 Task 只允许 `created → todo → in_progress → in_review → done`；有效 claim 原子进入 `in_progress`，Task execution start 单独记录实际开工，交付进入审核，合法 PI 或 Subtask human acceptance authority 接受后完成，退回或开工后失败以新 attempt 回到 `todo`；开工前 relinquish 以同一 attempt 回到 `todo`，授权 PI 或 root cascade 可把任一非终态推进为 `cancelled`/`closed`。
_Avoid_: Agent 直接 done、无 claim 进入 in_progress、用 in_progress 猜测实际开工、退回保留旧 claim、失败直接终态、终态 reopen、未列出的自由状态更新。

## Task impediment

阻止当前子 Task 继续执行、但不改变 TaskStatus 的结构化事实，记录 blocker、resolution owner 与 wake condition；Agent 若仍负责恢复则 Task/claim 保持 `in_progress`，否则结束 claim，并以是否存在 Task execution start 事件决定是否递增 attempt。
_Avoid_: blocked TaskStatus、heartbeat 猜测已解除、长期阻塞自动取消根 Task、无责任人 blocker、报告 blocked 即自动改派。

## Task execution failure

一次子 Task execution attempt 或 invocation 未能产生可验收交付的权威结果；它结束相应执行权并触发重试或人类等待，但不是 TaskStatus，也不能由 PI 自动推导为根 Task 终态。
_Avoid_: failed TaskStatus、失败次数自动取消根 Task、覆盖失败证据、重试复用旧 claim、预算耗尽即 closed。

## Subtask retirement authority

当前 PI driver 在既有根目标、授权范围与 Task DAG revision 内取消、关闭或等价替换不再需要的子 Task 的编排权；若会删除 required 工作、降低验收标准或改变根目标，必须先形成 root Task revision，并在越界时取得人类确认。
_Avoid_: PI 终结根 Task、静默删 required 节点、保留旧 claim/invocation、删除历史交付、用子 Task 调整绕过 scope approval。

## Subtask replacement

当前 root/DAG revision 不再能使用某个已终态子 Task 时，由 PI 创建并通过 DAG relation 显式替代它的新子 Task；旧 Task、acceptance 与 evidence 保持不可变，但不计入当前 root review readiness。
_Avoid_: reopen done/cancelled/closed 子 Task、覆盖旧验收、复用旧 claim/attempt、删除原节点、静默把旧结果计入新 revision。

## Root Task cascade closeout

根 Task 进入任一终态时对任务树执行的原子收尾：`done` 要求 review readiness 已退休所有未完成 optional 节点，并防御性撤销任何残留 claim、Offer、invocation、deadline 与待执行权；`cancelled` 或 `closed` 还会终结所有非终态子 Task。三种结果都保持已 `done` 子 Task、历史 delivery/evidence 与 provenance 不变。
_Avoid_: done 后仍有活动子任务、把已完成子 Task 改成 cancelled、迟到结果复活任务、分批撤权、删除历史交付、只关根 Task 让子任务继续执行。

## Tracked task

由 Promotion gate 从权威 PI orchestration trigger 创建、需要持续跟踪、依赖恢复、多 Agent 协作、结果聚合或人工审核的持久工作承诺；创建它只授权组织工作，不授权其中的高风险执行。
_Avoid_: 每消息 Task、聊天记录别名、Promotion proposal、Action approval、把单 Agent 请求一律建单。

## Simple agent request

Server message intake 根据显式 @Agent 确定性路由给一个外部 Agent、且不创建 Tracked task 的人类请求；Agent 后续若发现需要编排，只能走结构化 Agent orchestration escalation。
_Avoid_: PI 每消息判定、未 @ 消息隐式选 Agent、单人任务必建 Task、把简单请求项目管理化。

## Task creation gate

旧称，统一使用 Promotion gate。
_Avoid_: 与 Promotion gate 并存的第二套入口、PI Manager 自行判断并创建根 Task。

## Coordination message

PI Manager 以 AgentBean 系统协调身份发出的必要用户可见内容，包括澄清问题、紧凑的 Task 状态和注明贡献 Agent 与来源 Task 的最终汇总。多 Agent 场景下，各执行者的原始交付仍归原 Agent；PI 汇总并列呈现，不改写、不顶替、不冒充为唯一成品消息。
_Avoid_: PI 成员消息、伪装成外部 Agent、内部推理展示、冗长计划播报、用 PI 合成正文替换执行者署名交付。

## Progress coordination

PI 对 Tracked task 的进度维护方式：在子任务完成、失败、relinquish、超时或用户追问等事件上更新状态并发紧凑 Coordination message；不在无事件时主动轮询催办。
_Avoid_: 定时催办刷屏、无事件频道进度播报、仅面板可见而频道对进度完全静默（用户关闭自动协调时除外）。

## Team-scoped Agent Memory

一个 Team 内关于特定外部 Agent 的职责、偏好和可复用经验；它由 `Team + Agent` 共同界定，同一个 Agent 在不同 Team 中拥有彼此隔离的协作记忆。
_Avoid_: 跨 Team Agent Memory、Agent 全局人格、Agent 私有 Session 历史。

## Device-local Agent Memory

归属于设备所有者、本地 Agent 与本地工作空间的记忆，不天然属于任何 Team。只有经过明确授权和最小化投影后，才能进入某个 Team 的协作上下文。
_Avoid_: Team Agent Memory、自动上传记忆、跨 Team 共享缓存。

## Reusable Experience Pack

从已完成项目的频道经验中整理出的、带来源、适用条件和排除条件的可复用知识单元。它保存在 Team Experience Library 中，但默认不进入任何频道上下文，只有显式关联后才可在目标频道使用。
_Avoid_: Team Memory、频道历史副本、自动跨频道记忆。

## Team Experience Library

一个 Team 保存 Reusable Experience Pack 的待复用知识集合；进入该集合不代表对所有频道生效，也不授予跨频道读取源内容的权限。
_Avoid_: 全局 Active Context、Team Memory 同义词、频道聊天归档。

## Experience Pack attachment

用户确认将一个 Reusable Experience Pack 用于目标频道的授权关系。关联可以撤销，PI 可以推荐关联，但不能静默创建关联。
_Avoid_: 自动继承、隐式复制、全 Team 广播。

## Explicit Memory

由用户明确要求记住、由已确认交付明确确定，或经用户确认复述后的正式记忆。它可以在原作用域内直接生效，并且必须提供可见提示和撤销能力。
_Avoid_: 模型推断、隐式偏好、未确认总结。

## Inferred Memory Candidate

PI 从对话、行为或多条事实中推断出的偏好、规律、评价或经验草稿；它在用户确认前不属于正式记忆，也不能影响后续协作决策。
_Avoid_: 自动生效推断、隐藏画像、正式 Memory。

## Memory scope expansion

使记忆进入比原来源更宽的可见或可用范围，包括跨频道、Channel 到 Team、Device-local 到 Team，或将特定 Agent 记忆提供给其他 Agent。PI 只能提出扩展建议，用户确认后才能生效。
_Avoid_: 自动晋升、隐式共享、来源权限继承替代复验。

## Active Memory Context

PI Manager 为当前消息或 Task 临时组合的最小相关记忆集合，由少量核心 Team Memory、当前频道相关记忆、已关联经验包和当前 Task 事实组成。Memory 的作用域决定能否检索，相关性与显式关联决定是否进入该集合。
_Avoid_: 全量 Memory prompt、Team Memory 全部自动注入、长期 Session 事实源。

## System Knowledge

由系统管理员维护并随产品版本治理的 AgentBean 功能、规则与安全知识。它不是 PI 从用户聊天中学习得到的 Memory，也不能被频道内容自动改写。
_Avoid_: AgentBean 全局记忆、Team Memory、模型自学习事实。

## User Memory

只描述当前用户自身稳定偏好和工作习惯、可在该用户有权访问的多个 Team 中使用的记忆。它不得包含任何 Team 的业务事实、频道摘要、客户数据、项目内容或其他用户信息。
_Avoid_: 跨 Team 业务记忆、用户画像仓库、Team Memory。

## Cross-Team business knowledge

源自一个 Team 的业务事实、项目经验或协作内容，并被提供给另一个 Team 的知识。AgentBean 默认不存在这种共享，只能通过未来显式的导出、共享与接收流程建立。
_Avoid_: AgentBean 全局记忆、同 owner 自动共享、Agent 携带共享。

## Memory governance access

Memory 的来源作用域决定谁可查看，作用域管理员决定正式审批、编辑与删除。Team Memory 对 Team 成员可见并由 Team Owner/Admin 管理；Channel Memory 对频道成员可见并由 Team Owner/Admin 管理，频道成员可纠错或申请删除；Team + Agent Memory 的公开投影由 Agent 所有者管理、Team Owner/Admin 决定本 Team 是否使用；User Memory 仅用户本人管理；System Knowledge 仅系统管理员管理。
_Avoid_: PI 管理员读取所有 Memory、普通成员直接改正式记忆、Agent 内部 Memory 浏览。

## Memory use explanation

当 Memory 实际影响 PI 回答、Task 分解或 Agent 选择时，向当前用户说明使用了哪些其有权查看的 Memory 与来源。解释必须遵守原始权限，不能为了可追溯性泄露其他 Channel、Team、User 或 Agent 未公开内容。
_Avoid_: 隐藏影响、全量 prompt 展示、越权来源引用。

## Channel Coordinator

旧称，不再作为产品角色使用；普通消息的升级建议属于 Promotion evaluator，已创建根 Task 的编排属于 PI Manager。
_Avoid_: 每消息 PI Manager、Channel coordination decision、将 evaluator 与 orchestration 合并。

## Device-only coordination

旧的每消息 Channel Coordinator placement 方案，不进入当前 PI MVP，设置页不展示；Promotion evaluator 与 PI Manager 均为 Server 能力，Device 继续提供本地执行能力。
_Avoid_: 当前 Team placement、Device-hosted Promotion evaluator、Device-hosted PI Manager、静默降级。

## PI MVP placement

首个 PI MVP 中 Promotion evaluator 与 PI Manager 的执行位置均为 AgentBean Server：前者只在授权 rollout 下无副作用评估普通消息，后者只在根 Task 创建后编排。全系统 Active PI Model 绑定一个 Server-hosted PI Provider Card 中的模型；Device Agent 继续承担本地文件、Workspace、Shell 和 Device-local Memory 等 Task 执行。
_Avoid_: 每消息 Channel Coordinator、Device-only coordination、Team placement 选择、Device Agent 被移除。

## Supported user device platform

AgentBean 当前对用户设备能力作出的平台承诺，仅包括 macOS，并同时覆盖 Apple Silicon arm64 与 Intel x64。Device Service、Agent 扫描与执行、本地文件访问、原生选择器、安装和升级不再为 Windows/Linux 新增实现或发布保证；现有跨平台代码可保留但不构成产品能力。Server 与 Web 继续运行在 Railway/Vercel 的云端环境，不受该终端平台限制。
_Avoid_: 仅 arm64、Rosetta 作为正式兼容、Server 必须运行在 macOS、Windows/Linux Device 承诺。

## Supported macOS architectures

AgentBean 用户设备首版必须原生支持 `darwin-arm64` 与 `darwin-x64`。两种架构都需要对应的可安装产物、签名/公证流程和真实启动及 Device 能力验证；不能用 arm64 单架构结论外推 Intel，也不能只要求 Intel 用户通过 Rosetta 运行。
_Avoid_: arm64-only、未经验证的 universal binary、Rosetta-only。

## Active PI Model

系统管理员从已发布 PI Provider Card 中选择一个 Model ID，形成全系统唯一生效的 PI 模型绑定。所有 Team 的实时协调、深度编排和 Memory 管理统一使用它，不能选择或覆盖，也不向 Team 或普通用户披露 Provider、Model、Endpoint 或切换历史；这些细节只对系统管理员可见。
_Avoid_: PI Runtime Profile、Team 模型选择、按 Team Provider、公开底层模型身份。

## PI Provider Card

系统管理员维护的一份完整 Server provider 配置，也是 PI Provider Supply 在 MVP 中的基本管理单元。它从预设或 Custom 创建，包含显示信息、协议、Endpoint、Credential 引用、可选模型目录、默认模型和经过校验的高级配置；支持复制、模型获取、生产同路径测试、备注与控制台链接。高级配置不作为默认入口，Credential 不向 Team 暴露。
_Avoid_: Provider Connection 与 Model Deployment 多层对象、Team 模型配置、可回显明文 Credential。

## PI Provider Card revision

PI Provider Card 的不可变 Draft 或 Active 配置版本。编辑已发布 Card 只产生 Draft；测试通过并由系统管理员发布后，新 revision 才可被 Active PI Model 使用。进行中的 Run 继续使用启动时固定的 Card revision；刷新模型目录不自动改变 Active PI Model 的 Model ID。
_Avoid_: 即时覆盖、运行中配置漂移、模型列表刷新即切模型。

## PI Provider Card advanced configuration

PI Provider Card 普通表单的受限 JSON 投影，而不是任意请求透传。MVP 只允许编辑 Schema 明确支持的 `baseUrl`、`endpointMode`、`modelId`、`timeout`、`maxOutputTokens` 和少量兼容参数；Credential 只显示不可编辑的引用。保存必须通过 Schema 与真实模型测试。
_Avoid_: 明文 Credential、OAuth、Shell 命令、环境变量插值、任意 Headers、任意 Request Body。

## PI Provider Protocol

PI Provider Card 与模型运行之间的传输协议。MVP 只实现 `openai_chat_completions`：Bearer API Key、OpenAI-compatible messages 与 tool calls，以及 `/chat/completions` 请求语义。Provider 预设可以有不同品牌名称，但只有通过该协议兼容性测试才能启用。
_Avoid_: Provider 名称推断原生协议、Anthropic Messages、OpenAI Responses、Gemini、Bedrock、OAuth。

## PI Provider Preset

用于快速创建 PI Provider Card 的系统内置默认配置。MVP 只提供 OpenAI、OpenRouter、DeepSeek 与 Custom OpenAI-compatible 四类；Preset 只填充显示信息、Base URL、Endpoint Mode 和已知兼容参数，不代表模型已经可用，仍需选择模型并通过真实 tool-call 测试。
_Avoid_: Provider 支持证明、庞大合作商目录、原生协议 Adapter。

## PI model discovery

PI Provider Card 使用当前 Endpoint 与 Credential 调用 Provider 的模型列表接口并让系统管理员选择 Model ID 的辅助流程。Provider 不支持发现接口时允许手工填写；发现结果变化不会自动改写 Active PI Model。
_Avoid_: 自动启用所有模型、模型池、运行时 fallback。

## PI model test

通过与生产 Management Model Adapter 相同的非流式请求与解析路径，对 PI Provider Card 中选定模型执行固定无业务数据的普通文本响应和完整 tool-call 回合，并验证鉴权、Model ID、响应格式、finish reason、usage、超时与取消。Card 可以保存为 Draft，但只有测试通过并发布后，其中的模型才能设为 Active PI Model。
_Avoid_: 只 ping Endpoint、使用真实业务消息、单独 Streaming/TTFB 测试、模型列表成功即视为可运行。

## PI token usage telemetry

每次 ManagementRun 从 Provider 响应中记录的 input/output Token 数量，只用于上下文增长、异常消耗和模型响应诊断。MVP 不由此计算金额、执行 Token 配额或自动停用；Provider 未返回 usage 时标记为“未知”，不阻止 Provider Card 发布。
_Avoid_: 费用、账单、Team 配额、伪造为零。

## PI degraded

Active PI Model 在有限同模型重试后仍不可用的显式全系统运行状态。频道消息继续保存和展示，但 PI 暂停自动建 Task、分解、认领和 Memory 写入；Team 与普通用户只看到 PI 正常、降级或不可用，不看到 Provider 或 Model 身份。MVP 不静默切换到其他模型。
_Avoid_: 消息发送失败、隐式跨模型 fallback、伪装成正常协调、静默丢弃自动化。

## PI Management

系统作用域的 PI 底座配置能力（Provider Supply、Active PI Model、Rollout、治理与健康）以及 Team 作用域的自动化 / Memory / coverage 治理；两种作用域不共享配置表单。系统作用域入口在 System Admin Console 的 PI Agent 管理（见该术语）；Team 作用域仍在团队设置与 Memory 治理中，不并入全局 Console。
_Avoid_: Team 详情页内的 PI 表单、系统与 Team 混合保存、把系统 Provider 管理放回设置一级 Tab。

## System Admin Console

仅系统管理员可进入的全局运维壳：在保留应用左侧业务主导航的前提下，主区内再分**中栏导航 + 右栏内容**。入口仍可叫「仪表盘」，语义是系统管理，不是 Team 业务页。导航项至少包括团队管理、用户管理、设备管理、Agent 管理与 PI Agent 管理；路由为 `/{teamPath}/dashboard/{section}`，其中 `teamPath` 仅为 Web 壳，列表数据为全系统范围。
_Avoid_: Team 设置、普通成员仪表盘、把全局运维塞进个人设置、用当前 Team 过滤全局用户/团队列表。

## PI Agent 管理

System Admin Console 中的 PI 系统作用域管理页，承载原设置中「PI Agent」的系统级职责（如 PI Provider Supply、Active PI Model、系统侧健康与紧急控制，以及系统作用域 System Knowledge）。不再作为设置一级 Tab 的主入口；旧 `settings?tab=pi` 重定向到 `dashboard/pi`。
_Avoid_: 设置里的 PI Agent 主入口、Team PI 自动协调开关、普通 Agent 列表管理、Team Memory Center 塞进全局 Console。

## Team Memory governance surface

Team 作用域 Memory 的管理入口（Team Memory、Channel Memory、Agent Memory 投影、Candidates、Experience Packs 等），仍面向 Team Owner/Admin 等有权角色，留在设置侧，不并入 System Admin Console 的全局导航。
_Avoid_: 全局 Console 的 Team Memory 列表、把 Team 治理做成系统管理员独占页。

## PI Memory Center

PI Management 的 Memory 管理区域。系统作用域只维护 System Knowledge；Team 作用域集中展示并治理 Team Memory、Channel Memory、Agent Memory 投影、Memory Candidates 与 Reusable Experience Packs。频道和 Agent 页面只提供带当前作用域过滤的快捷入口；User Memory 位于个人设置。
_Avoid_: 独立顶级 Memory 产品、跨 Team 混合列表、Agent 内部 Memory 浏览器。

## Formal Memory

已在其作用域内生效、可以进入检索与 Active Memory Context 的版本化 Memory。授权角色可以直接创建或编辑 Formal Memory，不要求先由 PI 生成 Candidate；每次变更记录操作者、时间、来源和原因。停用后立即退出有效上下文，但不反向改写原频道消息或历史交付。
_Avoid_: PI Candidate 唯一入口、覆盖式编辑、停用即删除来源。

## Memory kind

Formal Memory 与 Memory Candidate 的固定 MVP 类型：`fact` 表示已确认事实，`decision` 表示已经作出的决定，`rule` 表示必须遵守的流程或约束，`preference` 表示非强制偏好。每条只保存类型、简短内容、作用域、来源、状态、创建/更新时间和可选失效时间；项目经验使用 Reusable Experience Pack。
_Avoid_: 自定义类型、知识图谱、实体关系、经验塞入单条 Memory。

## Memory conflict

同一作用域内新的 Formal Memory 与已有有效 Memory 可能互相矛盾的保存状态。PI 不自动覆盖或合并，授权管理者只选择由新 Memory 取代旧项并将旧项标记为 `superseded`，或确认二者同时保留；无法判断时新内容保持 Candidate，不影响有效上下文。
_Avoid_: 跨作用域复杂优先级、模型自动裁决、静默覆盖。

## PI Provider Supply

由系统管理员通过 PI Provider Cards 管理的 Provider、Credential、模型选择与健康供给。MVP 不包含模型池或自动 fallback；系统管理员指定全局 Active PI Model，所有 Team 零模型配置统一使用且不获知底层身份。
_Avoid_: Team 模型配置、Team Credential、Team 运行方案。

## PI Rollout State

系统管理员用于紧急停用、旁路评估或正式启用 PI Manager 编排 runtime 的系统运行状态；普通消息的语义建议另由 Semantic promotion rollout 控制。它是发布与故障控制，不属于 Team 的日常产品设置。
_Avoid_: Channel Coordinator rollout、Semantic promotion rollout、Team PI 模式、自动化权限、placement。

## Team PI Automation Policy

旧的每消息 PI 自动协调总开关；它不再控制消息理解或 Message-to-task promotion，promotion 改由 Team promotion policy 与 Semantic promotion rollout 明确治理。
_Avoid_: 默认开启语义建单、关闭时仍默认理解消息、把 proposal rollout 与 Task 内编排权限混成一个开关。

## System PI Governance Boundary

系统管理员为所有 Team 设定的 Provider 供给、Active PI Model、安全、数据处理和紧急停用硬边界。任何 Team 角色都不能越过该边界。
货币成本治理不进入 MVP，首版只实现 Provider、全局模型、安全、数据处理与紧急停用边界。
_Avoid_: Team 配置、日常 PI 运营、默认偏好。

## Team PI Governance Ceiling

Team 所有者在系统边界内设定的数据可见范围与最高 Phase。Team 管理员可以在该上限内运营或收紧 Team promotion policy 与 Semantic promotion rollout，但不能扩大它；任何 Team 角色都不能查看、选择或覆盖 Active PI Model。货币成本属于未来能力，MVP 不提供相关字段。
_Avoid_: PI 自动协调总开关、系统全局边界、管理员日常选择、单次 Run 决策。

## Task-linked message

通过 Task 详情、Task 讨论串、回复 Task 系统消息或明确 Task 引用而与现有 Task 强绑定的用户消息。缺少强绑定时，PI 只能在高置信的小范围补充中自动建议关联，模糊或重大变更必须请求用户确认。
_Avoid_: 同频道自动归属、最近 Task 猜测、任意语义合并。

## Task revision

对已开始执行的 Task 目标、范围或验收要求所做的可追溯新版本。它保留旧要求与交付历史，并使受影响的旧认领、调用或验收失去当前效力，而不是原地覆盖。
_Avoid_: 编辑覆盖、隐藏变更、复用旧执行权。

## Task revision impact set

一次 root Task revision 明确列出的受影响目标、验收条件、DAG 节点与依赖；受影响子 Task 的旧权利失效，已证明不受影响的已验收结果可以显式 carry forward，无法证明时默认重新验证。
_Avoid_: revision 后全树静默复用、无差别全量重做、模型主观声称不受影响、carry forward 丢 provenance、旧 claim 跨影响集继续执行。

## Artifact source root

一次 Agent 运行收集文件时采用的有边界来源目录，例如该 Run 的输出目录、Agent 工作目录或 Agent 配置的额外输出目录。频道成员只看到稳定的来源标签和根内相对路径；真实设备路径不构成公开身份，source root 及其相对路径也不能单独决定文件的业务角色。
_Avoid_: 无作用域绝对路径、项目产物类型、最终版目录。

## Artifact role

Agent 结果清单或 Server 授权流程为文件明确记录的协作角色，例如中间产物、普通运行产物或交付物。目录可以提供默认分类信号，但最终版必须由独立的人类确认或审核事实确定。
_Avoid_: 路径推断、文件名标签、`pathKind`、最终版指针。

## Run artifact

一次 Agent Run 从某个 Artifact source root 收集并保留来源路径的不可变文件。中间 Run artifact 在频道文件视图的“运行产物”下可供预览和下载；编辑其中的 Markdown 会派生新的 Channel document，不能回写历史 Run。
_Avoid_: 频道文档、可变工作区文件、最终版。

## Channel file directory

频道文件视图根据 Artifact source root 和根内相对路径形成的导航层，只表示当前层级实际存在的文件与子路径。它不拥有独立权限或生命周期，空路径也不会被推断为真实目录。
_Avoid_: Agent 设备绝对目录、独立文件夹实体、递归文件平铺。

## Channel file index

Server 为一个频道维护的权威文件读模型，统一投影公开消息附件、Channel document 最新版、交付物和允许公开的 Run artifact。它支持目录、分页、搜索、角色筛选和稳定排序，不能由浏览器已加载的消息临时推断。
_Avoid_: 聊天附件平铺、客户端消息缓存、内部日志、预览衍生资源。

## Artifact preview derivative

系统为某个不可变 Artifact（包括 Message artifact revision 和 Run artifact）异步生成的受限尺寸预览资源，例如图片缩略图、视频首帧或 PDF 首页。它只用于安全高效地展示文件，不是频道文件、文档 revision、Agent 输入或用户交付物。
_Avoid_: 原文件、可下载产物、文件目录项、同步上传前置条件。

## Channel archive

用户对频道所代表项目已经结束的权威声明，也是 PI 发起项目收尾、Memory 候选与 Reusable Experience Pack 建议的边界事件。它不依赖 PI 从静默时间或 Task 状态推测项目是否结束。
_Avoid_: 独立 Project 完成状态、静默超时、PI 自动判定项目结束。

## Channel archive gate

Channel archive 前对该频道全部非终态 Task、Invocation、claim、lease 和待审核交付进行显式收尾的事务边界。用户必须确认取消未完成工作，系统保留历史事实并停止归档后的新执行。
_Avoid_: UI 隐藏、后台继续执行、静默取消、跨频道搬迁 Task。

## Archived Channel Memory

Channel archive 后冻结的原频道记忆，只作为归档查看、审计和来源复验的只读历史，不再直接进入任何活跃频道的 Active Memory Context。此前已明确批准的 Team Memory 或 Reusable Experience Pack 投影不因归档自动失效。
_Avoid_: 可继续检索的 Channel Memory、删除的 Memory、自动跨频道来源。

## Agent Capability

Agent 通过对外契约声明自己当前可以接受的操作类型、输入输出、约束和可用状态。Task 的 `requiredCapabilities` 是候选资格的硬门槛，但 PI 只能使用 Agent 暴露的信息与 AgentBean 可观测的连接状态，不能检查其内部运行环境、工具或权限实现。
_Avoid_: Agent 内部权限、Agent Skill、相似任务经验、模型推断出的擅长领域。

## Agent Skill

Agent 通过对外契约主动声明、愿意用于任务匹配的专业方法能力。Task 可分别声明硬门槛 `requiredSkills` 和只参与排序的 `preferredSkills`；声明不代表 PI 知道该 Skill 是否安装、如何实现或依赖什么内部资源。
_Avoid_: Agent 内部 Skill 清单、Capability 标签、PI 猜测、一次成功执行自动生成的 Skill。

## Agent Exposure Manifest

由 Agent 或其适配器主动发布给 AgentBean 的结构化公开契约，包含愿意暴露的 Capabilities、Skills、版本、约束、可用状态和有效期。PI 只能据此做候选匹配，不得扫描 Agent 文件、核验内部依赖，或把未暴露的信息补入 Manifest。
_Avoid_: Agent 内部清单、PI 探测、永久有效缓存、自然语言自述。

## Team Agent Exposure

Agent 或 Agent 所有者向特定 Team 发布的 Agent Exposure Manifest 投影。PI 只能看到当前 Team 的投影；Team Owner/Admin 可以通过治理规则进一步禁用已暴露的操作，但不能扩大投影、查看其他 Team 的投影或要求 Agent 暴露内部信息。Channel 复用所属 Team 的投影，并由频道权限限制上下文与请求资格。
_Avoid_: 全局 Agent Skill 目录、Channel 独立 Skill 清单、Team 强制暴露。

## Manifest revision

一次 Team Agent Exposure 的不可变版本标识。Task Offer 同时固定 `taskRevision` 与 `manifestRevision`；相关 Capability 或 Skill 被撤回后，尚未接受的旧 Offer 失效。Agent acceptance 形成独立履约承诺后，Manifest 后续变化不自动取消该 Task。
_Avoid_: 活动 Task 配置、内部 Skill 版本、无版本覆盖更新。

## Claim relinquishment

Agent 在接受 Task 后明确声明无法继续履约并交还 claim 的协议事件。它触发 PI 重新规划、交接或失败处理；Manifest 改变本身不能替代 relinquishment。System/Team 的当前安全撤权可以越过该承诺并停止相关操作。
_Avoid_: 静默离线、Offer 拒绝、Manifest 撤回。

## Task Offer

PI 根据 Agent Exposure Manifest 向候选 Agent 发出的结构化协作请求，包含目标、输入、交付物、约束、required Capabilities、required Skills、时限和风险。Offer 不等于分配；Agent 可以接受、拒绝、请求补充信息或提出调整建议，只有明确接受后才产生有效 claim/lease。
_Avoid_: 强制指派、已认领 Task、原始频道消息广播。

## Requirement-confirmation Offer

用户确认后向 required Capability/Skill 状态为 unknown 的显式目标发出的受限 targeted Offer，是普通 Offer 发布资格门槛的唯一例外；发布时仍须复验 Channel membership、Team visibility、Task preview 权限、operation restriction、状态确为 unknown 且不存在明确不满足事实。它只能请求 Agent 更新 Manifest 或随 acceptance 提交 Per-Task requirement attestation，在 accept/claim 事务完成全部 requirement 与容量复验前不得建立 claim、签发 execution context grant 或披露执行输入。
_Avoid_: unknown 自动 eligible、用户代 Agent 声明能力、权限例外、明确不满足仍发 Offer、确认 Offer 直接执行、候选集广播。

## Task allocation mode

PI 在同一 Task Offer / Agent acceptance 协议内选择的请求路由方式：用户明确指定合格 Agent、只有一个合格候选、确定性排序存在可审计的明显赢家，或敏感上下文要求最小披露时使用 `targeted Offer`；多个相近候选或负载未知时使用有界 `candidate-set Offer`。它只决定向谁请求，不得绕过 eligibility、acceptance 或原子 claim。
_Avoid_: PI 强制 claim、`@Agent` 等同分配、无界广播、派发模式改变 Task contract、targeted 绕过权限。

## Candidate-set Offer

针对同一 Task revision 向一个有界合格候选集签发的互斥 Offer 集合；每个候选只获得判断是否接受所需的最小 contract，首个通过最新资格复验的 acceptance 原子建立唯一 claim，并在同一事务关闭其余 Offer。拒绝、超时或关闭的候选不得获得后续输入或 Invocation。
_Avoid_: 多个成功 acceptance、多个有效 claim、完整上下文广播、失败候选继续收到更新、先到先执行后补事务。

## Task offer preview

Task Offer 向候选 Agent 披露的最小决策视图，包含目标、交付物、硬要求、约束、风险、deadline 以及输入类型和敏感性摘要，但不默认展开完整 input bindings；候选必须已获当前读取权限，Offer/token 本身不授予数据访问。
_Avoid_: 完整执行上下文、Offer token 下载敏感输入、整个根 Task、兄弟 Task、PI 内部上下文、先披露后检查权限。

## Agent acceptance

Agent 对一个仍有效的 Task Offer 作出的明确接受承诺，是 PI 将候选关系转换为正式 claim/lease 的必要条件。用户显式 `@Agent` 只决定优先询问对象，不能替代 Agent acceptance；Offer 超时或 Task revision 后，旧 acceptance 失效。
_Avoid_: Manifest 匹配、消息已送达、PI 单方面分配。

## Task execution context grant

Server 在 Agent acceptance 原子建立 claim 后签发的限域执行访问事实，绑定 Agent、task revision、attempt 与 claim，只解析该 Executable subtask contract 已冻结的 input bindings。relinquishment、fencing、安全撤权或 revision impact 会使旧 grant 失效；新的执行责任必须取得新 grant。
_Avoid_: Offer 即访问权、ambient Channel history、整个 Task DAG、跨 attempt 复用、落选候选持续拉取、Agent 自行扩展输入范围。

## Task attempt

某个 task revision 的一次独立执行轮次，绑定其 execution claims、lease/fencing、execution context grants、deadline、delivery 与审计；Agent acceptance 只把当前 allocation round 的 claim 绑定到现有 attempt，不自动证明开工或递增 attempt。拒绝、Offer 超时以及尚无 Task execution start 时的 relinquishment/fencing 只结束 allocation round；实际开工后的失败、执行超时、relinquishment 或 fencing 才终止当前 attempt，且不得解析 output slot，重派必须创建新 attempt。
_Avoid_: acceptance 自动递增 attempt、开工前 relinquish 算执行失败、复用旧 claim、跨 attempt grant、迟到 delivery 覆盖当前执行、失败 attempt 解除 dependency、修改 attempt 冒充 Task revision。

## Unaccepted handoff material

失败或终止 attempt 留下、尚未通过 Task acceptance contract 的部分 artifact，只能作为带原 attempt provenance 与未验收标记的来源事实保存；新 attempt 经过权限校验并在 contract 中显式绑定后可以参考，但它不能解析 Task output slot 或被下游当作已完成结果。
_Avoid_: 部分结果自动继承、失败 delivery 当 output、无 provenance 复制、跨 Agent 静默披露、用 handoff 绕过 acceptance。

## Unknown Skill status

Agent 未暴露 Skill 维度、公开声明已过期或无法得到当前响应时的外部状态。PI 只能说“未声明”或“未知”，不能据此断言 Agent 内部没有该 Skill；用户确认只能授权向显式目标发出受限的 requirement-confirmation Offer，Agent 必须更新 Manifest 或在 acceptance 中提交绑定 task revision 的 per-Task requirement attestation，Server 复验后才可建立 claim。
_Avoid_: 未安装、内部缺失、模型猜测、用户替 Agent 声明 Skill、确认直接等同 eligible、权限覆盖。

## High-risk Agent operation

根据 Agent 暴露的操作契约与 Task 预期效果，会产生高成本、敏感数据处理、外部副作用或不可逆结果的 Agent 请求。系统与 Team 治理的是 PI 是否可以发出该请求，而不是 Agent 内部如何安装、实现或授权 Skill。
_Avoid_: 管理 Agent 内部 Skill、安装即授权、PI 内部探测。

## Task Skill Requirement Resolution

PI 先分解任务，再将每个可执行 Task 与当前 Team 可见的 Agent Exposure Manifest 中真实声明的稳定 Skill ID 匹配。只有缺少某 Skill 就无法正确或安全完成时才写入 `requiredSkills`；只改善质量、速度或流程规范时写入 `preferredSkills`。PI 必须保留可见的匹配理由；歧义或会排除用户显式指定 Agent 时请求确认，但确认不得删除真实硬要求，只能修订错误 requirement，或授权向 unknown 目标请求 per-Task requirement attestation。
_Avoid_: PI 创造 Skill 名称、所有任务强制 Skill、质量偏好升级为资格门槛、用户确认伪造资格、为适配目标静默删除硬要求。

## Task Skill Coverage Plan

根 Task 所需 Skills 在任务树中的覆盖关系。根 Task 可以由多个 Agent 的 Skills 共同覆盖，但每个可执行子 Task 必须由一个同时满足该子 Task 全部 required Capabilities 与 required Skills 的 Agent 认领；PI 同时定义子 Task 间的输入、输出、依赖与验收。语义上不可安全拆分的工作不能只为适配现有 Agent 而强拆。
_Avoid_: 全能 Agent 要求、父 Task 直接认领、跨 Agent 拼接一个不可分割操作。

## Executable subtask contract

PI 在任何 allocation 前为一个可执行子 Task 冻结的完整责任边界，绑定唯一目标、来源与上游已验收 output 的输入引用、预期交付、依赖、验收及 evidence/authority、硬资格要求、约束、风险、deadline 与重试上限；只有全部依赖解析为绑定 snapshot 的输入后，该 Task 才可 runnable。
_Avoid_: 标题或描述充当合同、Invocation prompt 补字段、隐式输入、未验收上游结果、悬空依赖、先派发后补验收标准。

## Task acceptance contract

Executable subtask contract 中由稳定 criterion ID、明确 pass condition、必需 evidence 与允许 evidence kind 组成的全量阻塞标准；Agent delivery 必须逐项作答，全部通过才能接受，任一标准需要主观或高风险判断时，整份 delivery 使用预声明的 Subtask human acceptance authority。
_Avoid_: 整体自报完成、通过率、平均分、缺 evidence 验收、PI 绕过人工 criterion、修改标准不产生 Task revision。

## Task quality preference

只改善交付质量但不决定 Task 是否完成的非阻塞期望；它可以参与指导与候选排序，但不能混入 acceptance criteria 或在交付后被提升为拒绝理由。
_Avoid_: 可选验收项、隐藏标准、事后加门槛、偏好未满足即失败、评分替代 acceptance。

## Task DAG publication

PI 可以在无执行副作用的 planning draft 中逐步构建子 Task 与依赖；Server 只有在整张 graph revision 通过无环、coverage、完整 contract、输入可解析与 allocation 可行性校验后，才原子发布该 revision，并仅把依赖已满足的节点投影为 runnable。
_Avoid_: 创建节点即派发、部分发布、draft Offer、悬空依赖、逐节点绕过整图校验、发布失败留下 claim 或 Invocation。

## Task dependency

同一 Task DAG revision 内要求下游 Task 等待上游 Task 被合法验收的控制关系；它只决定 runnable 门禁，不自动把上游 delivery 或上下文注入下游。
_Avoid_: 隐式数据传递、最近结果、消息顺序猜测依赖、跨 root 悬空边、dependency 等同 input。

## Task output slot

Executable subtask contract 声明的具名输出位置，只有当前 Task revision/attempt 的 delivery 被合法验收后才解析为不可变 output snapshot，供根汇总或显式下游 binding 使用。
_Avoid_: 任意附件即输出、未验收结果、整份 Agent 上下文、latest output 指针、覆盖旧 snapshot。

## Task input binding

下游 Executable subtask contract 的具名输入与来源事实 snapshot 或特定上游 Task output slot 之间的显式关系；上游输出失效时，Server 必须撤回尚未开始的 runnable 投影，已开工 Task 则进入 revision impact 处理。
_Avoid_: dependency 自动注入、自然语言“使用上一步”、动态 latest、静默换源、复制未验收 delivery。

## Agent Experience Signal

来自当前 Team 内 Agent Memory 与可追溯执行历史的相似任务经验信号，只用于在合格候选之间排序，不能替代缺失的 required Capability 或 required Skill，也不得跨 Team 自动使用。
_Avoid_: Agent Skill、资格证明、全局 Agent 画像。

## Agent reliability signal

根据当前 Team 内可观测且已确认归因的 Task acceptance、完成、超时、claim relinquishment 和人工验收形成的按 Skill 或任务类型统计信号。它只参与候选排序与风险提示，不能修改 Agent Exposure Manifest；主观模型评价和未审核结果不得直接形成负面事实。
_Avoid_: 全局 Agent 评分、PI 能力裁决、自动删除 Skill、跨 Team 信誉。

## Team Agent operation restriction

Team Owner/Admin 基于治理规则或多次已确认失败，禁止 PI 在本 Team 请求某项已暴露 Agent operation 的限制。它只收紧 Team 的使用范围，不改变 Agent 的公开声明或内部状态，并必须向 Agent 所有者展示依据和提供错误归因纠正入口。
_Avoid_: 修改 Manifest、封禁 Agent 内部 Skill、系统全局信誉处罚。

## Agent Exposure Management

Agent 所有者在 Agent 管理界面维护该 Agent 面向各 Team 的公开 Capabilities、Skills 与约束的产品边界。PI 管理界面只读取这些投影，展示 Skill coverage、匹配理由、可靠性和 Team Agent operation restriction，不提供内部 Skill 的安装、编辑、启停或复制功能。
_Avoid_: PI Skill 管理器、Team 修改 Agent 供给、内部 Skill 浏览器。

## Agent eligibility

Server 先以当前 Channel membership、Team visibility、未删除状态、Task 与 input refs 的读取权限以及 Team/System operation restriction 建立不可覆盖的硬门槛，再由 PI 根据 required Capabilities 与 required Skills 过滤公开声明或有效 per-Task requirement attestation，最后使用 preferred Skills、Team 内经验、负载和可用性排序。普通 Offer 发布与所有 accept/claim 必须分别原子复验完整硬门槛；Requirement-confirmation Offer 发布时只允许暂缺其用途所对应的 unknown requirement，并在 accept/claim 时用 Agent attestation 补齐。Offer 只记录 eligibility basis，不授予权限；明确不满足或权限不合法时不能继续。
_Avoid_: 公开频道等同成员资格、Offer 充当授权、先匹配 Skill 后检查权限、用户覆盖权限或明确不满足项、频道外直接派发、只按 Agent 名称认领、经验直接授予资格。

## Per-Task requirement attestation

Agent 在用户已授权的 requirement-confirmation Offer 中对特定 task revision 的 required Capability/Skill 作出的结构化、自主且可审计声明，只解决其 Manifest 缺失、过期或未覆盖造成的 unknown，不修改 Agent Exposure Manifest，也不能覆盖 Channel/Team 权限、operation restriction 或明确不满足事实。Server 只有在 accept/claim 事务中验证 attestation 与全部其他硬门槛后才建立 claim。
_Avoid_: 用户代签、永久 Skill 声明、跨 Task 复用、权限 token、unknown 自动变 eligible、明确不满足改成满足。

## Agent eligibility basis

Server 在一次 Task Offer 中记录的候选判断审计快照，绑定 task revision、manifest revision、Channel membership 与权限/限制版本以及匹配理由；它供 accept/claim 时检测变化，但不能替代当前权限复验。成员或权限变化会使未接受 Offer 失效，安全撤权还可 fencing 已接受的 claim/Invocation；普通负载或在线状态变化不追溯撤销既有 claim。
_Avoid_: 权限 token、永久资格、Offer 后不复验、负载变化强制撤权、Manifest snapshot 暴露 Agent 内部信息。

## Agent load signal

由 Agent 主动暴露且未过期的 availability/capacity 与 Server 可见的 active claims、Offer reservations、deadline 冲突形成的可审计排序事实；普通负载只影响合格候选的确定性、版本化排序，不授予或撤销资格。未知负载只能降低排序置信度或促使使用 Candidate-set Offer，不能被解释为忙碌或空闲。
_Avoid_: 设备 CPU、内部队列、模型上下文、PI 探测、模型猜测空闲、负载直接授予 Skill、普通负载撤销 claim。

## Agent execution capacity admission

Agent 明确暴露的 hard concurrency/capacity limit 所形成的 Server admission gate；Server 在 Agent accept/claim 事务中重新计算并原子占用容量，冲突时不创建 claim。Offer reservation 只能是有 TTL 的有界临时事实，拒绝、超时或落选后释放，不等同执行权。
_Avoid_: Offer 即占用永久容量、并发超配、PI 本地计数、过期 reservation、accept 后补容量校验。

## Agent candidate ranking

PI 对已经通过全部硬门槛的候选应用的可解释、版本化确定性排序，使用 preferred Skills、Team 内经验、Agent load signal、deadline 风险与稳定公平 tie-break，并记录每项依据；排序不得以模型直觉补造 eligibility、负载或内部能力事实。
_Avoid_: 黑箱“最佳 Agent”、同分长期集中、经验替代 required Skill、未知信号伪造数值、排序结果充当 claim。

## Outside-channel capability gap suggestion

当前 Channel 内没有合格候选时，PI 向有权的人类展示的脱敏能力缺口与可选协作建议；它不得向频道外 Agent 发送 Task、Offer 或上下文，也不得自动改变 membership、权限或数据边界。
_Avoid_: 跨频道派发、自动邀请、Agent 身份枚举、泄露 Task 输入、建议即授权。

## Allocation blocked

一个 runnable 子 Task 因当前 Channel 内没有同时满足资格、权限、容量与时限门槛的 Agent 而无法发布有效 Offer 的非终态调度事实，包含结构化原因与所依据 revision。PI 可以为确实可分离的工作提出保持根目标、风险边界和验收覆盖的新 DAG revision，但不得为制造候选而降低硬要求；有权人类可以据脱敏 gap suggestion 决定邀请、授权、修订范围或延期。
_Avoid_: Task failed、自动取消、unknown 未经 Agent attestation 即当 eligible、删除 required Skill、放宽 acceptance、不可分工作强拆、自动跨频道派发。

## Manager Worker

旧的可选 placement 执行单元称呼，统一使用 PI driver；目标合同不允许 Device 进程持有 PI orchestration authority。
_Avoid_: 现行产品角色、PI driver 的同义现行入口、Device PI、普通执行 Agent。

## Device Worker

旧的 Device-hosted PI placement 称呼，不再作为目标编排角色；Device Agent 只执行已领取的子 Task，并受 Task execution compatibility baseline 约束。
_Avoid_: PI driver、daemon orchestration、Device 接管根 Task、local-only context 补编排事实。

## Server-hosted Worker

旧的 Manager Worker placement 称呼，目标术语统一为 PI driver。
_Avoid_: 独立产品角色、Device Worker 对偶选项、cloud Agent、remote Device。

## Placement

旧的 PI 执行位置选择；目标合同固定由 Server-hosted PI driver 编排，不提供 Team 或单次 run 的 Device/Server placement。
_Avoid_: 现行 Team 设置、managed/auto、Device fallback、以 placement 表示 lease 接管。

## Server-authorized context

允许 PI driver 使用的、严格继承来源 requester 当前 Team/Task/Channel 权限后的上下文；私聊和私有频道可以进入，但不得向原 scope 外扩散。它不包含 Device-local Memory、cwd、local files、Device token 或本地模型凭据。
_Avoid_: full Team context、Device context、shared secret。

## Server credential reference

由 Server 管理、可撤销且不把 secret material 写入 PI orchestration run、event 或 checkpoint 的 provider 凭据引用。
_Avoid_: API key、Device credential、auth token（除非讨论 secret material 本身）。

## Lease takeover

旧称，统一使用 PI driver lease 与 PI reconciliation；新 driver 只从 Server 事实恢复 PI orchestration run，不能重做已提交 event。
_Avoid_: forced takeover、无 fencing 接管、从 worker 内存恢复、duplicate command。

## Managed opt-in

旧的 Server-hosted Worker placement 开关，不再控制 PI authority；根 Task 创建由 Promotion gate、Team promotion policy 与 Promotion authorization 控制。
_Avoid_: 现行 placement 权限、关闭即转 Device PI、member-level placement override。

## Deployment-managed provider credential

第一阶段由部署方预先配置、Server 统一管理的一套 provider credential；Team 只能使用其引用，不能上传、读取或替换 secret material。
_Avoid_: Team API key、raw credential、Device credential。

## Managed task

需要持续跟踪、交付审核或多 Agent 协作，并已通过 Promotion gate 形成明确根 Task 的复杂请求。普通聊天和 Simple agent request 不经过每消息协调，也不属于 Managed task。
_Avoid_: Channel coordination decision、every chat、direct dispatch、background retry。

## User-delegated Server Worker

旧称；PI driver 不拥有 Team 成员身份，其每次读取都通过 Server-authorized context 绑定并复验来源 requester 与当前 run 的权限。
_Avoid_: global Server member、permanent worker identity、ambient authority、Device placement。

## Managed content consent

旧的 placement consent 术语，不作为 PI authority 或 promotion authorization；Server provider 的数据处理授权必须由独立治理合同约束。
_Avoid_: promotion 即模型数据同意、blanket consent、long-term retention、cross-scope broadcast。

## Managed unavailable

旧的 placement 故障术语；PI driver 不可用时 run 依据 PI scheduling state 等待或进入明确恢复状态，永不切到 Device PI。
_Avoid_: silent fallback、cross-placement retry、daemon 接管编排。

## Managed capacity

旧的固定 Server Worker 容量策略；目标合同只冻结可恢复 PI scheduling state，Team 公平性、配额与 backpressure 另行决策。
_Avoid_: 现行队列权威、瞬时队列名次、未经决策的固定失败阈值、implicit cost optimization。

## Server Manager runtime

PI driver 使用的 Server 受控运行环境，只提供模型规划与 PI orchestration command 协议，不具备 shell、cwd、文件读写、浏览器或 Device 能力。
_Avoid_: second runtime、server shell、remote Device。

## Managed queue timeout

旧的固定等待失败策略，不再作为目标合同；run 的恢复调度由 PI scheduling state 表示，具体公平性、配额与 backpressure 等待后续决策。
_Avoid_: 现行五分钟承诺、进程内 timeout、silent drop、以超时替代可恢复状态。
