# 技术设计

## 边界

本切片只增强 browser smoke 失败证据、CI attempt 可观测性与 SDLC 周报分类；不修改产品行为、不改变本地 browser preflight，也不减少远端 gate。

## CI attempt 合同

- 把现有单 shell 内 retry 拆成 `browser-smoke-attempt-1` 与 `browser-smoke-attempt-2` 两个 Actions step。
- attempt-1 使用 `continue-on-error: true`；attempt-2 只在 attempt-1 的原始 `outcome == failure` 时执行，并保持阻塞语义。
- attempt-1/2 分别使用 `artifacts/agentbean-next-browser-smoke/attempt-1|2`。
- 一个 `always() && !cancelled()` 的记录步骤读取两个 step outcome，写根目录 `retry-outcome.json`；artifact 上传同样在失败时继续执行。
- jobs API 中 attempt-2 的 `skipped/success/failure` 是周报的权威分类信号；不读取日志文本。

## Browser failure context

- `openPage` 内保存当前 flow 与最近 route；主 runner 在进入各高层业务 flow 前更新 flow。
- `waitForFunction` 在超时时给错误附加结构化诊断：`waitStage`、`description`、`selector`、`entityIds`、`elapsedMs`。
- `waitForText` 显式传入 selector；通用表达式只提取稳定的 `data-smoke` selector；实体 ID 从等待描述中的 UUID 提取，不猜测业务实体类型。
- runner catch 尽力读取浏览器当前 location，与错误诊断合并后写 `failure-context.json`；即使页面未创建也保留 flow 与错误文本。

## SDLC metrics

- 对所有已完成 first-pass run 拉取 jobs；失败 Pareto 继续复用同一批数据，不增加完整日志请求。
- 依据固定 step 名分类：attempt-2 skipped 为 `no_retry`，success 为 `retry_recovered`，failure 为 `retry_failed`；browser step 未执行为 `not_applicable`，历史/截断/缺失证据为 `unknown`。
- JSON 报告保留分类计数及 run/PR 链接字段，人类报告展示三类有效样本与 unknown。
- jobs 截断继续 fail closed，并进入 data quality warnings。

## 兼容与回滚

- 历史 run 没有新 step 名时进入 unknown，不回填推断。
- 回滚只需恢复 CI 单 step 与移除新增统计；现有 browser summary/check 契约保持不变。
