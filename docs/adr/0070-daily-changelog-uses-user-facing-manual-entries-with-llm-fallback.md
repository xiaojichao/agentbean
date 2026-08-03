---
status: accepted
---

# 每日更新日志采用人工撰写为主、LLM 兜底的用户向内容

设置页"更新日志"（releases tab）是 AgentBean 产品级变更对终端用户的展示面。2026-07-03 的 changelog 动态化设计（`docs/superpowers/specs/2026-07-03-changelog-dynamic-design.md`）明确"不自动从 git commit 生成 changelog，人工撰写更准确"，但后续新增的 daily 流程违背该意图：GitHub Actions 每日抓取当天 git commit subject 写入 `CHANGELOG.md` 的 Daily 块，前端原样展示，内容混入内部 issue 号、slice/ADR 术语、bot 自指条目（如"记录 2026-07-29 每日更新日志"）。

本 ADR 决定：Daily Changelog 的内容改为用户向更新（User-facing update）——作者在 PR body 的 `## 用户向更新` 小节以 `- 新功能: xxx`、`- 改进: xxx`、`- 修复: xxx` 行前缀形式撰写业务向描述；每日流水线拉取当天合并 PR 的人工小节，缺失小节的 PR 由 LLM 兜底生成同构条目；AI 生成条目直接发布且不标记；存量历史 Daily 块保留不变。

## 内容模型

用户向更新是面向终端用户的产品变更描述，只按新功能、改进、修复三分类组织。PR 是用户向变更的自然粒度（一个 PR = 一个用户可见变化），PR body 小节是唯一人工入口；没有 PR 的变更（bot 直接 push 的元变更）天然不进入更新日志。小节可空：不写小节表示该 PR 对用户无可见影响或作者选择不披露，此时由 LLM 兜底判断并生成。

`CHANGELOG.md` 仍是唯一真相源，build 时经 `gen-changelog.ts` 生成 `releases.generated.ts` 由前端静态渲染；本决策不改变该管线，只改变写入 Daily 块的内容模型与格式。

## 权衡

纯自动 commit 抓取（现状）零人工成本，但 commit subject 是写给开发者的，暴露内部实现语言，且无法在事后补上业务语义——设计文档早已否决该路线，daily 流程是违背设计的意外退化。纯人工撰写（设计文档原意）质量最可控，但每日节律下无兜底会因空缺而退化，本仓库历史已证明这一点。混合方案（选定）把业务向信息的源头放回开发时刻（作者最清楚"这次改动对用户意味着什么"），以 LLM 兜底吸收漏写，并以"PR 无小节"作为触发与过滤的双重信号，不引入额外维护流程。

LLM 兜底条目直接发布且不标记（而非带"AI 生成"标记或进入待审区）：changelog 是低风险内容，表述不准确不损坏数据；待审区在本仓库没有成功先例，大概率成为无人维护的僵尸流程。直接发布不标记保持内容一致的用户体验。

## 兼容与退役

存量 Daily 块（commit 术语内容）作为历史事实保留，前端继续按旧格式渲染，不做业务化改写。旧的关键词分类器（`apps/web-next/lib/daily-changelog.ts` 的 `classifyDailyChange`）只服务于自动抓取路径，随新内容模型退役；LLM 兜底输出的条目与人工条目共用同一行前缀解析器，不维护两套解析。UI 分类 badge（NEW/IMPROVED/DEPRECATED/REMOVED/FIX/SECURITY 六色）退役为卡片内三分组渲染。

本决策不改变设置页入口、每日节律（cron 时间不变）与静态生成管线，也不建立面向产品的后端 API、表或 socket 事件。LLM 兜底通过一个仅限 CI 内部调用的工具端点（`/api/internal/changelog-summarize`）使用内置 PI Manager 的 Active PI Model 执行，credential 始终由 Server 管理，不向 CI 或仓库暴露模型密钥。
