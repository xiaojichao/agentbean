# Research: 本机 daemon 日志实证

- **Query**: shaw-mac 本机 daemon(0.3.37)的日志,确认最近 Hermes dispatch 的 publish 行为
- **Scope**: internal
- **Date**: 2026-08-07

## 结论(TL;DR)

**daemon 日志没有任何 publish/staging/baseline 痕迹。** 这正是「baseline 门静默跳过 staging」的实证——staging 分支根本没执行,所以没有任何日志可写。仅有 observe dispatch 一次 LOCAL_MEMORY_PATH_CHECK_FAILED 失败(non-blocking),以及与本次 Hermes dispatch 无关的旧 workspace-revision reconcile `fetch failed` 噪声。

## Findings

### 1. daemon 进程与日志路径

**launchd plist**:`/Users/shaw/Library/LaunchAgents/com.agentbean.device-service.plist`(全部 27 行)

```xml
<key>ProgramArguments</key>
<array>
  <string>/Users/shaw/.agentbean/service/payload/agentbean-service.mjs</string>
  <string>service</string>
  <string>run</string>
</array>
<key>StandardOutPath</key>
<string>/Users/shaw/.agentbean/service/logs/device-service.log</string>
<key>StandardErrorPath</key>
<string>/Users/shaw/.agentbean/service/logs/device-service.error.log</string>
```

**state.json**:`/Users/shaw/.agentbean/service/state.json`

```json
{"schemaVersion":1,"phase":"running","pid":31989,"startedAt":"2026-08-07T02:16:16.308Z",
 "updatedAt":"2026-08-07T02:16:18.408Z","version":"0.3.37",
 "profiles":{"total":1,"healthy":1,"failed":0,"draining":0,"stopped":0},
 "activeWorkCount":0,"outboxPendingCount":0,"reasonCode":"SERVICE_READY"}
```

→ daemon 0.3.37 已正确启动,1 个 profile healthy,无 pending work。

### 2. 日志文件清单

| 文件 | 大小 | 最后修改 |
|---|---|---|
| `/Users/shaw/.agentbean/service/logs/device-service.log` | 419 KB | 2026-08-07 10:22 |
| `/Users/shaw/.agentbean/service/logs/device-service.error.log` | 167 KB | 2026-08-07 10:11 |

`~/.agentbean/workspaces/` 下有 239 个 UUID 目录(team/channel 级别的 materialize 缓存),`workspace-publish-pending/` 目录为空。

### 3. device-service.log(stdout):只有 scanner 噪声

5656 行日志中,**唯一内容是 agent discovery / scanner 输出**(Claude Code / Codex / Gemini 三个 coding runtime + 4 agents discovered 的循环),例如:

```
Cached scan: 3/3 coding runtimes available, 4 agents discovered.
Coding runtimes:
  - Claude Code [coding runtime] claude-code -> /Users/shaw/.local/share/claude-latest/current/claude cwd=...
  - Codex CLI [coding runtime] codex -> ...
  - Gemini CLI [coding runtime] gemini -> ...
```

按以下关键字 grep 该文件,**全部零命中**:
- `workspace-publish`
- `BASELINE_UNAVAILABLE`
- `REPORTED_OUTPUTS_NOT_PUBLISHED`
- `staging`
- `project-channel-workspace`(URL)
- `fetchProjectChannelWorkspace`
- `formPackage`
- `output-package`
- `commitWorkspacePublishStaging`
- `begin`/`commit`(staging HTTP verbs)
- `current.ok`(fetchProjectChannelWorkspaceCurrent 返回路径)
- DM channel id `fda9a3be-14b9-44d1-b932-b1a7decaec4c`

**含义**:publish/staging 流程**根本没启动**。如果 staging 至少尝试过,会有 `daemon workspace-publish ...` 这类日志(index.ts 中多处 `console.warn` / `console.error` 在 staging 失败/冲突/commit 失败时都会打)。一个都没有 → staging 分支没进入。

### 4. device-service.error.log(stderr):无关错误 + 历史 observe 一次失败

按以下关键字 grep,**有意义命中**:

| 行为 | 命中 |
|---|---|
| dispatch 相关 | 仅 1 条:`daemon observe dispatch 6a321d26-0351-4490-bf4a-64ace1ab0eac failed (non-blocking): LOCAL_MEMORY_PATH_CHECK_FAILED` |
| workspace-revision reconcile | 多条 `daemon workspace-revision reconcile <teamId>/<channelId> threw (non-blocking): fetch failed`(均为 device 重连后历史 channel 的 reconcile,与本次 DM dispatch 无关) |
| 早期 daemon 启动失败 | 多条 `Device Service 启动失败(LEGACY_RUNTIME_FENCE_ACTIVE)` + 多个 `ERR_MODULE_NOT_FOUND`(legacy runtime fence 历史问题,0.3.37 启动成功后已不复现) |

**关键负面证据**:
- 没有任何 `daemon workspace-publish ...` 行(无论 success / failed / conflict / non-blocking)
- 没有 `BASELINE_UNAVAILABLE` diagnostic
- 没有 `REPORTED_OUTPUTS_NOT_PUBLISHED` diagnostic
- 没有任何 `HTTP 4xx` / `HTTP 5xx` 报错(daemon HTTP 客户端在 fetchProjectChannelWorkspaceCurrent 失败时也不打 log,只把 `ok: false` 静默返回给主流程)

### 5. daemon 源码侧的日志覆盖范围(解释为何零命中)

`apps/daemon-next/src/index.ts` 的 staging 流程只在**已经进入 staging 分支**之后才打 log:
- index.ts:1221 `console.warn('daemon channel workspace output staging failed, fallback upload: ...')` — 只在 stage/stagedForPublish throw 时打
- index.ts:1246-1248 `[workspace-publish:CONFLICT]` — 只在 deliverWorkspaceOutputsViaStaging 返回 conflict 时打
- index.ts:1265 `console.warn('daemon workspace-publish ${delivered.publishId} failed, fallback upload: ...')` — 只在 deliverWorkspaceOutputsViaStaging 返回 generic failure 时打

**当 baseline 缺失、staging 分支直接被跳过时(index.ts:1171 的 `if (serverUrl && baselineRevisionId)` 为 false),daemon 完全没有日志输出**。这是 daemon 代码的固有静默性,不是日志丢失。

### 6. 与候选 2(baseline 门静默跳过)的契合度

| 预期(若候选 2 成立) | 实测 |
|---|---|
| 无 staging HTTP 请求(无 `workspace-publish-staging/begin/put/commit`)| ✅ 日志零命中 |
| 无 formPackage / output-package system 消息(server 侧 commit 没触发)| ✅ 用户报告聊天无卡片(已确认) |
| artifacts 仍走 legacy upload(独立端点 `/api/teams/:id/artifacts/upload`)| ✅ 用户报告「文件同步到设备」(artifact 上传后 server 推 device snapshot) |
| daemon 主流程不报错(non-blocking 静默)| ✅ state.json `reasonCode: SERVICE_READY`,无 active work |

## Caveats / Not Found

- **未观察到 baseline HTTP 请求/响应**:daemon 不记录 `fetchProjectChannelWorkspaceCurrent` 的请求 URL 与响应体。无法从日志直接 200/404 取证;但「staging 分支零日志」间接证据极强。
- **未抓取 stdout 完整时间序列**:device-service.log 没有时间戳前缀(scanner 行无时间戳),无法定位「这次 Hermes dispatch 具体发生在哪一行」。但 grep 关键字零命中已经覆盖整个文件,与时间无关。
- **DM channel id `fda9a3be-...` 在日志中零出现**:即使 staging 没走,如果 dispatch 本身有日志(observe / deliver),频道 id 也应出现。零出现说明这次 dispatch 的 dispatch.* 日志也不在此文件。建议下一次复现时手动跑 `agentbean device log --follow` 或直接抓 socket 流量。
- **建议追加日志**:若要彻底诊断,可在 daemon `fetchProjectChannelWorkspaceCurrent` 失败时加一行 `console.warn('[workspace-publish] baseline fetch failed', { teamId, channelId, error: current.error })`,以及 staging 跳过时 `console.warn('[workspace-publish] staging skipped: no baseline')`。
