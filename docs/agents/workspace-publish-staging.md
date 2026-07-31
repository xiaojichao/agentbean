# Project Channel Workspace 发布暂存（staging）API 索引

实现 issue：[#967](https://github.com/xiaojichao/agentbean/issues/967)（服务端暂存与原子提交）  
接线与恢复：[#1003](https://github.com/xiaojichao/agentbean/issues/1003)（daemon HTTP 客户端 + pending 恢复）  
大文件磁盘存储：[#1005](https://github.com/xiaojichao/agentbean/issues/1005)

本页只做**发现入口**；行为合同以 domain 策略与定向测试为准。

## Usecase

`apps/server-next` 的 `createServerNextUseCases`：

| 方法 | 作用 |
| --- | --- |
| `beginWorkspacePublishStaging` / `…ForDevice` | 登记 publish 身份、基线 revision、文件清单（size/sha） |
| `putWorkspacePublishStagingFile` / `…ForDevice` | 严格 offset 串行续传；已 complete 幂等 |
| `getWorkspacePublishStaging` / `…ForDevice` | 查询进度；过期 open 安全清理后返回 NOT_FOUND |
| `commitWorkspacePublishStaging` / `…ForDevice` | 校验完整后原子 publish revision；冲突不合并 |
| `cleanupExpiredWorkspacePublishStaging` | 批量清理过期 open 暂存 |

上传中的字节**不会**进入 workspace revision、频道文件索引或成员可下载列表（DTO 剥离 `content` / `storagePath`）。

### 字节存放（#1005）

- **生产 / dev-server**：`stagingContentStore` → `dataDir/workspace-staging/{teamId}/{publishId}/…`
- **metadata**：team SQLite `workspace_publish_stagings` + `workspace_publish_staging_files`（path/size/sha/received/complete；可选 `storage_path`）
- **单元测试默认**：不传 `stagingContentStore` 时仍用 memory `content` Buffer

## HTTP（device / daemon）

基路径：`/api/teams/:teamId/workspace-publish-staging`

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| `POST` | `…/begin` | JSON：channelId, publishId, baselineRevisionId, files, provenance? |
| `POST` | `…/put` | multipart 或 raw body；query/字段含 channelId, publishId, path, offset |
| `GET` | `…?channelId&publishId` | 查询 staging 状态 |
| `POST` | `…/commit` | JSON：channelId, publishId |

辅助：`GET /api/teams/:teamId/project-channel-workspace?channelId`（device 冻结 baseline）。

认证：session 用户或 device token（`…ForDevice`）。

入口实现：`apps/server-next/src/dev-server.ts` → `handleWorkspacePublishStagingHttp`。

## Socket 事件

定义：`packages/contracts` → `WEB_EVENTS.project`

| 事件名 | 绑定 usecase |
| --- | --- |
| `project:begin-workspace-publish-staging` | `beginWorkspacePublishStaging` |
| `project:get-workspace-publish-staging` | `getWorkspacePublishStaging` |
| `project:commit-workspace-publish-staging` | `commitWorkspacePublishStaging` |

**put 不走 socket**（避免大包经 socket）；客户端应使用 HTTP put。

## Daemon 恢复与生产接线

- 本地 pending 目录：`{daemonRoot}/workspace-publish-pending/`（见 `apps/daemon-next/src/workspace-publish-recovery.ts`）
- 交付路径：`deliverWorkspaceOutputsViaStaging`（`workspace-publish-delivery.ts`）
- HTTP 客户端：`workspace-publish-http-client.ts`

#1003 已把 daemon 可恢复发布接到生产交付路径（PR #1011）。若本机仍见旧行为，确认 daemon 版本已包含该接线，并检查 pending 目录是否有未完成 publish。

## 相关 PR / issue

| 项 | 链接 |
| --- | --- |
| 服务端 staging 核心 | PR #992、#1000 |
| daemon 接线 | #1003 → PR #1011 |
| 磁盘存储 | #1005 |
| 文档勾选 | #1006 |
