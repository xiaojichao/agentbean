---
status: accepted
---

# 系统活动使用受众与界面分层投影

PI Manager 是 Server-hosted 内置编排运行时，不是 Team 成员、普通 Agent 或消息发送者。自动提升、拆解、等待、改派、失败、汇总与 Freshness hold 不得以 PI 头像、在线状态、输入状态、聊天气泡或可回复身份呈现。用户看到的是 Server 从已提交 Task 或 PI orchestration event 生成的 `System activity projection`：它绑定稳定 event identity、revision 与 sequence，但不是 Message、发送者或新的业务事实。lease、fencing、checkpoint、模型调用、重试尝试和 chain-of-thought 等内部过程不直接进入用户活动流。

同一权威事件按受众与界面用途分层投影。Task 详情是完整的人类可读工作时间线，并把权威 TaskStatus 与分诊、拆解、派发、等待、汇总等 run progress 分栏展示；来源 Thread 在原 Message 不变的前提下挂载持久 Task 活动卡，只呈现稀疏里程碑、当前进展与 Task 入口；Inbox 只投影与接收者责任相关的 attention 或 action_required。三处不得等量复制事件或各自创造状态。原型验证采用 Task 驾驶舱、Thread 锚定卡和责任收件箱三种互补结构，它们分别验证三类界面职责，不构成必须照搬的像素布局。

用户可见活动统一使用 `info`、`milestone`、`attention` 与 `action_required` 语义等级，由 Server 根据权威事实生成。Unread 只表示尚未查看，打开通知可以清除 unread；attention 与 action_required 只能由回应、执行、解除责任、合法忽略或撤销等业务动作结束。重复提醒使用稳定 attention identity 更新，不制造多份责任。等待必须说明原因、开始时间、下一次 wake/SLA 检查、影响与是否需要用户动作，且不能以持续 spinner 暗示 PI driver 正在占用执行权。

Promotion 成功只显示结构化触发来源、可审计 orchestration need 与 root Task/source relation；未接受 proposal 不得使用“已创建”或“已接管”措辞。Task DAG 只有在 Server 原子提交后才一次性展示，修订显示可理解差异并保留旧节点历史。改派区分建议、challenge/grace 与已生效责任变化，并显示原执行者、新执行者、结构化原因、时间及 attempt/round 影响；显式 @Agent 在合法拒绝、超时或 relinquish 前不得显示为已改派。失败属于 attempt、子 Task 或恢复事实，不新增根 Task `failed` 状态；自动恢复、改派、action_required 与 `recovery_pending` 使用不同呈现。

进入 `in_review` 只表示汇总交付已准备好。界面必须展示当前 delivery revision、子任务 coverage、产物来源、限制与 Human review authority，并提供绑定当前 revision 的“接受交付”或“退回修改”具名 command；只有合法接受成功后才能显示 `done`。Freshness hold 是面向当前操作者的私有暂停投影，保留草稿并展示相关增量上下文，不广播为公共 Thread 事件、不推进 Read boundary；Task 已不可领取时显示 Claim conflict。取消入口按 Root Task termination authority 可发现，并明确取消只停止后续编排、不会删除历史或回滚已经发生的外部副作用。

所有可执行控件必须映射到角色门禁、revision/freshness-bound 的具名 Server command。客户端不乐观推进业务状态；成功后由新权威事件更新投影，冲突、hold、权限或 fencing 拒绝只形成调用方反馈和适用的 audit。Server 以 event sequence 排序、以 event identity 去重，并在重连时恢复缺失投影；notice 到达顺序和客户端时间不是事实顺序。Server 还必须在生成投影前执行 audience-scope 裁剪，Thread 摘要、Task 详情、通知与治理 audit 分别只携带必要信息，客户端不能先取得完整 payload 再隐藏。

普通活动时间线提供可理解的工作历史；授权治理者可以展开同一事件的结构化 audit，包括 event id、触发来源、command、revision、策略版本、授权人与成功或拒绝结果。拒绝的 command 不伪装为已发生的业务活动，来源编辑或删除也不静默改写历史。两层都不得暴露 secret、完整 prompt、chain-of-thought、无关个人数据或其他频道/DM 的受限正文。

该决策细化 ADR-0062 的隐藏 PI 与 Server authority、ADR-0063 的角色门禁状态机、ADR-0064 的原子 DAG/Offer 以及 ADR-0065 的等待、失败和条件改派合同；它不决定生产组件实现、具体视觉样式或普通 Agent 的聊天呈现。
