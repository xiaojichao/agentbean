# CI failure diagnosis

`diagnose:ci-failure` 对 GitHub Actions `CI/CD` run 做只读、确定性诊断。它读取 run、jobs、steps 和失败 job 日志，输出失败分类、关键证据、flaky 线索和经过仓库验证的最小复现入口。

它不 rerun、cancel、dispatch、修改代码、评论 PR、发布包或触发部署。

## 运行

```bash
npm run diagnose:ci-failure -- 32565939196
npm run diagnose:ci-failure -- --run 32565939196 --json
npm run diagnose:ci-failure -- --repo xiaojichao/agentbean
```

未传 run ID 时，使用 `GITHUB_RUN_ID`；两者都没有时，从最近 100 个已完成 `CI/CD` run 中优先选择最近的 failure、timed_out、action_required 或 startup_failure；没有这些结果时才回退到 cancelled run。

`.github/workflows/ci-failure-diagnosis.yml` 在 `CI/CD` workflow 完成且结果为 failure、timed_out、action_required、startup_failure 或 cancelled 时，自动对精确 run ID 生成 JSON artifact；也可手工输入 run ID。它始终 checkout 受信任的默认分支，不执行 PR head 代码，只有 Actions 与 contents 读取权限，artifact 保留 14 天。

默认对每个失败 job 的完整日志先做常见 token、Authorization、API key、URL secret 和凭据 URL 脱敏，提取至多 4 条错误证据和不含原文的稳定性信号，再仅保留首尾共 20,000 个字符用于分类。可用 `--max-log-chars` 调整到 1,000—200,000。脱敏是纵深防御而非完美秘密扫描，诊断输出仍应视为 CI 日志数据谨慎处理。

## 分类与 flaky 口径

分类包括 `test`、`build`、`configuration`、`browser_smoke`、`production_health`、`production_smoke`、`deployment`、`publishing`、`infrastructure`、`timeout`、`cancelled` 和 `unknown`。

- 同一次 run 中出现 retry 且重试后重复失败，标为 `unlikely`，不能因为存在 retry 文案就叫 flaky。
- 明确断言、类型错误或产品契约失败标为 `unlikely`。
- runner 中断、网络重置或外部服务 5xx 只标 `possible`，仍需跨 run 或同 head 证据确认。
- 单次取消或证据不足标为 `insufficient_evidence`。
- 日志发生截断时也标为 `insufficient_evidence`，并在 `dataQuality.warnings` 中列出 job ID。
- 取消 run 只展开具有实际 cancelled step 的根 job；未执行步骤的下游连带取消 job 汇总到 `downstreamCancelledJobs`。

## 最小复现边界

- test/build/readiness/browser smoke 返回仓库现有 npm script 或 workflow 等价命令。
- production smoke 只提供读取真实目标的命令，并要求调用者显式提供 URL/secrets。
- Railway deploy/env sync、npm publish 和 dist-tag promotion 是外部写操作，不生成复现命令。
- 建议命令只是诊断入口；执行后的本地结果不能替代 GitHub run、生产 deploy、smoke 或 live health 证据。

jobs 查询超过 1000 条或日志不可用时会写入 `dataQuality.warnings`，不会把缺失日志推断为根因。
