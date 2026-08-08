# 陷阱汇总：相对路径 / workspace-run.log / readonly 幻觉

## 何时适用

每次在 server-next 写新模块、改读路径、或处理 DTO 时先过一遍这份清单。这些是已造成过生产/CI 事故的真实坑，每条带源码佐证。

## 本地模式

### 1. 相对路径 import 是强制的（不是风格偏好）

vitest 无别名解析、CI 不构建 `dist`、`@agentbean/contracts` 这类包名 import 会解析到 `node_modules` 软链的 stale `dist`，CI 下失败。所有 workspace 内包必须用相对路径 import 源码。

权威头部声明：

- `src/application/channel-access.ts:1-3`：`// server-next 惯例:workspace 包用相对路径 import 源码(vitest 无 alias、CI 不构建 dist)。` + `import ... from '../../../../packages/contracts/src/index.js'`
- `src/application/output-package-service.ts:1-2`：同款声明 + 相对路径 import。

模式：`../../../../packages/contracts/src/index.js`（带 `.js` 扩展名，TS ESM 要求）。新模块第一行照搬。

### 2. workspace-run.log 必须在每个 chat 读路径过滤

`workspace-run.log` 是内部产物，不能进 chat 面的历史/DM 快照/搜索/广播。过滤函数 `isWorkspaceRunLogArtifact`（`src/application/usecases.ts:13100-13105`）：

```
artifact.workspaceRunId !== undefined
  && (artifact.relativePath === 'logs/workspace-run.log' || artifact.filename === 'workspace-run.log')
```

每个 chat 面读路径都要门控，当前调用点（`src/application/usecases.ts`）：

- `:8274`（`|| isWorkspaceRunLogArtifact(artifact)`）
- `:10222`（`artifacts.find(isWorkspaceRunLogArtifact)`）
- `:10998`（`artifacts.filter((a) => !isWorkspaceRunLogArtifact(a))`）
- `:13151`（`.filter(...)`）
- `:13457`（`if (isWorkspaceRunLogArtifact(artifact)) continue;`）
- `:16649`（`if (!artifact || isWorkspaceRunLogArtifact(artifact)) return null;`）

新增任何列 artifacts 给 chat 面的路径，**必须**用 `isWorkspaceRunLogArtifact` 过滤，否则内部日志泄漏成可见消息。

### 3. DTO readonly 是编译期幻觉——detachPolicy 防御拷贝

TypeScript 的 `readonly` 只在编译期成立，运行期对象可被改写。management-router 曾因此被坑：调用方一次 `policy.placementPolicy.placement = 'auto'` 就改写了全进程共享的 policy 引用，让 #724 桥接（本该恒为 device）落进 auto 解析。

佐证（`src/application/management/management-router.ts`）：

- `:24-:30` 注释详述此陷阱（`DTO 的 readonly 只在编译期成立...`）。
- `:595` 定义 `function detachPolicy(record): ManagementPolicyRecord` 返回防御拷贝。
- 调用点：`:148`（`stored ? detachPolicy(stored) : ...`）、`:214`（`policy: detachPolicy(policy)`）。

规则：从仓储按引用取出的对象出手前必须 `detachPolicy`（或等价深拷贝）。**不要假设 readonly 能挡住可变引用外泄**（详见 「共享可变引用外泄」memory）。

### 4. 其它文档里的坑（按主题查）

- 迁移重复号 / 表守卫 / disableForeignKeys → [migrations.md](./migrations.md)
- 投影 FK 必须 CASCADE / team_id 无 REFERENCES → [data-model.md](./data-model.md)
- route() 二次读勿短路 / crossedBarrier 防双投递 → [authorization.md](./authorization.md)
- 新 transport 事件须扩 readiness 剥离链 → [socket-and-readiness.md](./socket-and-readiness.md)

## 佐证文件

- `/Users/shaw/AgentBean/apps/server-next/src/application/channel-access.ts`（:1-3 相对路径声明）
- `/Users/shaw/AgentBean/apps/server-next/src/application/output-package-service.ts`（:1-2 相对路径声明）
- `/Users/shaw/AgentBean/apps/server-next/src/application/usecases.ts`（:13100-13105 isWorkspaceRunLogArtifact、:8274/:10222/:10998/:13151/:13457/:16649 调用点）
- `/Users/shaw/AgentBean/apps/server-next/src/application/management/management-router.ts`（:24-30 readonly 陷阱注释、:595 detachPolicy、:148/:214 调用）

## output-package 卡片的 thread 归属与内嵌(#1111)

- **卡片 threadId 解析**:`output-package-handler.ts` `resolveOriginThreadId`——`staging.provenance.workspaceRunId → dispatch → message`,`message.threadId ?? message.id`。链断回退主线(不传 threadId)。
- **生产形态坑**:daemon 上报的 `provenance.workspaceRunId` **等于 dispatchId/taskId**,与 server 侧 `workspace_runs.id` 不同源(2026-08-07 实证:#1116 只按 runId 查静默回退主线,#1117 补 dispatch 兜底)。**测试构造数据形态必须对齐生产实证**,单测里让两个 id 一致=镜像错误假设。
- **内嵌形态**:daemon ≥0.3.43 结果回报 `workspaceRun.publishId`;`receiveDispatchResult` 在 append 回复前经 `readOutputPackageCardMeta` 读 package 快照挂进回复 `meta.outputPackageCard`。独立卡片仍在 commit 时创建(结果未达/resume 兜底),web 端隐藏被内嵌吸收者。
- **历史 publish 补偿**:旧终态结果可能没有 `workspaceRun.publishId`;补偿重放只允许新增这一字段,正文/artifact/workspaceRun 其余字段必须仍匹配首次结果 fingerprint。该增量路径要求 committed staging 显式携带 `provenance.workspaceRunId`,并确认该 run 归属当前 dispatch；不得用“同频道同 Agent”或当前 dispatch 的任意 run 作为缺失 lineage 的替代，否则会把其他任务的 publish 串到原回复。
- `x-workspace-path` header 只许 Latin-1:daemon 侧必须 `encodeURIComponent`(中文文件名实证 ByteString 拒),query 参数是权威传输。

## 反模式

- **新模块用 `@agentbean/contracts` 包名 import**：CI 解析 stale dist，失败。
- **新 chat 读路径不过滤 workspace-run.log**：内部日志泄漏。
- **手 return 仓储取出的 policy/可变对象不做深拷贝**：调用方改写全进程共享值。
- **用 `// eslint-disable` 绕过上述规则而不修**：坑留给下一个人。

## 验证命令

```bash
cd /Users/shaw/AgentBean/apps/server-next
# 新模块有没有偷用包名 import（应无输出）
grep -rn "from '@agentbean/" src/ | grep -v node_modules
# chat 读路径都过滤了 workspace-run.log（新增路径要出现在此列表）
grep -n "isWorkspaceRunLogArtifact" src/application/usecases.ts
# detachPolicy 仍在防御
grep -n "detachPolicy" src/application/management/management-router.ts
```
