# #1044 实现计划:run output 通过 publish identity 原子发布并恢复

- 父规格:#1041;目录决议:#1040;前置:#1043(已合 main,PR #1047)。
- 范围:只做 #1044;不动 PR #1039;不实现 #1045。

## 现状地基(已合 main)

| 能力 | 位置 | 来源 |
| --- | --- | --- |
| Channel-first projection(`workspaces/<team>/channels/<channel>/{snapshots,runs,outputs,cache}`) | `apps/daemon-next/src/workspace-run.ts` | #1042 |
| 不可变 snapshot 物化 + Server 权限复验 | `workspace-snapshot.ts`、usecases `createDeviceWorkspaceSnapshot/getDeviceWorkspaceSnapshot` | #1043 |
| staging begin/put/get/commit:幂等 begin(plan 兼容检查)、严格 offset、hash/size 校验、CAS baseline、半态恢复、孤儿 artifact 清理、过期清理、磁盘 content store | `apps/server-next/src/application/usecases.ts` 5898+ | #966/#967/#1005 |
| 稳定 publishId(`dispatch-<sha256(dispatchId,channelId,baseline)[:24]>`)+ 交付 + 扁平恢复 store(`~/.agentbean/workspace-publish-pending/`) | `workspace-publish-delivery.ts`、`workspace-publish-recovery.ts` | #967/#1003 |
| `outputs/<publishIdentity>` 目录原语 + 一次性 manifest | `prepareChannelWorkspaceOutput` / `stageChannelWorkspaceOutputs` | #1042 |
| run 级 `reportedAt` 去重 + Channel run 恢复发现 | `workspace-run.ts` | #1042 |

## Gap 对照 9 条 AC

1. **AC1 collector 范围**:projection run 已只扫 `outputDir`(`index.ts:871-875`,projection 时不传 cwd);缺 inputs/logs/intermediates/cache/snapshots 不误收的回归 pin。
2. **AC2 publish manifest**:现 manifest 只写一次,缺**上传进度、Server 返回身份、状态机**;且 delivery 仍从**原始 absolutePath** 上传,staged copy 是死重,run 目录清理后无法恢复。
3. **AC3 复用 staging**:已满足,不动。
4. **AC4 幂等**:Server 已满足;daemon 侧随新 store 保持;补端到端重复 deliver/resume 收敛测试。
5. **AC5 恢复**:恢复发现只认扁平 store;`outputs/<publishIdentity>` 批次若 store 记录丢失成孤儿 → 需要以 publish manifest 为权威记录的 discovery。冲突批次目前每次启动重复 warn → 引入 `abandoned` 标记。
6. **AC6 commit 重验**:Team/Channel/Device/baseline 已有;**缺 Agent authority(agent 存在、primaryTeamId/visibleTeamIds、channel.agentMemberIds、device↔agent 绑定)与 Task authority(task 存在时须属于本 team/channel;合成 fallback id 放行)**。
7. **AC7 项目事实时机**:已满足(物化在 CAS 前但孤儿清理;revision 只在 CAS 成功出现);补「目录名/pathKind 不设置 review/current/final」pin。
8. **AC8 Memory egress**:缺 Device-local Memory 正文不进 manifest/日志 Artifact/回报的 canary 测试。
9. **AC9 测试与 build**:本计划第 5 节。

## 方案

### A. daemon 新模块 `workspace-publish-output.ts`:publish manifest 成为本机权威批次记录

`outputs/<publishIdentity>/.agentbean-publish/manifest.json` schema v2(原子 tmp+rename 写):
控制 manifest 放在保留元数据目录，避免覆盖合法的用户交付物 `manifest.json`；元数据目录不参与
发布文件清单。

```ts
{
  schemaVersion: 2,
  publishIdentity, teamId, channelId, deviceId,
  agentId, taskId, taskAttempt, workspaceRunId?,
  baselineRevisionId,
  status: 'pending' | 'committed' | 'abandoned',
  files: [{ relativePath, filename, sha256, sizeBytes, uploadedBytes, complete }],
  committedRevisionId?,   // Server 返回身份(commit 成功后写入)
  createdAt, updatedAt, reportedAt?
}
```

- 不含任何外部绝对路径(跨 Device 合同干净);staged copy 路径由 outputDir + relativePath 运行时拼出,不落盘。
- `stageRunOutputsToPublishOutput()`:复制 run 确认文件到 `outputs/<publishIdentity>/` 并写 manifest。同 identity 同 plan 重复调用幂等(保留已有进度);plan 不同抛 `WORKSPACE_PUBLISH_OUTPUT_PLAN_MISMATCH`。
- `discoverRecoverableWorkspacePublishOutputs({agentBeanHome, deviceId})`:扫 `workspaces/*/channels/*/outputs/*/.agentbean-publish/manifest.json`,校验 `device.json` 与 manifest.deviceId,返回 status==='pending' 的批次。
- `createWorkspacePublishOutputStore({agentBeanHome, deviceId})`:实现既有 `WorkspacePublishRecoveryStore` 接口,以 manifest 为存储;`absolutePath` 指向 staged copy。delivery/resume 代码路径不变。

### B. delivery/recovery 切 staged copy + 进度回写

- `WorkspacePublishRecoveryStore` 增加 `markProgress(publishId, path, uploadedBytes, complete, now)` 与 `markAbandoned(publishId, now)`(required;老扁平 store 同步实现,测试 fake 同步更新)。
- `deliverWorkspaceOutputsViaStaging` / `resumeLocalWorkspacePublish`:每个 put 成功后回写进度;CONFLICT 时 `markAbandoned`(可诊断、不再每次启动重复重试)。
- dispatch 内 delivery 的 `collected` 改用 staged copy 的 absolutePath;stage 失败 → 跳过 staging 发布回退 legacy upload(保持「staging 失败不阻塞 dispatch」既有语义),不产生 manifest 与上传源不一致的状态。

### C. index.ts 接线

- 新发布走 manifest store;旧扁平 store 保留**只读恢复**(升级前 in-flight 记录不丢),不再写入。
- 启动/重连 resume:legacy `listPending()` + manifest discovery 两路,server 端幂等收敛,重复 resume 安全。
- run 回报 `onDelivered` 时,若本次 staging 已 committed,同步写 publish manifest `reportedAt`(稳定标记)。

### D. Server:commit 重验 Agent/Task authority(usecases.ts)

新 helper `ensureWorkspacePublishProvenanceAuthority(repositories, { teamId, channel, provenance, deviceId? })`:

- agent:存在、`primaryTeamId===teamId`、`visibleTeamIds` 含 teamId、`channel.agentMemberIds` 含 agent.id;device 路径另要求 `agent.deviceId===deviceId`。失败 → `FORBIDDEN` + `reason:'agent-authority-revoked'`。
- task:`tasks.getById(provenance.taskId)` 存在时要求 `teamId` 匹配且 `channelId` 为空或等于本 channel;不存在(合成 fallback id)放行。失败 → `FORBIDDEN` + `reason:'task-authority-mismatch'`。
- 调用点:begin(新建与 existing-open 返回前,fail-fast;committed 短路不查)、commit(open 路径、物化 artifact 之前;committed 短路不查)。ForDevice wrapper 从 token 解析 deviceId 传入(与 `createDeviceWorkspaceSnapshot` 同款);user 路径 deviceId 缺省时跳过 device 绑定。
- 撤销场景:不产生部分 revision(检查在物化之前),staging 保持 open 可诊断。

### E. contracts:provenance 追溯增强(向后兼容 optional)

- `WorkspacePublishStagingDto.provenance` 与 `WorkspacePublishProvenanceDto` 增加可选 `workspaceRunId?: ID`、`deviceId?: ID`;begin input 同步;commit 写入 revision provenance。
- 满足 #1041「provenance 可追溯到 Device、Agent、Task attempt、WorkspaceRun 和输入 revision」。

### F. 测试

Server(内存 + SQLite 双仓储,复用现有测试基建):
- commit 时 agent 被删/移出 channel/换绑 device → FORBIDDEN,无 revision、无 artifact 残留;staging 保持 open 可诊断。
- commit 时 task 属于其他 channel → FORBIDDEN;合成 taskId 放行。
- begin 时 agent 已撤 → fail-fast FORBIDDEN。
- AC7 pin:commit 产物 artifact 无 review/current/final 标记,pathKind 不承载语义。

Daemon:
- stage:复制 + manifest 内容(进度 0、无绝对路径);重复 stage 幂等;plan 变更拒绝。
- discovery:team/channel/agent 隔离;他 device 批次不恢复;committed/abandoned 不恢复。
- 断点续传从 staged copy:删除原 run outputs 后 resume 仍成功;put 后 uploadedBytes 回写;commit 后 committedRevisionId;重复 deliver/resume 收敛同一 revision。
- dispatch-pipeline 端到端 pin:inputs/logs/intermediates/cache/snapshots/manifest/response 不被收集发布(AC1)。
- AC8 canary:Device-local Memory 正文不进 publish manifest、staged 文件、日志 Artifact、执行回报。

验证命令:
- `npm run test:server-next -- workspace-publish`(或对应 vitest 过滤)
- daemon-next dispatch/recovery 测试
- `npm run build:server-next`、`npm run build:daemon-next`

## 边界(不做)

- #1045;PR #1039;旧目录自动迁移;OutputPackage/审核/current/final 合同变更;对象存储/传输协议选型。
- 旧扁平 store 数据迁移(只读恢复,自然消亡)。
