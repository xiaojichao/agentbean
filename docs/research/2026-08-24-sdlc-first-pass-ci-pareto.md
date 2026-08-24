# SDLC first-pass CI Pareto 研究基线（2026-08-24）

## 结论摘要

在观察窗口 `2026-07-27T12:42:02.194Z..2026-08-24T12:42:02.194Z` 内，共统计 228 次 first-pass：成功 176、失败 37、取消 15。原始成功率为 `176 / 228 = 77.19%`。15 次取消均能找到同一 PR 的后续 run，且工作流对 PR 配置了 `cancel-in-progress: true`；将“存在后续 run 的取消”从分母剔除后，诊断值为 `176 / 213 = 82.63%`。该值与 concurrency supersede 语义一致，但报告只编码可观测相关性，不把它当作已证明的取消原因。

失败按固定优先级归一全部失败 job/step 名称后，主要集中在 package tests/retained boundaries（25/37，67.57%），其次为 browser smoke（7/37，18.92%）。这表明首要收益点是本地受影响测试与真实浏览器契约验证的反馈质量，而不是降低 CI 门禁或删减覆盖面。

## 口径与可复现查询

- 对象：GitHub Actions `CI/CD` 工作流的 PR first-pass run；窗口按 `created_at` 截取，取消、失败、成功分别按 run conclusion 计数。
- first-pass：同一 PR 在窗口内最早进入该工作流的 run；后续 head 或 rerun 不重复计入。取消 run 仍保留在原始统计中，再单独识别是否被同 PR 后续 run supersede。
- 失败 step：读取 run jobs 的 steps，仅保留 `conclusion == failure` 的 step 名称；按固定优先级把失败归一到 `package_tests_or_boundaries`、`browser_smoke`、`build`、`readiness`、`setup_or_dependencies` 等类别。

示例（在仓库根目录，需 `gh auth` 有效；时间与窗口按 UTC 传给 API）：

```sh
gh api --paginate 'repos/xiaojichao/agentbean/actions/workflows/ci-cd.yml/runs?event=pull_request&per_page=100' \
  --jq '.workflow_runs[] | select(.created_at >= "2026-07-27T12:42:02.194Z" and .created_at < "2026-08-24T12:42:02.194Z") | [.id,.run_number,.head_sha,.conclusion,.html_url,.pull_requests[].number] | @tsv'
gh api repos/xiaojichao/agentbean/actions/runs/30595768911/jobs --paginate \
  --jq '.jobs[] | [.name, (.steps[]? | select(.conclusion != "success") | [.name,.conclusion] | @tsv)] | @tsv'
```

工作流源码是当前 `origin/main:.github/workflows/ci-cd.yml`：并发组位于第 51–55 行，明确写着 `cancel-in-progress: ${{ github.event_name == 'pull_request' }}`；package 测试步骤为第 167–169 行 `npm run test:ci`，构建步骤为第 171–173 行 `npm run build:packages`。这使“取消后紧跟同 PR 新 run”与 supersede 语义一致，但指标仍保守地只报告可观测事实。

## First-pass 结果 Pareto

| 失败证据类别（固定优先级归一） | 次数 | 占 37 次失败 |
| --- | ---: | ---: |
| `package_tests_or_boundaries` | 25 | 67.57% |
| `browser_smoke` | 7 | 18.92% |
| `build` | 2 | 5.41% |
| `readiness` | 2 | 5.41% |
| `setup_or_dependencies` | 1 | 2.70% |
| 合计 | 37 | 100% |

## 日志下钻与代表证据

### Package tests / boundaries（25）

日志归因：22/25 为确定性行为、fixture 或测试断言问题；2/25 为缺失模块或测试语法问题；1/25 暂未分类。代表性 run [30595768911](https://github.com/xiaojichao/agentbean/actions/runs/30595768911) 的日志包含 `serverUrl undefined` 相关的 unhandled rejection，属于测试/fixture 反馈，不应通过弱化门禁规避。

### Browser smoke（7）

6/7 是真实 UI/产品契约回归，1/7 是 runtime async/dispatch 异常。PR [#1190](https://github.com/xiaojichao/agentbean/pull/1190) 提供了同 SHA 后续成功的 flaky 旁证：该现象应被记录并定位，不宜直接把所有 browser smoke 失败视为基础设施噪声。

### Cancellations（15）

15/15 取消均有同 PR 后续 run，且与工作流的 PR concurrency 策略一致。周报因此同时展示“原始成功率 77.19%”和“排除存在后续 run 的取消后 82.63%”；后者是诊断视角，不替代原始成功率，也不单凭相关性断言每次取消的根因。

## 建议（研究基线，不是门禁变更）

1. 周报增加可解释 Pareto：展示总量、原始成功率、排除存在后续 run 的取消后的诊断值、失败证据类别及其日志归因；保留 run/PR 链接以便抽查。
2. 不弱化 CI 门禁，不因取消或 flaky 旁证删除 package、boundary 或 browser smoke 覆盖。
3. 至少累计四周窗口后再设稳定门槛；当前一周数据适合发现热点，不适合直接制定团队/仓库 SLO。
4. 优先改善开发者本地反馈：让受影响 package tests/fixtures 在提交前可复现，并补齐真实浏览器契约验证；对 runtime async/dispatch 类失败补充可诊断日志和稳定等待条件。

## Primary sources

- [CI/CD workflow（origin/main）](https://github.com/xiaojichao/agentbean/blob/main/.github/workflows/ci-cd.yml)
- [Run 30595768911](https://github.com/xiaojichao/agentbean/actions/runs/30595768911)
- [PR #1190](https://github.com/xiaojichao/agentbean/pull/1190)
- [GitHub Actions workflow-runs API](https://docs.github.com/en/rest/actions/workflow-runs)
