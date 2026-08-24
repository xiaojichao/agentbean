# SDLC flow metrics

AgentBean 使用 GitHub 与 GitHub Actions 的既有元数据生成只读流程报告。报告用于建立四周基线、定位瓶颈，不是新的交付真相，也不执行 ready、review、rerun、merge、deploy 或 health mutation。

## 运行

```bash
npm run report:sdlc-flow-metrics
npm run report:sdlc-flow-metrics -- --days 7 --json
npm run report:sdlc-flow-metrics -- --repo xiaojichao/agentbean
```

默认窗口为最近 28 天，最大 365 天。运行者需要 `gh` 已登录，并对仓库具有读取 PR 与 Actions 元数据的权限。

`.github/workflows/weekly-sdlc-flow-metrics.yml` 每周一从受信任的默认分支执行同一只读脚本，并保留 28 天 JSON artifact；也可通过 `workflow_dispatch` 调整窗口。workflow 只有 contents、PR 与 Actions 读取权限，不创建 Issue、评论或修改仓库状态。

## 指标口径

| 指标 | 口径 |
| --- | --- |
| first-pass CI success | 窗口内 `pull_request` 事件中，每个 PR 最早一次 `CI/CD` run 的 conclusion；取消、跳过、失败分别保留 |
| first-pass CI failure Pareto | 只对失败 first-run 读取 GitHub jobs/steps，按固定优先级归一全部失败名称；不下载完整日志，无法识别时保留为 `other` |
| first-pass CI cancellation Pareto | 取消 first-run 仅按是否存在同 PR 后续 run 分类；记为 `cancelled_followed_by_later_pr_run` 只表达可观测相关性，不直接断言取消原因 |
| cancellation-adjusted first-pass CI success | 保留原始 first-pass 成功率，另用“已完成 first-run 减去存在同 PR 后续 run 的取消”作分母；该诊断值用于分离调度相关样本，不替代原始 KPI |
| Draft → Ready | 窗口内创建且有 `ReadyForReviewEvent` 的 PR，从 `createdAt` 到首次 ready |
| Ready → first review | 从首次 ready 到其后首次非 `PENDING` review |
| stale Codex review | 观察窗口内有更新的 open、非 draft PR，已有 Codex review，但没有 review 覆盖当前 head |
| PR lead time | 窗口内合并的 PR，从 `createdAt` 到 `mergedAt` |
| merge → production smoke | merge commit 对应的 `main` push run，从 `mergedAt` 到 `AgentBean Next production smoke` job 完成 |
| deploy → first healthy | 同一 run 中，从 `Deploy production` job 完成到 `Wait for production server healthcheck` step 完成 |

这些值是 GitHub 事件与 job/step 时间，不等同于 Railway 内部部署阶段。没有稳定机器可读时间戳的 `actionable finding → resolved`、change failure 和 rollback rate 暂不生成，避免把推断写成事实。

## 数据质量

- PR 列表按 `updatedAt` 倒序分页到窗口边界，因此可覆盖窗口内创建、合并或更新的 PR。
- 单个 PR 的 ready/review 连接超过 100 项时，该 PR 会进入 `truncatedPrNumbers`，并从依赖这些连接的指标中排除。
- GitHub 对带筛选条件的 workflow run 查询最多返回 1000 条；命中上限会写入 `dataQuality.warnings`，并把对应的 `workflowRunsComplete` 设为 false，相关比例只代表截断样本。jobs 命中上限的 run 会从 outcome 与时延指标中排除。
- 缺失 PR 关联、缺失 job/step、进行中的 run 和各类 conclusion 分开记录，不按成功或零时长处理。
- Actions run 的 `pull_requests` 恰好一项时才采用直接关联；多项时计入 `runsWithUnresolvedPullRequestAssociation`，拒绝按数组顺序猜测。未返回关联时，以该 run 的完整 `head_sha` 匹配窗口内 PR commit；同一 SHA 对应多个 PR 时同样拒绝猜测。GraphQL commit 连接超过 100 项时，报告先通过只读 REST 分页补全；只有补全失败或仍命中上限时，才把 `commitFallbackEvidenceComplete` 设为 false。此时未知 SHA 仅计入中性的 `runsWithUnresolvedPullRequestAssociation`，确定性字段 `runsWithoutPullRequest` 为 null，不把每个 run 猜成受某个截断 PR 影响。
- delivery job/step 只为窗口内 merge commit 对应的 `main` push run 拉取；其他 `main` push 只计入 `observedMainPushRuns`。
- job 查询使用固定 6 路只读并发；并发度不是流程 KPI，也不会触发 workflow 操作。
- `nonSuccessRuns` 仅保留 PR 号、run ID、SHA、conclusion、分类和失败 job/step 名称，不保留完整日志、环境变量或密钥。

报告已接入周度只读 artifact，2026-08-24 生成了首份 28 天基线。累计获得至少四周产物后，再依据主要等待时间和失败 Pareto 决定下一项自动化，不以并行 Agent 数或代码行数作为主 KPI。

## Changed preflight

首份基线的 37 次 first-pass 失败中，25 次集中在 package tests 或 retained boundaries。开发者可在 push 前运行：

```bash
npm run preflight:changed -- --plan
npm run preflight:changed
```

命令默认比较 `origin/main...HEAD`，并合并 staged、unstaged 与 untracked 文件。单一 `apps/{server-next,daemon-next,web-next}` 改动运行一次 retained boundaries、对应测试和 Local Verification Contract 要求的 build，避免 migration registration 等跨目录守卫被 targeted 模式跳过；`web-next` build 后还会校验 `releases.generated.ts` 没有未提交漂移，作为其生成输入的根 `CHANGELOG.md` 也映射到同一执行面，即使混合改动触发 full fallback 也会保留 freshness 检查；Agent 配置执行面会保留专用 `eval:agent-config`；任意 workspace `package.json` 或锁文件改动会先运行只读的 `npm ci --dry-run` 校验清单与 lockfile 一致性；除此之外的普通文档-only 改动不运行 package 检查；共享 `packages/*`、CI validate 文档/配置、根脚本、工作流、锁文件或无法识别的路径会 fail-safe 回退 `npm run test:ci` 与 `npm run build:packages`。共享包默认完整回退，是因为其依赖扇出不能由目录名安全缩小。可用 `--base <ref>` 改变比较基线，也可直接传入文件路径检查计划。

这是提交前反馈辅助，不替代 PR 的完整 CI、review、merge-readiness 或 post-merge 验证，也不安装或强制启用 git hook。
