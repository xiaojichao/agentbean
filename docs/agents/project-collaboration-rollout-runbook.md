# 项目协作灰度、监控与回退 Runbook

本 Runbook 对应 Issue #831。项目能力只增加 Channel 上的项目语义；回退不得删除或改写
Artifact、ChannelDocument/revision、Message、Channel file index 或已经提交的项目事实。所有
变更记录不得包含正文、文件名、设备绝对路径、Token 或敏感 Invocation 内容。

## 开关与启用顺序

Server 启动时解析以下布尔环境变量。值只接受 `true/false`、`on/off`、`yes/no` 或
`1/0`；后置阶段打开但前置阶段关闭时，Server 拒绝启动。

| 阶段 | 环境变量 | 打开后新增的写入面 |
| --- | --- | --- |
| 1 | `AGENTBEAN_PROJECT_STAGE` | 项目只读投影、人工 Stage/Edge |
| 2 | `AGENTBEAN_PROJECT_REVIEW_FINALIZATION` | 产物提升、审核、唯一最终版 |
| 3 | `AGENTBEAN_PROJECT_BUNDLE_SELECTION` | Bundle、Selection、稳定消息引用 |
| 4 | `AGENTBEAN_PROJECT_INPUT_SET_OUTPUT` | capability-gated InputSet、逐项输出回收 |
| 5 | `AGENTBEAN_PROJECT_MANAGER_AUTO_ADVANCE` | Manager 自动推进下游 Stage |

严格按 1 → 5 逐阶段启用。Schema/仓储迁移始终是 additive，先部署但不通过开关制造项目
事实。每阶段至少观察一个完整业务周期，再进入下一阶段。

## 启用前验证

```bash
npm run test:server-next -- tests/project-collaboration-rollout.test.ts \
  tests/project-stage-overview.test.ts \
  tests/project-artifact-review-finalization.test.ts \
  tests/project-reference.test.ts \
  tests/management-dispatch-lifecycle.test.ts \
  tests/browser-smoke-script.test.ts
npm run build:server-next
npm run smoke:agentbean-next-browser -- --json
```

真实浏览器 gate 必须保存 JSON、截图和 console log。它覆盖 Stage 投影、审核/最终版、
Bundle/Selection、稳定消息引用、选中文档的认证 HTTP 字节下载、陈旧 revision 事实不变、
权限不足、归档写入拒绝与历史读取、活跃跨 Channel 引用拒绝、缺失必需输入阻塞，以及
InputSet 下载、启动、逐项提交和 `conflict + committed` 部分冲突。跨 Team 继续由上述
Server/SQLite 用例验证。发布记录必须链接两类证据，不能只附单元测试。

## 观察条件

`/metricsz` 的 `projectCollaboration` 只返回有效开关与聚合数值：

- `mutationFailures`：按有限原因码汇总的项目 mutation 失败；
- `occConflicts`：项目 revision 与 InputSet 单项 OCC 冲突；
- `inputSet.failures`：capability、下载、校验、物化和结果校验失败；
- `inputSet.items`：unchanged、committed、conflict、failed 数量；
- `eventBroadcastLatencyMs`：项目权威事件广播的 count/total/max；
- `documentBundleBackfill`：回填 mode、cursor、候选、创建、跳过和失败进度。

每阶段放量前记录 15 分钟基线；放量后比较同等请求量窗口。正文、文件名、设备路径和
Invocation payload 不得进入指标标签、日志或发布记录。

## 暂停条件

出现任一条件立即停止继续放量：

- 权限、跨 Team/Channel 或归档只读负向 smoke 失败；
- mutation 失败率或 OCC 冲突率持续高于基线两倍；
- InputSet 任一必需项失败后仍启动 Agent；
- InputSet `failed/conflict` 持续增长且用户无法恢复；
- 事件广播最大延迟连续两个窗口超出发布 SLO；
- 回填 cursor 不前进、重复创建 Bundle，或来源歧义数据被分组；
- #770 文件浏览、预览、下载或 Markdown revision 历史回归。

## 回退顺序

按 5 → 1 逆序关闭：

1. `AGENTBEAN_PROJECT_MANAGER_AUTO_ADVANCE=false`
2. `AGENTBEAN_PROJECT_INPUT_SET_OUTPUT=false`
3. `AGENTBEAN_PROJECT_BUNDLE_SELECTION=false`
4. `AGENTBEAN_PROJECT_REVIEW_FINALIZATION=false`
5. `AGENTBEAN_PROJECT_STAGE=false`

只关闭发生异常的阶段及其后置阶段。关闭后不执行数据回滚、DELETE、指针重写或历史
修订覆盖；普通频道消息、任务、Artifact、ChannelDocument 与 Channel file index 继续按
原合同读写。回退后重新执行负向权限 smoke、#770 文件读写 smoke，并确认 `/metricsz`
显示预期有效开关。

## 恢复条件

满足以下条件才重新启用：

- 根因与影响窗口已经记录，修复版本通过定向测试、类型构建和真实浏览器 smoke；
- 回退后新增的普通频道、文件和 Markdown revision 可正常读取；
- 失败率、OCC、InputSet 和事件延迟恢复到基线；
- 回填 dry-run 无重复、无歧义分组，apply 模式可从 cursor 继续；
- 值班人与发布负责人共同确认下一阶段的观察窗口。

## 审计记录模板

每次启用、暂停、回退和恢复追加一条发布记录，不覆盖旧记录：

```text
时间（UTC）：
操作者：
部署版本：
动作：enable | pause | rollback | recover
变更前有效阶段：
变更后有效阶段：
原因码：
观察窗口与聚合指标：
浏览器 smoke 产物：
负向 smoke 结果：
#770 兼容性结果：
回退结果／恢复条件：
```

`/metricsz` 的有效配置用于核对运行态，发布记录用于持久审计；两者必须一致。
