# 技术设计：修通项目协作输出包链路

## 链路与断点

```
Agent 执行 ─产出文件→ 设备 outputDir/reportedPath
  ─[collector 收集]→ daemon publish staging(begin/get/commit)
  ─[commitWorkspacePublishStaging]→ formPackage(OutputPackage + collection + version)
  ─[投影/socket]→ 前端 listOutputPackages / OutputPackageCard / Files artifacts 视图
```

断点：
- **#1** 在链尾「投影/socket → 前端」：`listOutputPackages`/`getOutputPackage` 校验抛错（即便有包也读不出）。
- **#2** 在链首「Agent 产出 → collector 收集」：内容文件没进 collector 通道（0 publish）。
- **#3** 在链尾渲染条件：`channelProjectOverview` 为 null → Files artifacts 视图不渲染。

## Slice 1 — 修复 #1：currentDeviceId 未剥离

### 根因（已证实，读部署 dist 确认）

`apps/server-next/src/transport/socket-handlers.ts` 的 `withAuthenticatedUserId` 对每个已认证 socket payload 注入：
```js
enriched.userId = auth.userId;
enriched.teamId = auth.currentTeamId;        // 条件注入
enriched.currentDeviceId = auth.currentDeviceId ?? null;  // ← 无条件注入
```
而 `apps/server-next/src/application/usecases.ts` 的两个查询 handler 只剥离 `{ userId, teamId }`：
```js
const { userId, teamId, ...wireInput } = packageInput;   // currentDeviceId 漏网
const parsed = parseOutputPackageQueryInputV1('list-channel-output-packages', wireInput);
```
`parseOutputPackageQueryInputV1` 用 `assertExactKeys(value, ['channelId','taskId','cursor','limit','minimumConsistency'], ['channelId'])`
做严格字段校验（#1060 AC10），`currentDeviceId` 不在允许集 → 抛 `OUTPUT_PACKAGE_PAYLOAD_INVALID`。

### 修法

在两个 handler 的剥离名单里加 `currentDeviceId`：
```js
const { userId, teamId, currentDeviceId, ...wireInput } = packageInput;
```
位置：`usecases.ts` 的 `listOutputPackages`（~9007）和 `getOutputPackage`（~9055）。
这两个查询不使用 `currentDeviceId`，剥离安全。

### 范围排查

`grep` 确认走 `parseOutputPackageQueryInputV1` 严格校验的只有这两个 handler。
但 package-review 命令（`submitPackageArtifactReview` / review-and-finalize / review-and-reject-delivery）也走
已认证 bind、同样会被注入 `currentDeviceId`——需确认它们的校验是否也 exact-key。若是，同样修。

### 更稳健的替代（评估，不一定本次做）

`currentDeviceId` 是 session 注入字段，与 `userId/teamId` 同性质。可抽一个 `stripSessionEnvelope(input)`
helper 统一剥离 `{ userId, teamId, currentDeviceId }`，供所有 exact-key handler 复用，避免将来新加 handler 再踩。
本次优先用最小剥离修法先恢复；若排查发现 ≥3 个 handler 中招，再做 helper 收敛。

### 测试（AC2）

单测直接调 usecase（不注入 currentDeviceId）抓不到此 bug。需补一个**经 bind 层**或显式注入 `currentDeviceId`
的测试：构造 `{ userId, teamId, currentDeviceId, channelId }` 调 `listOutputPackages`，断言不抛、返回成功。
放在 `apps/server-next/tests/`（参考现有 socket-handler 集成测试惯例）。

## Slice 2 — 修复 #2：内容文件未发布

### 现状

`artifact-collector.ts` 只认两条通道：
1. run 的 `outputDir`（自动当 `run_output`）——目前只收到 `workspace-run.log`。
2. agent 显式 `reportedOutputPaths`（声明输出路径，优先级高于默认）。

剧本创作 Agent 把 10 集剧本写到了「某个目录」，既不在 run `outputDir`、又没 report → collector 看不到 → 不发布。

### 研究子步（动手改之前必做）

1. 确认该 Agent 这次执行的 `outputDir` 到底是什么（run 配置 / `AGENTBEAN_OUTPUT_DIR` / 每频道 workspace 目录）。
2. 确认 Agent 把文件写到了哪里（用户指认设备上的实际路径），与 `outputDir` 比对。
3. 看 collector 是否扫到了那个目录、为何跳过（`IGNORED_OUTPUT_DIRS` / 安全校验 / manifest 缺失）。
4. 看这次 run 的 workspace-run.log（artifact 里有），可能记录了产出路径线索。

### 候选修法（研究后定）

- A：让该 Agent 把输出写进 run `outputDir`（Agent 侧/配置调整）。
- B：让 Agent 通过 `reportedOutputPaths` 显式声明产出（若 Agent 框架支持 report 机制）。
- C：collector 扫描范围/manifest 规则与 Agent 实际输出习惯对齐（daemon 侧）。

倾向：优先 A/B（Agent 显式声明输出是设计意图，见设计文档 5.2），C 次之（扩大扫描有安全/噪声风险）。

## Slice 3 — #3 项目设置 + 端到端验证

- 用现有 project stage 命令把目标频道设成项目（建 profile + stage）。
- 触发一次 Slice 2 修通后的 Agent 执行，验证：publish staging 新行 → OutputPackage 形成 →
  聊天 OutputPackageCard 出现 → Files artifacts 视图渲染。
- 全程盯服务器日志，确认无 `OUTPUT_PACKAGE_PAYLOAD_INVALID` 或其它 socket 抛错。

## 兼容性 / 回滚

- Slice 1 是纯服务端剥离逻辑，无 schema 变更，回滚即还原两行。
- Slice 2 视研究结论，可能只动 Agent 配置（零代码）或 daemon 侧收集规则。
- 每个 slice 独立 PR；部署后用 `/metricsz` + 日志 + DB 行数三层验证。
