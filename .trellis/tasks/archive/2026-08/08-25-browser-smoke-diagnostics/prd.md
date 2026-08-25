# 保留 browser smoke 重试证据并纳入 SDLC 周报

## Goal

Issue #1247：保留两次 browser smoke 证据、补失败上下文，并让周报区分 retry 结果。

## Requirements

- CI 仅在第一次 browser smoke 失败时重试一次，最终 gate 仍由真实 smoke 结果决定。
- 两次尝试必须写入互不覆盖的 artifact 目录，并生成机器可读的重试结果摘要。
- browser smoke 超时时必须保留当前业务 flow、route、稳定 selector 或等待描述、可识别实体 ID、等待阶段与实际耗时。
- 周度 SDLC 报告必须从 GitHub jobs/steps 元数据区分未重试、重试恢复、重试仍失败；不得下载完整日志猜测。
- 历史 run 或缺失步骤必须单列为 unknown，并保留数据质量提示。
- 本地 `preflight:changed -- --browser` 保持第一次失败即非零，不增加 retry。
- 不弱化现有测试、构建、readiness、browser、review、合并与生产验证门禁。

## Acceptance Criteria

- [x] CI workflow 中首次与 retry 是两个显式步骤，retry 仅在首次失败时运行。
- [x] attempt-1 与 attempt-2 artifact 均可同时保留，聚合 outcome JSON 能表达 no-retry、retry-recovered、retry-failed。
- [x] browser wait timeout 的 `failure-context.json` 包含 flow、route、waitStage、elapsedMs，以及可用的 selector、description、entityIds。
- [x] SDLC JSON 与人类报告展示 browser retry outcome 统计，历史数据不会被误判。
- [x] workflow 合同、失败上下文、metrics 分类与数据质量路径都有自动化测试。
- [x] 目标测试、readiness、changed preflight 计划、真实 browser smoke 与适用构建通过。

## Notes

- GitHub Issue：#1247。
- 已知样本：PR #1244 的首次成员详情等待超时，retry 后 53/53 通过。
- 本地证据：完整 changed preflight 通过；真实 Chrome smoke 53/53；28 天指标回放 179 秒，旧工作流证据按 unknown/not_applicable 保守分类。
