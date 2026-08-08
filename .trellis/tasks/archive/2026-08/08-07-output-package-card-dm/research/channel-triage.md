# 生产频道文件包卡片三频道归因（DB + 日志实证）

- **Query**: 三频道 publish/formation 状态，归因卡片为何出现/不出现
- **Scope**: production (Railway api service `7b1dce9b`, env `e9c1a221`，production)
- **Date**: 2026-08-07
- **方法**: 只读 better-sqlite3 查 `/data/agentbean-next/{global,team}.sqlite`；零写入。脚本 `research/query.cjs` / `query2.cjs` / `query3.cjs` 已上传 `/tmp/`。
- **team**: `testsns` → team_id `5272b023-0fb0-4386-9259-d9a81ca0e8fd`

## TL;DR（核心归因）

| 频道 | 类型/设备 | 文件落点 | 现象 | 根因 |
|---|---|---|---|---|
| 频道1 `d8d2317e` | 公共 / xiao-mbp(0.3.39) | `~/.hermes/`、`~/Desktop/` | 无卡片 | 文件写在隐藏根 `~/.hermes/` 被 daemon reported-output 安全守卫拒收；`~/Desktop` 那次撞上 #1107 部署前的 server（无 bootstrap）→ PUBLISH_FAILED |
| 频道2 `fda9a3be` | DM / xiao-mbp(0.3.39) | `~/.hermes/profiles/...` | 无卡片、无同步 | 同上：隐藏根 `~/.hermes/` 被守卫拒收，从未进入 staging |
| 频道3 `12fd3cca` | DM / xiao-mini(0.3.37) | `AGENTBEAN_OUTPUT_DIR`（相对路径 `skills-summary.md`） | 卡片正常 | 写到 run_output 投影目录，走 output-dir 扫描（不经过 reported-path 隐藏守卫），bootstrap 成功，全链路打通 |

**两个被推翻的假设（重要）**：
1. **「DM 频道被 server 硬拒」不成立**。频道3 就是 DM，全链路成功（committed staging + output_package + system 消息）。证明 server 侧 #1106（DM workspace 访问解禁）+ #1107（begin baseline 可选）+ #1099（首次发布 bootstrap）**已部署且对 DM 生效**。静态 research（`formation-authority.md` / `dm-workspace-status.md`）基于主区代码做的「DM 被设计性排除」结论与生产现实不符——那些 PR 已经合 main 并发生产。
2. **「xiao-mbp daemon 版本太旧」不成立**。xiao-mbp 实际跑 **0.3.39**（memory 里写的 0.3.37 已过时），比 xiao-mini 的 0.3.37 还新，含 #1099 的 `if (serverUrl)` baseline 门改动。

**真正的分水岭**：Agent 的交付文件写在 **`AGENTBEAN_OUTPUT_DIR`（run_output 投影）** 还是 **任意绝对路径（reported-path，受隐藏段守卫）**。前者一定发布成功；后者一旦路径含隐藏段（`.hermes`）就被丢弃。

## 部署时间线（解释 PUBLISH_FAILED）

Railway deployment list（+08:00 → UTC −8h）：

| deployment | 时间(UTC) | 状态 |
|---|---|---|
| `1605cb3d`（当前） | 2026-08-07 **05:31** | SUCCESS |
| `7bb97721`（前一版） | 2026-08-07 04:53 | REMOVED |

- 频道3 成功 @ 05:36 → 当前部署，含 #1106/#1107/#1099（DM bootstrap 已生效）。
- 频道1 的 `PUBLISH_FAILED` @ 05:04 → **前一版部署**（04:53 上线的那版），很可能还没有 #1107 的 begin-baseline-optional / bootstrap → 无 workspace 的频道首次发布被拒。05:31 之后这类路径应当能通（但用户后续测试都用了隐藏根路径，见下）。

## 设备 / daemon 实证（global.sqlite `devices`）

| 设备 | id | daemon_version | hostname | last_seen |
|---|---|---|---|---|
| xiao-mbp | `eaeb6e96-6aa9-411e-b14d-2c1325dfd76b` | **0.3.39** | shaw-mac.local | 2026-08-07 05:33 |
| xiao-macmini | `d0b2fbc9-52b0-4084-8882-06f433f1036e` | **0.3.37** | xiaodeMac-mini.local | 2026-08-07 05:33 |

两台都 ≥ 0.3.36 → 都含 #1099 的 daemon 侧 baseline 门改动（`if (serverUrl)`）。**版本不是分水岭**。

## 频道1（公共 `d8d2317e`，xiao-mbp）

### DB 证据

| 表 | 行数 | 状态 |
|---|---|---|
| `channels` | 1 | `kind='channel'`、`name='测试新功能专用频道'`、`visibility='public'`、未归档 |
| `project_channel_workspaces` | **0** | 该频道**从未创建 workspace** |
| `workspace_publish_stagings` | **0**（任意 status 都没有） | 从未进入 staging |
| `output_packages` | **0** | formation 从未跑过 |
| `messages`（system output-package） | **0** | 无卡片消息 |
| `messages`（全部 / system） | 42 / 18 | 频道活跃 |

### dispatches（最近）

| dispatch_id | 时间(UTC) | status | agent |
|---|---|---|---|
| `280bf816` | 05:36:28 → 05:37:58 | succeeded | `0dfe86cd`(Hermes-xiao-mbp) |
| `4f1ae311` | 05:00:56 → 05:04:20 | succeeded | `0dfe86cd` |

### 关键证据：agent 回复正文里嵌的诊断

- **05:04:20 回复**（dispatch `4f1ae311`，文件 `/Users/shaw/Desktop/hermes-skills-summary.md`）：
  ```
  [workspace-publish:REPORTED_OUTPUTS_NOT_PUBLISHED] count=1 reason=PUBLISH_FAILED
  [AgentBean Artifact 归档诊断]
  - [UPLOAD_FAILED] hermes-skills-summary.md (13648 bytes)
  ```
  → reported-path **成功收集到 1 个**（`~/Desktop/...` 非隐藏，过了守卫），但 staging publish 失败（PUBLISH_FAILED），legacy artifact upload 也失败。此次跑在前一版部署（05:31 之前），server 还没 #1107 bootstrap → 无 workspace 的频道首次发布被拒。

- **05:37:58 回复**（dispatch `280bf816`，文件 `/Users/shaw/.hermes/hermes-skills-index.md`，**用户 13:49 报告的那次**）：
  ```
  搞定！文件已经生成好了。
  文件路径：/Users/shaw/.hermes/hermes-skills-index.md
  ```
  **完全没有 publish 诊断、没有 REPORTED_PATH_REJECTED 诊断**。说明这个文件**根本没进入 staging 流**，也没有被上报到 artifact 归档诊断里。

### 归因
- 05:37 这次的文件写在 **隐藏根 `~/.hermes/`**。daemon 的 reported-output 收集器对绝对路径做 realpath 后，会过 `isCollectableReportedBase` 守卫（`apps/daemon-next/src/artifact-collector.ts:565-566`）：
  ```ts
  const segments = realPath.split(/[\\/]/);
  if (segments.some((segment) => segment.startsWith('.'))) return false;  // .hermes 命中
  ```
  任何路径段以 `.` 开头即拒收（防 `.ssh`/`.config`/`.agentbean` 泄漏）。`.hermes` 命中 → 文件被丢弃。
  - 关于为何没看到 `REPORTED_PATH_REJECTED` 诊断：`index.ts:1341` 的 artifact 诊断渲染 gated on `result.workspaceRun`；这类直连 dispatch 可能不满足条件，导致诊断不渲染进回复正文。但 DB 侧「0 staging / 0 package」是确定的。
- 05:04 那次的 `~/Desktop/` 路径**非隐藏**，所以被收集（count=1），只是撞上 #1107 部署前的 server → PUBLISH_FAILED。

## 频道2（DM `fda9a3be`，xiao-mbp）

### DB 证据

| 表 | 行数 | 状态 |
|---|---|---|
| `channels` | 1 | `kind='direct'`、`dm_target_agent_id='0dfe86cd'`(Hermes-xiao-mbp)、未归档 |
| `project_channel_workspaces` | **0** | 从未创建 workspace |
| `workspace_publish_stagings` | **0** | 从未进入 staging |
| `output_packages` | **0** | |
| `messages`（system output-package） | **0** | 无卡片 |
| `messages`（全部 / system） | 98 / 25 | 频道非常活跃（多次 Hermes 调用） |

### dispatches（最近）

| dispatch_id | 时间(UTC) | status |
|---|---|---|
| `13961157` | 05:41:10 → 05:42:23 | succeeded |
| `c0fb9337` | 05:34:06 → 05:35:19 | succeeded |
| `b5725940` | 05:00:14 → 05:03:26 | succeeded |

所有 dispatch **都 succeeded**（agent 跑通了），但**全部没有 publish 诊断、没有 staging 行**。

### 关键证据：agent 写的文件都在隐藏根
最近几次回复里的文件路径：
- `/Users/shaw/.hermes/profiles/opensns/skills-inventory.md`（05:42）
- `/Users/shaw/.hermes/profiles/opensns/skills-overview.md`（05:35）

全部在 `~/.hermes/`（隐藏段 `.hermes`）。与频道1 05:37 同机制：hidden-segment 守卫拒收 → 0 collected → 0 staging → 无卡片。

### 归因
**与 DM 频道访问权限无关**（频道3 DM 已证 DM 全链路可通）。是 **Hermes-xiao-mbp 把文件写到隐藏根 `~/.hermes/`，触发 daemon reported-output 隐藏段守卫**。用户报告的「无 committed 无同步」就是这个直接结果——文件从未进入 server 的 staging/revision 流，自然没有 `.agentbean` 同步。

## 频道3（DM `12fd3cca`，xiao-mini）— 成功对照

### DB 证据（全链路命中）

| 表 | 行数 | 关键内容 |
|---|---|---|
| `channels` | 1 | `kind='direct'`、`dm_target_agent_id='8008b58c'`(Hermes-xiao-mini) |
| `project_channel_workspaces` | **1** | id `d8cdf676`、created 05:36:44（**bootstrap 创建**，因 baseline 空） |
| `workspace_publish_stagings` | **1** | publish_id `dispatch-b6765082...`、status **`committed`**、`baseline_revision_id=""`（**空 baseline → #1099 bootstrap 路径**）、committed_revision `d8cdf676`、created 05:36:42、updated 05:36:44 |
| `output_packages` | **1** | package_id `7f62c0c6`、delivery_id `76f1d438`、agent `8008b58c`、task_binding `unmanaged`、member_count 1、status `recorded`、created 05:36:44 |
| `output_package_members` | **1** | seq 1、short_label `F1`、filename **`skills-summary.md`**、source_path **`skills-summary.md`**（相对路径 → output-dir 投影，非 reported-path）、artifact_version `7afc521b` |
| `output_package_command_receipts` | **1** | idempotency `record-agent-output-package:12fd3cca:dispatch-b6765082`、outcome **`applied`** |
| `messages`（system output-package） | **1** | body「Agent 交付 1 个文件」、meta.kind=`output-package`、packageId `7f62c0c6`、agentName `Hermes-Agent-xiao-mini`、clientMessageId `output-package:7f62c0c6` |

### 归因
- 文件 `skills-summary.md` 以**相对路径**出现在 package 成员里（source_path 不是绝对路径），说明它来自 **AGENTBEAN_OUTPUT_DIR 的 output-dir 扫描**（`artifact-collector.ts` 配置根扫描），不是 reported-path 提取。
- output-dir 扫描**不经过 `isCollectableReportedBase` 隐藏段守卫**，所以不会被 `.hermes` 这类规则拒。
- staging 的 `baseline_revision_id=""` 证明：daemon 在 baseline 缺失下仍进入 staging（#1099 daemon 改动），server begin route 接受空 baseline（#1107）并 bootstrap 出 workspace（#1099）。
- **完整闭环**：output-dir 扫描 → stage → begin(空 baseline) → server bootstrap workspace → commit → formPackage → system 消息 → 卡片。

> 注意：频道3 agent 回复正文里也提到过 `/Users/xiao/hermes-docs/20260807/skills-summary.md`（非隐藏绝对路径）。这是 reported-path 候选，但 package 里只冻结了 1 个成员（来自 output-dir）。两者内容同（dedup by sha256，`artifact-collector.ts:661-668`），managed run_output 副本胜出。

## 机制对照：为什么 3 通 1&2 不通

```
                  ┌─ output-dir 扫描（AGENTBEAN_OUTPUT_DIR）── 不过隐藏守卫 ──→ stage ✓
agent 交付文件 ───┤
                  └─ reported-path 提取（回复正文绝对路径）── isCollectableReportedBase 守卫：
                                                                     · 任一路径段以 `.` 开头 → 拒（.hermes/.ssh/.config…）
                                                                     · SENSITIVE_REPORTED_BASENAME_RE → 拒
                                                                     · 扩展名须匹配 ADAPTER_OUTPUT_FILE_EXT_RE（.md ✓）
                                                                     · 通过 → stage
```

- 频道3：文件在 `AGENTBEAN_OUTPUT_DIR` → 走上支 → 通。
- 频道1&2：文件在 `~/.hermes/...` → 走下支 → 命中隐藏段守卫 → 拒。
- 频道1 的 05:04 那次是下支里少数过了守卫的（`~/Desktop/...` 非隐藏），但 server 侧 #1107 前不支持空 baseline bootstrap → PUBLISH_FAILED。

## 与静态 research 的差异（重要更正）

| 静态 research 结论 | 生产实证 |
|---|---|
| DM 频道被 server 三处 `kind==='direct'` 硬拒（`dm-workspace-status.md`） | **已被 #1106 解除**：频道3（DM）全链路成功，含 workspace bootstrap。当前 main 已合 #1106/#1107/#1099。 |
| formation 对 DM 走不到（`formation-authority.md`） | 走得到：频道3 的 `evaluateOutputPackageFormation` 实际跑过（output_package status=recorded、command_receipt outcome=applied），authority 通过（`agentMemberIds` 含目标 agent）。 |
| daemon 0.3.37（memory `local-daemon-log.md`） | xiao-mbp 实际 **0.3.39**，xiao-mini **0.3.37**；两台都含 #1099 gate。 |
| 「baseline 门静默跳过 staging」是断点 | #1099 已把门改为 `if (serverUrl)`，空 baseline 也进入 staging；频道3 `baseline_revision_id=""` 实证。 |

→ 本 task 的 PRD（`prd.md` / `design.md`）描述的「双重断点」**已经在 #1106 修掉了**（web system 消息渲染 + server DM 访问）。生产端 DM 卡片链路本身是通的。**当前用户看到的「无卡片」是 device 侧 agent 写文件位置问题，不是 server/web 断点。**

## 推荐修复方向（按优先级）

1. **【根因｜高收益】让 Hermes-xiao-mbp 把交付文件写到 `AGENTBEAN_OUTPUT_DIR`**，而不是 `~/.hermes/`。这是 Hermes agent 适配问题（adapter 是否把 `AGENTBEAN_OUTPUT_DIR` 传给 agent 并让 agent 尊重它）。频道3（xiao-mini）的 Hermes 已经这么做——对照两台设备的 adapter/agent 配置差异即可定位。修好后 DM 和公共频道都正常。
2. **【验证｜跟进】在当前部署（05:31+）下，让 xiao-mbp 跑一次写 `~/Desktop/xxx.md`（非隐藏）的交付**，验证 server 侧 bootstrap 现在确实接得住（应形成 staging+package）。这能分离「server 问题」与「hidden-path 问题」。预期：通过。
3. **【体验｜低优先】reported-path 被隐藏守卫拒时，给用户可见诊断**。当前 `index.ts:1341` 的诊断渲染 gated on `result.workspaceRun`，导致这类直连 dispatch 的拒收在 UI 上无声无息。考虑把 `REPORTED_PATH_REJECTED` 透出到 agent 回复或频道 system 消息，让用户知道「文件因写在隐藏目录没发布」。
4. **【本 task 收尾】更新 PRD/design 状态**：#1106 已落地，断点 A/B 修完；剩余是 device-agent 行为问题，不在 server/web 修复范围内。建议关闭或重定义本 task 为「Hermes-xiao-mbp output dir 适配」。

## Caveats / 未完全坐实的点

- **05:37 那次的 hidden-path 拒收未在回复正文留下诊断**（`REPORTED_PATH_REJECTED` 没出现）。推断是 `result.workspaceRun` 渲染门导致不显示，但也存在另两种可能：(a) `extractReportedOutputPaths` 没从「文件路径：...」这行把路径当 delivery context 提取出来（`isDeliveryContextAt` 判谓）；(b) 收集时 `realpathSync` 失败（文件还没落盘）→ 静默 `continue`（`artifact-collector.ts:649-652`）。三种都指向同一结论（文件没进 staging），但精确子原因要在 xiao-mbp daemon 加日志复现才能定。不影响修复方向（写 output dir 即绕开全部）。
- **「.agentbean 同步恢复」用户的观察与 DB 不符**：频道1 没有 committed staging、没有 workspace，理论上没有 workspace revision fan-out（#1084 切片2）的源。用户看到的「同步」可能是 legacy artifact upload 在某次重试中成功后触发的 device snapshot，或者观察的是另一条路径。本调查未深追 `.agentbean` 同步，聚焦 publish/卡片链路。
- **server 日志无 publish 关键字命中**（`railway logs --since 05:30` grep staging/publish/begin 全空）。说明 server 在正常路径下不打 INFO 级日志，只在 ERROR 时打。频道3 成功路径因此无日志佐证（DB 行已足够）。频道1 05:04 的 PUBLISH_FAILED 若发生在前一版部署，日志已不在保留窗口内。
- **未跨 global.sqlite 复查 `agent_publications`**：该表无 `channel_id` 列（query 报错 `no such column`），其 schema 与 team 库的 `output_package_members` 不同源。本次归因不需要它（output_packages + messages 已闭环）。

## 证据脚本
- `research/query.cjs` — 三频道 stagings/output_packages/messages 全量
- `research/query2.cjs` — devices/agents/workspaces/dispatches
- `research/query3.cjs` — daemon version + workspaces + dispatches（最终用）
- 已上传 `/tmp/query{,2,3}.cjs`；只读 `{readonly:true}`，零写入。
