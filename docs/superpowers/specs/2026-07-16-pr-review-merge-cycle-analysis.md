# PR Review/Merge 周期分析

> **调查日期**：2026-07-16
> **调查对象**：最近 10 个已合并 PR（#607–#616，均于 2026-07-16 当天创建并合并）
> **数据来源**：GitHub GraphQL / REST API（经 `gh` CLI 采集；原始数据见附录 A 的采集方法）
> **仓库**：xiaojichao/agentbean

---

## 1. 背景与结论（TL;DR）

最近 10 个 PR 的 review/merge 周期差异巨大：最短 15 分钟（#616），最长 221 分钟（#615）。
经过逐 PR 拆解生命周期，结论如下：

**"时间长"不是因为 review 慢，也不是 CI 卡——根因是「大 PR + 分批 push + 主动 `@codex` 召唤」共同触发的自我往返循环。**

- reviewer 只有三种：作者本人 `xiaojichao`（83 条）、`chatgpt-codex-connector` bot（32 条）、`vercel` bot（10 条），**没有任何其他人类评审者**。这是"单人 + bot review"模式。
- 全程 **0 次 `CHANGES_REQUESTED`、0 次 `APPROVED`**，所有 review 均为 `COMMENTED`。Codex 留言是「💡 automated review suggestions … P2 级」，非阻塞。所以"review"不是 gate，而是"边写边收建议/边确认"的对话。
- **commit 数是最强预测因子**：commits ≤ 3 的 PR 全部在 15–29 分钟收口；commits ≥ 4 的全部超过 90 分钟。
- 真正耗时的"中间往返"环节占总时长的 **65%–96%**。

---

## 2. 方法

### 2.1 数据采集

通过 `gh` CLI 对每个 PR 采集：`createdAt`、`mergedAt`、commits（含 `committedDate`）、reviews（含 `state`/`submittedAt`/`author`）、comments、`statusCheckRollup`。对 #612 额外拉取 REST timeline（`/issues/612/timeline`）以捕获 `deployed`/`mentioned`/`merged` 等非 review 事件。

### 2.2 指标定义

| 指标 | 定义 |
|------|------|
| 总时长 | `mergedAt − createdAt` |
| 首响应 | 第一个非 PENDING 的 review 距 `createdAt` 的时间 |
| 末push→merge | 最后一个 commit 的 `committedDate` 距 `mergedAt` 的时间 |
| 中间往返 | 总时长 − 首响应 − 末push→merge 的余项（粗略代表多次 push/review/修改的活动时间） |

---

## 3. 数据总表

按总时长降序（单位：分钟）。"中间往返占比" = 中间往返 / 总时长。

| PR | 总时长 | 首响应 | 末push→merge | 中间往返 | 占比 | commits | 文件 | Codex轮 |
|----|------:|------:|------:|------:|------:|------:|------:|------:|
| 615 | 221 | 4 | 5 | **212** | 96% | 6 | 10 | 3 |
| 614 | 196 | 17 | 6 | **173** | 88% | 9 | 42 | 7 |
| 611 | 134 | 19 | 19 | **96** | 72% | 4 | 15 | 4 |
| 612 | 109 | 8 | 55 | 46 | 42% | 6 | 15 | 2 |
| 608 | 92 | 17 | 15 | **60** | 65% | 4 | 29 | 4 |
| 613 | 29 | 5 | 5 | 19 | 66% | 3 | 5 | 1 |
| 610 | 28 | 7 | 8 | 13 | 46% | 2 | 5 | 1 |
| 607 | 25 | 9 | 5 | 11 | 44% | 3 | 13 | 1 |
| 609 | 16 | 9 | 5 | 2 | 13% | 2 | 9 | 1 |
| 616 | 15 | — | 9 | 6 | 40% | 2 | 5 | 0 |

reviewer/commenter 全局分布：

| 作者 | 条数 |
|------|----:|
| xiaojichao | 83 |
| chatgpt-codex-connector | 32 |
| vercel | 10 |

---

## 4. 根因分析

### 4.1 排除：review 响应不慢

Codex 首次响应时间为 4–19 分钟，对自动化 bot 而言很快。首响应不是瓶颈。

### 4.2 排除：CI 不阻塞

所有 check 要么 `SUCCESS`，要么合理 `SKIPPED`：

- **SUCCESS**：`Vercel Preview Comments`、`Validate AgentBean Next`、`SEA windows/macos/linux x64`、`Aggregate PI SEA verdict`
- **SKIPPED**（全部 10 个 PR 一致）：`Railway Next preflight`、`Railway Next env sync`、`Publish agent to npm`、`Promote canonical daemon npm latest`、`Deploy production`、`AgentBean Next production smoke`

SKIPPED 的全是发布/部署/生产 smoke 类 job，**本就该在 PR 上跳过**（由分支/标签条件门禁控制）。这是正确配置，不是问题。

### 4.3 定位：自我往返循环

以 #614 为例，Codex review 时间戳为 `08:16 → 08:44 → 09:17 → 09:39 → 10:09 → 10:30`，每条都带 `Reviewed commit: <不同 hash>`。**每次 push 一个新 commit 都自动触发一轮 Codex review**。6–9 个 commit 的 PR 因此累积 173–212 分钟的往返。

Codex 的触发机制有两条路径：
1. **每 commit 自动 review**（被动，#614 的 7 轮即此）；
2. **作者主动 `@codex` 召唤**（主动，见 4.4 的 #612）。

两者叠加形成往返放大器：push → Codex review → 作者改 → 再 push → 再 review。

### 4.4 异常点深挖：#612 的 55 分钟"末push→merge"

#612 是唯一"末push→merge"异常长（55 分钟）的 PR，远超其他 PR 的 5–19 分钟。逐事件还原：

| 时间 | 事件 |
|------|------|
| 06:16:51 | 末次 commit `36379b2` |
| 06:17–06:19 | Vercel Preview、SEA 三平台、PI 聚合 全 SUCCESS |
| 06:24:43 | 作者 `@codex` 评论（timeline: `mentioned @codex`） |
| 06:33:17 | Validate SUCCESS + 6 个发布 job SKIPPED（**CI 全绿**） |
| 06:35:09 | 作者 `@codex` 评论 |
| 06:42:10 | 作者 `@codex` 评论 |
| 06:50:27 | 作者 `@codex` 评论 |
| 07:07:20 | 作者 `@codex` 评论 |
| 07:11:53 | closed + merged（最后评论后约 4 分钟） |

**结论**：#612 的 55 分钟 ≠ 等部署、≠ 卡 CI（CI 在 06:33 就全绿）。真实情况是 **CI 全绿后又花 38 分钟，作者连续 5 次 `@codex` 召唤，与 Codex 做合并前多轮 Q&A 验证**，确认无误后才在最后一次评论后 4 分钟合并。这是"把 Codex 当确认器、反复验证到满意才合并"的谨慎模式。

**启示**：这种验证本身不算低效（谨慎合并是好的），但若要加速，应把多轮 `@codex` 验证**收敛到本地一次性完成**，而不是占用 PR 时间线 5 轮往返。

---

## 5. 优化建议（按杠杆排序）

### P0 — 关闭"每 commit 重 review"放大器（最高 ROI）

1. **调整 Codex 触发条件**：从「每个新 commit 自动 review」改为「标记 `ready-for-review` 时」/「显式 `@codex`」/「加特定 label」。以 #614 为例，可从 7 轮冗余 review 降到 1 轮。
2. **本地预消化**：push 前先让 Codex review 工作分支（或本地 lint + tsc + 等价规则），把建议在本地一次处理完，push 即成品——这正是 #616（发布 PR，15 分钟，Codex 0 轮）能快的原因。

### P1 — 缩小 PR 粒度

3. **大 PR 拆小**：#614 的 42 文件应拆成 3–4 个内聚小 PR，每个像 #609 一样 15–30 分钟收口；总体 wall-clock 反而更短（可并行 + 每个往返窗口小）。
4. **目标 commits ≤ 3**：数据证明这是"30 分钟内收口"的充分条件。

### P2 — 流程纪律

5. **Draft → Ready 两段式**：开发期标 Draft（多数 Codex 触发器跳过 draft），满意后转 Ready 触发一次正式 review。
6. **合并前验证收敛到本地**：参考 #612 的教训，把"合并前多轮 `@codex` 确认"改为本地一次性验证，避免占用 PR 时间线。
7. **少用 PR 当工作日志**：83 条 xiaojichao 自评评论里很多是执行日志/进度——挪到 `.omc/notepad.md` 或 commit message，减少认知往返。

### CI — 维持现状

无需改动；SKIPPED 的发布 job 是合理配置。

---

## 6. 验证方法

改完 Codex 触发配置后，跑两周对比两个指标：

- **平均 Codex review 轮数 / PR**：应从当前 2–7 降到 ≤1；
- **PR 的 commit 数**：目标 ≤3。

若"中间往返占比"从当前的 65%–96% 降到 < 30%，即证明瓶颈被消除。

---

## 附录 A：数据采集方法

```bash
# 1. 拉取 10 个 PR 的生命周期数据
for n in 615 616 614 613 612 611 608 610 609 607; do
  gh pr view $n --json number,title,createdAt,mergedAt,updatedAt, \
    additions,deletions,changedFiles,commits,reviews,comments,statusCheckRollup \
    >> /tmp/prs.jsonl
done

# 2. 计算"中间往返"耗时
jq -r '
  ($p.mergedAt|fromdateiso8601) as $m | ($p.createdAt|fromdateiso8601) as $c |
  ($p.reviews|map(select(.submittedAt!=null and .state!="PENDING").submittedAt
     |fromdateiso8601)|sort) as $revs |
  ($p.commits|map(.committedDate|fromdateiso8601)|sort|.[-1]) as $lc
  ...
' /tmp/prs.jsonl

# 3. 异常点深挖：#612 REST timeline
gh api repos/xiaojichao/agentbean/issues/612/timeline --paginate
```

## 附录 B：#612 完整事件时间线

见正文 §4.4 表格。末次 commit `36379b2`（06:16:51）→ merge（07:11:53）= 55 分钟，其中 CI 于 06:33 全绿，其余 38 分钟为 5 轮 `@codex` 召唤对话。
