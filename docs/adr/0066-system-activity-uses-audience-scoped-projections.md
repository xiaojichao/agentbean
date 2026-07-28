---
status: accepted
---

# 系统活动使用受众与界面分层投影

PI Manager 是 Server-hosted 内置编排运行时，不是 Team 成员、普通 Agent 或消息发送者。自动提升、拆解、等待、改派、失败与汇总等已提交事实不得以 PI 头像、在线状态、输入状态、聊天气泡或可回复身份呈现。用户看到的是 Server 从已提交 Task 或 PI orchestration event 生成的 `System activity projection`：它绑定稳定 event identity、revision 与 sequence，但不是 Message、发送者或新的业务事实。Freshness hold 不属于此类活动，只作为当前调用方的 command response；lease、fencing、checkpoint、模型调用、重试尝试和 chain-of-thought 等内部过程也不直接进入用户活动流。

同一权威事件按受众与界面用途分层投影。Task 详情是完整的人类可读工作时间线，并把权威 TaskStatus 与分诊、拆解、派发、等待、汇总等 run progress 分栏展示；来源 Thread 在原 Message 不变的前提下挂载持久 Task 活动卡，只呈现稀疏里程碑、当前进展与 Task 入口；Inbox 通过独立 `System attention item` 只投影与接收者责任相关的 attention 或 action_required。System attention item 是 Server 从已提交 event 或独立 attention 事实持久化的非 Message 条目，使用稳定 attention identity 去重并独立维护 unread/seen；它不进入 Message target 的 Read boundary，notice 仍只是可恢复唤醒。三处不得等量复制事件或各自创造状态。原型验证采用 Task 驾驶舱、Thread 锚定卡和责任收件箱三种互补结构，它们分别验证三类界面职责，不构成必须照搬的像素布局。

用户可见活动统一使用 `info`、`milestone`、`attention` 与 `action_required` 语义等级，由 Server 根据权威事实生成。Unread 只表示尚未查看，打开通知可以清除 unread；attention 与 action_required 只能由回应、执行、解除责任、合法忽略或撤销等业务动作结束。重复提醒使用稳定 attention identity 更新，不制造多份责任。等待必须说明原因、开始时间、下一次 wake/SLA 检查、影响与是否需要用户动作，且不能以持续 spinner 暗示 PI driver 正在占用执行权。

Promotion 成功只显示结构化触发来源、可审计 orchestration need 与 root Task/source relation；未接受 proposal 不得使用“已创建”或“已接管”措辞。Task DAG 只有在 Server 原子提交后才一次性展示，修订显示可理解差异并保留旧节点历史。改派区分建议、challenge/grace 与已生效责任变化，并显示原执行者、新执行者、结构化原因、时间及 attempt/round 影响；显式 @Agent 在合法拒绝、超时或 relinquish 前不得显示为已改派。失败属于 attempt、子 Task 或恢复事实，不新增根 Task `failed` 状态；自动恢复、改派、action_required 与 `recovery_pending` 使用不同呈现。

进入 `in_review` 只表示汇总交付已准备好。界面必须展示当前 delivery revision、子任务 coverage、产物来源、限制与 Human review authority，并提供绑定当前 revision 的“接受交付”或“退回修改”具名 command；只有合法接受成功后才能显示 `done`。Freshness hold 是面向当前操作者的短暂 command response，携带相关增量上下文、新 Read candidate 与草稿恢复信息；它不是 System activity projection、PI orchestration event 或 Inbox 条目，不广播为公共 Thread 事件、不推进 Read boundary。需要跨会话恢复时只持久化 shown context/candidate/draft 记录；只有另行形成权威 attention 事实时才创建 System attention item。Task 已不可领取时显示 Claim conflict。取消入口按 Root Task termination authority 可发现，并明确取消只停止后续编排、不会删除历史或回滚已经发生的外部副作用。

所有可执行控件必须映射到角色门禁、revision/freshness-bound 的具名 Server command。客户端不乐观推进业务状态；成功后由新权威事件更新投影，冲突、hold、权限或 fencing 拒绝只形成调用方反馈和适用的 audit。Server 以 event sequence 排序、以 event identity 去重，并在重连时恢复缺失投影；notice 到达顺序和客户端时间不是事实顺序。Server 还必须在生成投影前执行 audience-scope 裁剪，Thread 摘要、Task 详情、通知与治理 audit 分别只携带必要信息，客户端不能先取得完整 payload 再隐藏。

普通活动时间线提供可理解的工作历史；授权治理者可以从已提交 event 展开 event-linked audit，包括 event id、触发来源、command、revision、策略版本与授权人。未产生业务 event 的拒绝命令、恢复尝试或权限/fencing 失败使用独立 Orchestration attempt audit identity，并通过按 Task/run/command/idempotency key 查询的治理 audit 入口访问，不挂到虚构事件上。拒绝的 command 不伪装为已发生的业务活动，来源编辑或删除也不静默改写历史。两类 audit 都不得暴露 secret、完整 prompt、chain-of-thought、无关个人数据或其他频道/DM 的受限正文。

该决策取代 ADR-0004 中 PI Manager 以 AgentBean 系统协调身份“发言”的合同，并废止 `Coordination message` 作为 PI 输出通道：澄清或授权需求使用具名 Server command response 与 `System attention item`，Task 状态和多 Agent 汇总使用 `System activity projection` 与 Task delivery revision；只有普通人类或外部 Agent 的聊天内容进入 Message 模型。该决策同时细化 ADR-0062 的隐藏 PI 与 Server authority、ADR-0063 的角色门禁状态机、ADR-0064 的原子 DAG/Offer 以及 ADR-0065 的等待、失败和条件改派合同；它不决定生产组件实现、具体视觉样式或普通 Agent 的聊天呈现。
