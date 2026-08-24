# AgentBean Skill Routing Eval

这份矩阵用于检查 Codex、Claude Code 和其他 Coding Agent 是否遵循 `AGENTS.md` 的“最轻流程优先”，并防止 Trellis / Matt / Addy 再次形成双重编排。

## 判定原则

一次路由通过需要同时满足：

1. 选择了真正需要的最小 Skill 集；
2. 没有因为 Skill 已安装而启动完整流水线；
3. 没有把 `.trellis/tasks/` 当成 GitHub Issue 的替代品；
4. 没有在清晰任务前额外要求 Trellis task consent / planning approval；
5. 没有因 Coding Agent 切换而重新跑无变化的全量测试或 Review；
6. 收口仍由 `AGENTS.md` + `docs/agents/pr-merge-gate.md` 控制。

## 回归用例

| # | 示例请求 | 期望路由 | 明确不应触发 |
|---|---|---|---|
| 1 | “把任务卡标题字号从 14 调到 15” | 直接执行 | Trellis task、brainstorm、TDD、security、full review |
| 2 | “修复这个明确可复现的空值判断 Bug，Issue 已写清楚 AC” | 直接执行 + targeted regression test | Trellis planning、额外用户批准、Matt `implement` |
| 3 | “线上偶发重复发送消息，暂时找不到规律” | Matt `diagnosing-bugs` | `trellis-break-loop`、先猜根因、全 repo 重构 |
| 4 | “这个功能要求先写失败测试再实现” | Matt `tdd` | Addy TDD、Trellis 强制 pipeline |
| 5 | “Team / Device / Agent 三个概念边界又混了，先把术语理清” | `grill-with-docs` / `domain-modeling` | 直接写代码、把领域定义塞进 `.trellis/spec/` |
| 6 | “这个 Issue 描述太模糊，先补到可自动领取” | `triage` | Trellis brainstorm 作为默认入口 |
| 7 | “把当前讨论变成正式需求” | `to-spec` → GitHub Issue | Trellis `prd.md` 作为权威 PRD |
| 8 | “这个已批准的大需求拆成 5 个独立可领取切片” | `to-tickets` | Trellis task tree 取代 GitHub ticket |
| 9 | “这项重构预计跨几周、多个 Agent Session” | `wayfinder` + 可选 Trellis Execution Packet | 单个巨大 `implement.md` 作为唯一计划 |
| 10 | “Codex 额度没了，用 Claude 接着刚才 #920 的分支干” | `AGENTS.md` handoff + existing Issue/git + Trellis packet/mem 按需 | 重新建 Issue、重新 planning、重跑未变化全量 Review |
| 11 | “Next.js 当前版本这个 API 到底推荐怎么写？” | `source-driven-development` | 仅凭模型记忆、无关 security/browser pipeline |
| 12 | “修改 Team 文件下载权限和路径校验” | `security-and-hardening` + targeted tests/build | 只做 UI 验证、泛化成全仓安全审计 |
| 13 | “任务状态 Web 上偶尔不刷新，但服务端似乎已经成功” | browser runtime evidence；复杂时再 `diagnosing-bugs` | 只读代码猜 Socket 时序、默认全站浏览器审计 |
| 14 | “新增 Server→Daemon→Runtime 的重试链，线上要能定位失败在哪层” | `observability-and-instrumentation` | 给每个函数加 log、另造一套业务真相源 |
| 15 | “把旧 PI authority 切到新 authority，并最终删兼容路径” | `deprecation-and-migration` | 一次 PR 直接删旧路径、双 authority 并存无约束 |
| 16 | “Review 这个 ready PR” | 一次 Matt `code-review` 或独立 reviewer | `trellis-check` + Matt review + Addy review 多重串联 |
| 17 | “Codex Cloud review 额度用完了” | `pr-merge-gate` 替代 Review 通道，可用 Claude/local Codex | 等额度恢复、重复本地全量验证 |
| 18 | “刚修完 Bug，发现一个所有 server-next handler 都必须遵守的新约定” | `trellis-update-spec` | 强制每个 Bug 都更新 spec；把产品需求写进 spec |
| 19 | “没有 Trellis task，帮我修这个小 Bug” | 直接执行 | 询问是否创建 Trellis task |
| 20 | “让 Claude 和 Codex 对这个高风险权限方案各自独立审一下” | `trellis-channel` 或独立 subagents，明确范围 | 把多 Agent 协作变成日常默认开发方式 |

## 平台一致性检查

同一用例分别在 Codex 与 Claude Code 执行时，应得到相同的**工程决策**，即使具体工具调用语法不同：

- 是否需要 Trellis task；
- 是否需要澄清；
- 是否需要 TDD / diagnosis / security / browser / observability / migration；
- 是否需要独立 Review；
- 应运行哪些本地验证；
- 什么事实决定 PR 可合并。

若不同平台因为各自的 Skill/Hook 默认值产生不同答案，视为 Harness 回归。

## 失败信号

出现以下任一行为即判定路由失败：

- 普通任务先询问 “是否创建 Trellis task”；
- 用户已经明确要求实现，Agent 又要求批准 planning summary 才能写代码；
- `in_progress` 自动派 `trellis-implement` / `trellis-check`；
- 代码完成后强制 `trellis-update-spec` / `trellis-finish-work`；
- 同一源码状态重复 full test / full review；
- Matt `implement` 接管 AgentBean PR / commit / merge 流程；
- 五个 Addy Skill 被固定串联；
- Claude 和 Codex 对同一清晰任务采用两套不同流程；
- GitHub Issue、CONTEXT、ADR、`.trellis/spec` 的职责发生交叉覆盖。

## 维护方式

每次升级 Trellis、Matt Skills、Addy 适配或 Coding Agent 平台集成后，优先抽测 #1、#3、#10、#12、#16、#19 六个高信号用例；若任何一个失败，再运行完整 20 项矩阵并修复 routing / hook / adapter。

10 条近期高风险、机器可判定的策略场景维护在 `agent-config-eval-cases.json`，离线检查和可选平台观察格式见 `agent-config-eval.md`。不要把完整 20 条矩阵复制到 JSON；这里仍是路由用例的人工可读权威。
