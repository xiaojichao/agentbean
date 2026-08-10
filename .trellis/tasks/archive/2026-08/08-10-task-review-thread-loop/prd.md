# 从任务审核工作区回到讨论串并冻结修改依据(#1178)

上游：Part of #1173；Blocked by #1177（已合 main，PR#1186）；与 #1174（已合）对齐 Files 入口。

## Goal

审核者在阶段详情工作区点击「交给智能体处理」「要求修改后继续」「回到讨论串」时，回到正确的绑定 Thread，composer 预填 Task linkage、意图文案与 package/file selectors，并清晰展示引用策略；用户真正发送前不产生任何 Server 事实；发送时由 ProjectReferenceSet 冻结具体 artifactVersionId，完成 Tasks → Thread → Agent → 新交付 → Tasks 的稳定交接闭环。

## 用户价值

审核者要求修改或继续交给 Agent 时，应回到正确的绑定 Thread，并明确携带被审核 package/version 与稳定项目输入；在用户真正发送前，不应提前产生 Offer、claim、Invocation 或责任焦点。

## 本纵向切片范围

1. 阶段详情的「交给智能体处理」「要求修改后继续」「回到讨论串」打开绑定 Thread；
2. composer 预填 Task linkage、意图文案和 package/file selectors，并恢复输入焦点；
3. 清晰展示引用策略 current/final/delivered/specified 及发送时将冻结的依据；
4. 用户发送前只存在本地预填状态，不创建 Message、Offer、claim、Invocation 或责任焦点；
5. 发送时由 ProjectReferenceSet 解析并冻结具体 artifactVersionId；
6. Agent acceptance 后才建立 claim/执行责任，Invocation 使用冻结输入；
7. 新 delivery 回到同一 stage/task，Tasks、Files、Thread 更新为同一 Server projection；
8. 历史消息和 Invocation 保留原版本，不随 current/final 漂移。

## 事实与交接边界

- 复用 ProjectReferenceSet、OutputPackage package projection、Task/Thread linkage 与现有 Offer/acceptance/claim 命令。
- 不把 composer draft、Chat 文本、assignee、tag 或按钮点击当作工作事实。
- current/final/delivered/specified 在发送或 Invocation 边界解析为具体版本；禁止运行时重新解析。
- stale stage edge、collection/bundle revision、已归档/不可见来源或 consistency 未追上时 fail closed。
- Agent 未接受 Offer 前不得出现 execution_active 或人工回填负责人。
- 与 #1174 对齐 Files 的「继续处理/引用」入口和版本标签，但两处都只消费相同 Server 事实。

## 验收标准

- [ ] 从阶段详情进入正确 Thread，刷新/返回后仍保持 task/stage/thread 关联。
- [ ] composer 明确展示将引用的 package、成员和版本策略。
- [ ] 发送前数据库中没有新增 Message、Offer、claim、Invocation 或责任焦点。
- [ ] 发送后 ProjectReferenceSet 冻结到具体 artifactVersionId，可从消息与 Invocation 追溯。
- [ ] Agent acceptance 前无 claim；acceptance 后责任焦点和执行链来自 Server 事实。
- [ ] 要求修改保留旧 delivery/review，新的请求引用旧版本 basis 并产生新 revision/attempt。
- [ ] current/final 后续变化不影响历史消息或既有 Invocation。
- [ ] stage edge/collection/bundle revision 在交接前变化时旧 offer/invocation basis 被拒绝或失效。
- [ ] 归档、无权限、引用不可见和 projection not_ready 有明确失败状态。
- [ ] 新 delivery 后 Tasks、Files、Thread 的 package/version/review 状态最终一致。

## 测试要求

- Server 集成测试覆盖冻结解析、Offer/acceptance/claim 顺序、stale stable input、archive 和跨 Team/Channel scope。
- 验证 stage edge/collection/bundle revision 变化使旧 basis fail closed，且 OutputPackage provenance 不漂移。
- Web 测试覆盖预填不落事实、发送后关联、焦点恢复与错误态。
- 浏览器 smoke 完成 Tasks → Thread 预填 → 发送 → Agent 接受 → 新交付 → 返回 Tasks。

## 不在范围内

- 不以客户端生成的 URL 参数作为 authority。
- 不改变 Thread 的消息模型或新增独立 Project 容器。
- 不复制 Files 的资产浏览能力。
