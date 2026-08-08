# Research: DM 频道接入 Project Channel Workspace 模型

- **Query**: 产品已决策 DM 频道也要支持 OutputPackage。调研 DM 接入 workspace 的设计空间。
- **Scope**: internal（server-next / daemon-next / web-next / 仓库迁移脚本）
- **Date**: 2026-08-07
- **工作分支**: `refactor/extract-channel-access` @ `5443a3a3`（落后 origin/main `adf3f8c2`，**未含 #1099**）

---

## 关键前提：分支状态差异（必须先确认）

当前工作分支 **不包含** #1099（"首次 publish baseline bootstrap"）。origin/main 已经合入。两处差异直接影响 DM 接入方案：

| 关注点 | 当前分支 (5443a3a3) | origin/main (adf3f8c2, 含 #1099) |
|---|---|---|
| `beginWorkspacePublishStaging` baseline 必填 | **必填**（usecases.ts:6293-6295 `baselineRevisionId is required`） | **可选**（usecases.ts:6294 注释 "baselineRevisionId 可选"） |
| `commitWorkspacePublishStaging` 无 workspace 行为 | 直接 `return NOT_FOUND`（usecases.ts:6912） | 空_baseline 路径跳过半态恢复，让 publishRevision bootstrap（usecases.ts:6908-6912） |
| `publishRevision` sqlite 实现 | 无 workspace 直接抛错 | 无 workspace 且无 baseline → 事务内 bootstrap 初始 workspace+revision（sqlite/repositories.ts:2320-2323） |
| daemon baseline 门 | `if (serverUrl && baselineRevisionId)`（index.ts:1171，无 baseline 跳过 staging） | `if (serverUrl)`（index.ts:1171-1173，无 baseline 也继续） |
| **三处 DM 硬拒** | **仍然存在**（usecases.ts:17349 / 17370 / 17395） | **仍然存在**（usecases.ts:17362 / 17383 / 17408） |

**结论**：#1099 的 bootstrap 在 origin/main 上对**普通频道**已生效（首次 publish 不再死锁），但对 DM **依然被三处 access 检查挡在 bootstrap 之前**。产品决策落地需要同时 (1) 解除 DM 硬拒 + (2) 把 #1099 拉到工作分支。

---

## 1. 三处硬拒的精确上下文

三处检查的字面源代码完全相同：
```ts
if (channel.kind === 'direct' || channel.name === 'all') return makeFailure('NOT_FOUND', 'Project Channel Workspace not found');
```
任务描述给的 17340/17361/17386 是三个 **函数定义** 的起点；实际 reject 行在 +7~+13 行处。三个函数都是 server-next usecases.ts 内部的 helper，签名一致：

### (a) `ensureUserCanViewProjectWorkspace` — usecases.ts:17342-17352

- **职责**：人类成员视角的频道可见性 + DM/all 黑名单。
- **调用方（7 处，全部是 usecase 方法的首行 access 检查）**：
  - `createProjectChannelWorkspace` (usecases.ts:5902-5903) — 人工创建初始 workspace（普通频道用）。
  - `getProjectChannelWorkspace` (5926-5927) — `GET /api/teams/:id/project-channel-workspace` 入口（**daemon `fetchProjectChannelWorkspaceCurrent` 命中此处**）。
  - `exportProjectChannelWorkspace` (5935-5936) — #969 归档导出。
  - `listProjectChannelWorkspaceRevisions` (5959-5960) — #969 AC#2 revision 列表。
  - `importProjectChannelWorkspace` (5966-5976) — device-token 侧 ws 创建。
  - `publishProjectChannelWorkspace` (6014-6015) — 直接 publish（非 staging）。
  - `materializeProjectChannelWorkspace` (6077-6092) — device 拉取 manifest 物化到本机 .agentbean。
- **解除条件**：删掉 17349 这一行。但 `getProjectChannelWorkspace` (5929-5930) 在 workspace 不存在时还会二次返回 `NOT_FOUND`，DM 即使通过 access 检查仍需有 workspace 才能成功返回 baseline。所以「只删一行」**不够**，要么 DM 在创建时预建 workspace（方案 a），要么依赖 #1099 bootstrap 在首次 publish 时建（方案 b，但 bootstrap 在 `publishRevision` 内，不在 `getProjectChannelWorkspace` 内 → `getProjectChannelWorkspace` 仍会 404 → daemon `fetchProjectChannelWorkspaceCurrent` 仍 `{ok:false}` → daemon 走空 baseline → #1099 流程接手）。

### (b) `ensureSnapshotChannelAccess` — usecases.ts:17361-17372

- **职责**：device snapshot（#1053）的频道访问判定。跨 Team 可见 Agent 时绕过人类成员校验，但仍保留 DM/all 黑名单。
- **调用方（3 处）**：
  - `materializeProjectChannelWorkspace`（cross-Team 分支，6107）
  - `recordDeviceWorkspaceSnapshot`（6135）— device 上报 snapshot。
  - `getDeviceWorkspaceSnapshot`（6259）— 拉取 snapshot 物化。
- **解除条件**：删 17370。无二级 fallback（snapshot 本身独立于 workspace 表，但 snapshot 携带 `workspaceRevisionId` provenance）。

### (c) `ensureWorkspacePublishChannelAccess` — usecases.ts:17382-17397

- **职责**：workspace publish staging（#1056）的频道访问判定。带 deviceActorToken 跨 Team 路径。DM/all 黑名单。
- **调用方（4 处，全部是 staging 生命周期）**：
  - `beginWorkspacePublishStaging` (6285-6286) — **daemon 走这里**。
  - `putWorkspacePublishStagingFile` (6608)
  - `getWorkspacePublishStaging` (6767)
  - `commitWorkspacePublishStaging` (6801-6802) — **commit 也独立查 access**，所以即使 begin 放过，commit 也必须放过。
- **解除条件**：删 17395。同 access 函数被 begin/put/get/commit 四处复用，**改一处即全覆盖**。

### 解除硬拒的「最小集合」

只需删 3 行（17349 / 17370 / 17395）。但「DM 能真正拥有 workspace」还需配合：
- **方案 a（创建时预建）**：在 `createDirectMessage`（usecases.ts:5278-5290）末尾追加 `projectChannelWorkspaces.createInitial({ workspace, revision })`，但首次创建时 `files=[]`，与 5906 行 `Workspace revision must contain files` 域规则冲突 → 需要允许空 revision 或带 placeholder artifact。
- **方案 b（首次 publish 懒建）**：必须把 #1099 拉到分支，让 `publishRevision` 的 bootstrap 接管。DM 首次 publish 时：daemon 通过空 baseline 进入 staging（需 daemon baseline 门放宽 + begin baseline 必填放宽），commit 阶段 publishRevision bootstrap 出初始 workspace+revision。

---

## 2. 普通项目频道的 workspace 创建模型

### 何时由谁创建

普通频道（kind='channel'）的 workspace 有 **三条创建路径**，最终都落到 `repositories.projectChannelWorkspaces.createInitial` 或 `publishRevision` 的 bootstrap 分支：

1. **用户主动创建**：`createProjectChannelWorkspace`（usecases.ts:5902-5923）— 用户上传初始文件集，建 workspace + revision #1。域约束：必须 ≥1 文件、所有 artifact 属于该频道、paths 唯一相对。
2. **Device import**：`importProjectChannelWorkspace`（5966-6012）— device-token 鉴权，验证文件→建 workspace + revision #1（带 `provenance.kind='import'`）。
3. **#1099 首次 publish 自动 bootstrap**（origin/main）：daemon 通过 staging commit → server `commitWorkspacePublishStaging`（无 workspace 空基线分支）→ `publishRevision`（sqlite/repositories.ts:2320+）事务内 INSERT workspace + revision #1。**仅 origin/main 有此分支**。
4. **非首次 publish**：`publishProjectChannelWorkspace`（6014）或 staging commit（7032）调 `publishRevision` 走 CAS 比对 baseline，写下一 revision。

### baseline 语义

- `baselineRevisionId` = 调用方在 read 阶段观察到的 `workspace.currentRevisionId`。
- `publishRevision`（sqlite repos）在事务内重新读取当前 `current_revision_id`，与 baseline 比对：
  - 相等 → 写入 newRevision（revision = current.revision + 1），更新 current_revision_id。
  - 不等 → 返回 `{kind:'conflict', current}`，由 usecase 算 `conflictingPaths` 返回给客户端。
- **#1099 bootstrap**：无 workspace 且 `baselineRevisionId` falsy → 直接建 workspace + revision #1，不进 CAS 比对。
- 「空 baseline + 已有 workspace」是非法态（基线应指向某 revision）→ 保留抛错（sqlite/repositories.ts:2323）。

### `fetchProjectChannelWorkspaceCurrent` 返回结构

daemon HTTP client（workspace-publish-http-client.ts:180-204）：
```ts
Promise<{ ok: true; currentRevisionId: string } | { ok: false; error: string }>
```
- 命中 `GET /api/teams/:id/project-channel-workspace?channelId=...` → dev-server.ts:925,940 → `getProjectChannelWorkspace` usecase。
- 成功响应：`{ ok: true, workspace: { currentRevisionId, currentRevision: { id, ... } } }`，client 提取 `workspace.currentRevisionId ?? workspace.currentRevision?.id`。
- 失败（含 DM 的 NOT_FOUND、workspace 不存在）：HTTP 非 200 或 `body.ok !== true || !body.workspace` → 返回 `{ok:false, error: body.error ?? HTTP_<status>}`。
- daemon 调用方（index.ts:1159-1169）只在 `current.ok` 时赋值 baselineRevisionId，否则保持原值（undefined）。

---

## 3. #1099 baseline bootstrap 机制（已合 origin/main，未在当前分支）

### 涉及文件清单

| 文件 | 改动 |
|---|---|
| `apps/server-next/src/application/repositories.ts` | `publishRevision` 接口 `baselineRevisionId` 改可选 + 新增 `newWorkspaceId?` |
| `apps/server-next/src/infra/sqlite/repositories.ts` | 2320-2323 无 ws 且无 baseline → bootstrap 初始 ws+revision #1；并发首次发布 UNIQUE 冲突返回 conflict |
| `apps/server-next/src/infra/memory/repositories.ts` | 同上 memory 后端 |
| `apps/server-next/src/application/usecases.ts` | begin baseline 必填放宽；commit 无 ws 空基线跳过半态恢复直接进 publishRevision |
| `apps/daemon-next/src/index.ts` | 1171 `if (serverUrl)` 取代 `if (serverUrl && baselineRevisionId)`，无 baseline 也继续 staging |
| `apps/daemon-next/src/workspace-publish-*.ts` | 全链路 baselineRevisionId 改 string（空字符串发 '' 满足 DB NOT NULL） |
| `apps/server-next/tests/workspace-publish-bootstrap.test.ts` | 6 个 repo 级 bootstrap 测试 |
| `apps/server-next/tests/workspace-publish-bootstrap-commit.test.ts` | 1 个端到端测试 |
| `apps/daemon-next/tests/workspace-publish-dispatch.test.ts` | 旧 BASELINE_UNAVAILABLE 断言改为断言 commit 发生 |
| `apps/server-next/tests/cutover-audit.test.ts` | mock 跟随 daemon 0.3.36 |

### 是否对 DM 自动生效？**否**

DM 在到达 `publishRevision` 之前就被 `ensureWorkspacePublishChannelAccess`（begin/commit 入口）的 DM 黑名单挡回。即使 #1099 拉到分支，DM 也不会触发 bootstrap。要让 DM 受益于 #1099，**必须同时删 usecases.ts 的三处 DM 硬拒**。

### bootstrap 在 DM 上的预期行为（假设硬拒已删）

1. DM 首次 Agent 产出 → daemon 收集 run_output。
2. daemon `fetchProjectChannelWorkspaceCurrent`：server `getProjectChannelWorkspace` 仍会因 workspace 不存在返回 NOT_FOUND（5929-5930 二次检查）→ daemon baselineRevisionId 保持空。
3. origin/main 的 daemon `if (serverUrl)` 继续走 staging → `begin`（origin/main 已允许空 baseline）→ `commit`（空 baseline + 无 workspace → 跳过半态恢复直接 publishRevision）→ publishRevision bootstrap 建 workspace + revision #1。
4. 后续 publish：`fetchProjectChannelWorkspaceCurrent` 成功 → baselineRevisionId 正常 → CAS 路径。

---

## 4. DM workspace 接入设计空间

### 方案 (a)：DM 创建时预建 workspace（与普通频道对称）

**改动清单**：
- server `createDirectMessage`（usecases.ts:5259-5293）：建 channel 后追加建空 revision + workspace。但 `createProjectChannelWorkspace` 5906 行强制 `files.length === 0` 拒绝 → 需放开或单独走 `createInitial` 直接路径。
- 域规则/DB schema：是否允许 revision.files 为空？migration 0067 `files_json TEXT NOT NULL` 允许 `'[]'`；`createProjectChannelWorkspace` 5906 的检查在 usecase 层，可绕。
- daemon：无需改动（首次 publish 走 CAS 路径，baselineRevisionId 非空 → 正常 revision #2）。
- 测试：DM workspace 创建用例 + OutputPackage 形成（formation 不依赖 channel.kind）。

**对称性**：与普通频道完全对称。普通频道可由用户主动建首 revision（`createProjectChannelWorkspace`），DM 由系统在 `createDirectMessage` 时建空 revision。
**风险**：
- revision #1 是「空 revision」语义未定义——`evaluateWorkspacePublish`（domain）是否接受 baseline=空 revision + 新 files？需要确认。
- legacy artifact upload（fallback）路径仍存在；DM 第一次产出现在能 publish 但用户可能还没准备好 → 没问题，DM 默认是私有的。
- DM 删除时 workspace 一并删（已有 `deleteChannel` cascade 5234 + 0077 FK CASCADE）。

### 方案 (b)：DM 首次 publish 懒创建（依赖 #1099）

**改动清单**：
- 把 origin/main 的 #1099（含 server begin/commit 放宽 + daemon baseline 门放宽 + sqlite/memory bootstrap + tests）cherry-pick / merge 到工作分支。
- 删 usecases.ts 三处 DM 硬拒（17349 / 17370 / 17395）。
- 评估 `getProjectChannelWorkspace`（5929-5930）的二次 NOT_FOUND 是否需要保留——保留也 OK：daemon 在 fetch 失败时走空 baseline → bootstrap 路径。
- 测试：新增「DM 首次 publish → workspace bootstrap」端到端；保留普通频道已有行为零回归。

**对称性**：与普通频道首次 publish 完全对称（#1099 的初衷就是普通频道首次 publish 死锁）。
**风险**：
- 依赖把 #1099 完整拉到分支（9 文件、10+ 测试）。如果当前 refactor/extract-channel-access 还要继续，建议先 rebase 到 origin/main 让 #1099 自然到位。
- daemon 版本要求：#1099 已发 daemon 0.3.36；老 daemon（≤0.3.35）仍走 `BASELINE_UNAVAILABLE` 路径——老 daemon 在 DM 上仍不能 publish。生产 daemon 升级是前置（参考 memory: canonical daemon 发布）。
- `ensureUserCanViewProjectWorkspace`（a 函数）的调用方里 `getProjectChannelWorkspace` 是 daemon fetch baseline 的入口；fetch 在首次必失败（workspace 不存在）。这是 #1099 已处理的现象，DM 与普通频道首次一致。

### 方案 (c)：DM 复用隐式/共享 workspace

**改动清单**：未发现现成隐式 workspace 模型。`channels` 表无 `workspace_id` 外键；`project_channel_workspaces` 是 1:1（migration 0067 `channel_id TEXT NOT NULL UNIQUE`）。复用意味着：
- 多 DM 共享同一 workspace：违反 `UNIQUE(channel_id)` 约束，需要 schema 变更。
- DM 与「主频道」共享：没有「主频道」概念，DM 不属于任何 channel。

**对称性**：与现有模型完全冲突。
**风险**：极大。需要拆 UNIQUE 约束、改 `publishRevision`/`getForTeam` 路径语义、引入 workspace 共享授权。**不推荐**。

---

## 5. DM 删除/归档时的 workspace 清理

### `deleteChannel`（usecases.ts:5208-5257）

**对 DM 已生效**（无 `kind` 区分）：
- 5233 `channelDocuments.deleteByChannel(channel.id)`
- 5234 `projectChannelWorkspaces.deleteByChannel(channel.id)` ← workspace 表清理（应用层级联）
- 5235 `artifacts.deleteByChannel`
- 5236 `messages.deleteByChannel`
- 5237 `channels.delete`

**OutputPackage 级联**：migration 0077 line 16 `output_packages.channel_id REFERENCES channels(id) ON DELETE CASCADE` → 频道删除时 packages 自动级联，**无需应用层调用**。
**OutputPackage 成员级联**：0077 line 70 `FOREIGN KEY (team_id, package_id) REFERENCES output_packages ON DELETE CASCADE`。
**Workspace publish staging**：0071 line 35 `FOREIGN KEY (team_id, publish_id) REFERENCES workspace_publish_stagings ON DELETE CASCADE`（指 staging files 表）。

**清理盲点（潜在问题）**：
- `deleteChannel` 没有显式删 `workspace_publish_stagings` 行——stagings 表是否有对 channels 的 FK？需要进一步看 0071 schema。如果不删，归档/删除 DM 后 staging 行可能残留（虽然 #1066 archive gate 会先把 active staging 置为 failed）。
- OutputPackage **未在 usecases.ts 显式 deleteByChannel**——靠 FK CASCADE，sqlite 后端 OK；memory 后端需要确认是否实现对应级联。

### `archiveChannel`（usecases.ts:5015-5207）

**对 DM 技术上生效**（无 `kind === 'channel'` 检查；只挡 default channel 与 `canApplyChannelUpdate` 要求 `createdBy === actorUserId`）。
- DM creator === 用户本人（usecases.ts:5286），所以 DM 用户可以归档自己的 DM。
- #1066 archive gate（5148-5162）：归档事务内把频道内 open/failed publish staging 显式收口为 terminal failed——DM 一旦有 staging 也会被收口。

---

## 结论：推荐方案 (b) 懒创建 + 改动清单

### 推荐：方案 (b) DM 首次 publish 懒创建 workspace

**理由**：
1. **最大化复用 #1099**：origin/main 已为普通频道首次 publish 死锁实现并测试了 bootstrap，DM 的死锁形态完全一致，直接复用代码+测试基线。
2. **零 schema 变更**：方案 (a) 需要 reinterpret「revision #1 = 空 revision」，方案 (c) 要拆 UNIQUE 约束。方案 (b) 不动 schema。
3. **与普通频道首次 publish 行为对称**：DM 与普通频道走同一条代码路径，未来维护成本最低。
4. **OutputPackage 形成路径已经天然就绪**：`outputPackageService.formPackage`（output-package-service.ts:74）只取 `(teamId, channelId, publishId, workspaceRevisionId)`，不检查 channel.kind。web-next 的 `OutputPackageCard`（components/OutputPackageCard.tsx）渲染只依赖 message meta，也不区分 channel.kind。一旦 DM publish 成功 → commit 后 formPackage 自动跑（usecases.ts:7150-7161）→ OutputPackage 自然形成 → 卡片自然渲染。

### 改动文件清单（按依赖顺序）

| 优先级 | 文件 | 改动 |
|---|---|---|
| **前置** | git | 把工作分支 rebase 到 origin/main（含 #1099）；冲突主要在 usecases.ts（已有 channel-access 抽取冲突可见） |
| 1 | `apps/server-next/src/application/usecases.ts` | 删 17349 / 17370 / 17395 三行 `if (channel.kind === 'direct' || channel.name === 'all') return makeFailure('NOT_FOUND', ...)`；保留 `channel.name === 'all'` 的部分（all 是系统默认频道，不应支持 workspace） |
| 2 | 测试 | 新增 DM publish bootstrap 端到端测试（参考 `workspace-publish-bootstrap-commit.test.ts`）；新增 DM OutputPackage 形成 + 查询测试（参考 `output-package.test.tsx`） |
| 3（可选） | `apps/server-next/src/application/usecases.ts:5929-5930` | 评估 `getProjectChannelWorkspace` 二次 NOT_FOUND 体验：保留也行（daemon 兜底）；但若要 DM UI 能展示「Workspace not yet created」状态，可新增专属 error code |
| 4（验证） | 无需改 daemon | daemon 已是 0.3.36（#1099 已发版）；若部署版本 ≤0.3.35，DM publish 仍会 BASELINE_UNAVAILABLE |

### 关键风险点

1. **分支落后 origin/main 4 个 PR**：#1089（channel-access slice 2）/ #1094（OutputPackage 查询剥离 socket 注入）/ #1098（防幽灵导出）/ #1099（bootstrap）/ #1100（daemon timeout）/ #1102（IME）/ #1103（daemon update self-lock）。直接基于当前分支改 DM，会与 #1099 的 begin/commit 改动严重冲突。**必须先 rebase**。
2. **legacy artifact upload 兼容**：daemon 在 staging 失败/跳过时回退 legacy upload（index.ts:1221,1264-1266）。DM 解除硬拒后，staging 应能成功；但若 staging 仍失败（如 server begin 因别的原因拒），daemon 会回退 legacy upload → OutputPackage 不会形成（formPackage 只在 commit 成功后跑）。需验证 DM staging 不被其他门挡住。
3. **#1053 reported 路径不可回退**：daemon `reportedStagingDropReason`（index.ts:1156,1260,1263,1271）专门处理 reported 输出——若 staging 在 DM 上失败，reported 路径明确报错而非回退。要确保 DM 解除硬拒后 staging 不失败。
4. **`ensureUserCanViewChannel`（channel-access.ts，OutputPackage 查询入口）**：本就不挡 DM。即 DM 即便不能 publish，已经存在的 OutputPackage 也能查到——但目前 DM 没有 publish 路径，所以查不到。方案 (b) 落地后这条路径自然可用。
5. **memory 后端级联**：sqlite 靠 FK CASCADE 删 output_packages；memory 后端是否实现 `deleteByChannel` 级联 outputPackages？`deleteChannel` 5233-5237 没显式删 outputPackages——memory 后端可能漏。需验证（不在本研究范围，标 follow-up）。
6. **DM revision 语义**：DM 是 1:1 用户↔Agent。revision 多版本在 DM 场景下的产品价值（用户能否回到旧 revision、是否需要 diff 视图）属于产品决策，本研究未涉及——但落地方案 (b) 后 revision 会自动产生，产品上是否暴露由前端决定。

---

## Caveats / Not Found

- **memory 后端 outputPackages 级联**：未深查 `apps/server-next/src/infra/memory/repositories.ts` 是否在 channel 删除时清理 outputPackages；sqlite 走 FK CASCADE 但 memory 后端可能需手动级联。如选方案 (b) 落地，DM 删除路径级联应在 memory 后端验证（潜在 follow-up bug）。
- **#1099 是否会被回滚**：未发现任何回滚迹象；origin/main 上稳定。但当前分支仍未合入，存在「团队是否计划改方向」的不确定性——建议设计前与 #1099 作者确认。
- **DM 归档产品意图**：归档 DM 的产品价值未明（用户归档自己的 DM = 隐藏对话？）。`archiveChannel` 技术上对 DM 生效，但是否暴露给用户是产品决策。
- **snapshot 路径（#1053）**：DM 是否需要 device snapshot 物化，取决于产品是否要求 DM 产出物化到本地 .agentbean。`ensureSnapshotChannelAccess` 解除后路径自然可用，但 DM 首次 snapshot 形成 baseline 的语义未深入研究。
