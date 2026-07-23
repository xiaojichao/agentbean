# 频道文件预览、目录浏览与 Markdown 编辑实施计划

- 日期：2026-07-23
- 状态：待实施
- 设计来源：`docs/superpowers/specs/2026-07-23-channel-files-preview-markdown-editing-design.md`
- 关联领域决策：ADR 0051–0055

## 1. 交付目标

把频道详情页“文件”标签从客户端附件平铺升级为：

- Server 权威频道文件索引；
- 可进入的来源目录和 Run 目录；
- 图片、视频、音频、PDF、Markdown 预览卡片；
- 统一站内预览器和下载操作；
- 流式大文件与媒体 Range；
- Server 异步 preview derivative；
- Markdown Channel document 版本编辑。

计划按可独立验证的纵向切片实施。每个切片完成后保持旧消息、旧下载和现有聊天上传可用。

## 2. 总体顺序

1. 冻结 contracts、领域策略和迁移骨架。
2. 先改造 Artifact 流式 I/O 与 Range，建立媒体基础。
3. 扩展 Daemon source root/role 上报。
4. 建立 Server Channel file index。
5. 建立 preview derivative 后台链路。
6. 提取共享卡片、预览器和目录浏览 UI。
7. 建立 Channel document 版本 API。
8. 交付 Markdown 编辑器、历史、恢复、草稿和发布。
9. 执行历史迁移、兼容回归、浏览器烟测和灰度。

## 3. Slice 1：Contracts、领域策略与 SQLite 迁移

### 目标

先冻结跨 Server、Daemon、Web 的语义，不改用户界面。

### 主要文件

- `packages/contracts/src/artifact.ts`
- `packages/contracts/src/channel-file.ts`（新）
- `packages/contracts/src/channel-document.ts`（新）
- `packages/contracts/src/socket.ts`
- `packages/contracts/src/index.ts`
- `packages/domain/src/channel-document-policy.ts`（新）
- `packages/domain/src/channel-file-policy.ts`（新）
- `apps/server-next/src/infra/sqlite/migrations/team/0037_channel_files.sql`（编号以实施时主线最高 migration 为准）
- `apps/server-next/src/application/repositories.ts`
- `apps/server-next/src/infra/memory/repositories.ts`
- `apps/server-next/src/infra/sqlite/repositories.ts`

### 数据结构

新增或等价表达：

- `artifact_source_roots`
- Artifact role/source root 字段或关系
- `channel_documents`
- `channel_document_revisions`
- `document_resource_references`
- `artifact_preview_derivatives`
- `artifact_preview_jobs`
- `channel_file_entries` 或等价 Server 查询投影

### 不变量

- Artifact 内容创建后不可覆盖；
- document revision 线性递增；
- current revision 必须属于同一 document；
- resource reference 只能指向同 Team/Channel 授权范围；
- source root 不保存公开绝对路径；
- final 不进入 Artifact role。

### 测试

- contracts schema/解析测试；
- domain 权限、角色、路径规范化、revision 冲突纯函数测试；
- memory/sqlite repository parity；
- migration 重复应用与外键完整性；
- 不可变 Artifact 冲突测试。

### 验证

```bash
npm run build:contracts
npm run build:domain
node scripts/run-vitest.mjs run packages/contracts packages/domain
```

## 4. Slice 2：流式 Artifact 上传、下载与 Range

### 目标

消除 10 MB 整块内存路径，为媒体和大文件建立安全底座。

### 主要文件

- `apps/server-next/src/dev-server.ts`
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/application/artifact-content-service.ts`（建议新建）
- `apps/server-next/src/application/repositories.ts`
- `apps/web-next/app/api/_artifact-upload-proxy.ts`
- `apps/web-next/app/api/teams/[teamId]/artifacts/upload/route.ts`
- `apps/web-next/lib/artifact-upload.ts`
- `apps/web-next/lib/socket.ts`
- `apps/daemon-next/src/artifact-uploader.ts`

### 实现要点

- multipart 流式写临时文件；
- SHA256、字节数和 MIME 在流式过程中计算；
- 校验完成后原子提交内容和 metadata；
- 单文件默认 250 MB，配置可覆盖；
- Run 总量默认 1 GB；
- GET preview/download 使用 `createReadStream`；
- 实现单 Range、206、416、`Accept-Ranges`；
- 继续强制下载危险 MIME；
- 上传失败不留下 Artifact 行或半文件；
- Daemon 返回被跳过文件及稳定诊断。

### 测试

- 大于旧 10 MB 的上传不进入整块 Buffer；
- 上传中断清理；
- 0 字节文件；
- 250 MB 边界前后；
- Range 首段、中段、尾段、越界；
- Content-Disposition 文件名安全；
- 权限、私密频道和 device/session token；
- Web proxy 不重新缓冲完整文件；
- Daemon Run 总量超限清单。

### 验证

```bash
node scripts/run-vitest.mjs run apps/server-next/tests/dev-server.test.ts
node scripts/run-vitest.mjs run apps/daemon-next/tests/artifact-uploader.test.ts
npm run build:server-next
npm run build:daemon-next
npm run build:web-next
```

## 5. Slice 3：Agent Artifact source root 与 role

### 目标

保留 Run 文件来自哪个根目录，并显式区分中间产物、普通运行产物和交付物。

### 主要文件

- `apps/daemon-next/src/artifact-collector.ts`
- `apps/daemon-next/src/artifact-uploader.ts`
- `apps/daemon-next/src/index.ts`
- `apps/daemon-next/src/workspace-run.ts`
- Agent 配置 contracts/schema
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/application/repositories.ts`
- `apps/web-next/app/[teamPath]/devices/page.tsx`
- Agent 详情/配置表单

### 实现要点

- 默认注册 `AGENTBEAN_OUTPUT_DIR` source root；
- Agent 配置增加显式额外输出根：label、env var、default role、recursive；
- Daemon 本地解析绝对路径，Server 只接收 root ID/kind/label；
- 工作目录继续使用 mtime 兼容扫描；
- 收集结果保留 root ID 和 root-relative path；
- 清单显式携带 role；
- source root 失败不阻断 Run，但写稳定诊断；
- 不扫描所有环境变量。

### 测试

- 不同 roots 同名路径不合并；
- 不同 Runs 同名路径不合并；
- 缺失 env、无权限、symlink 越界；
- role 使用显式值，否则使用 root 默认；
- 目录名不产生 final；
- Server payload 不含绝对路径；
- 旧 Daemon payload 仍兼容。

### 验证

```bash
node scripts/run-vitest.mjs run apps/daemon-next/tests/artifact-collector.test.ts
node scripts/run-vitest.mjs run apps/daemon-next/tests/dispatch-pipeline.test.ts
node scripts/run-vitest.mjs run apps/server-next/tests/socket-handlers.test.ts
npm run build:daemon-next
npm run build:server-next
npm run build:web-next
```

## 6. Slice 4：Server Channel file index

### 目标

让文件页完整查询频道文件，不再遍历客户端消息。

### 主要文件

- `apps/server-next/src/application/channel-file-index-service.ts`（新）
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/application/repositories.ts`
- `apps/server-next/src/infra/memory/repositories.ts`
- `apps/server-next/src/infra/sqlite/repositories.ts`
- `apps/server-next/src/transport/socket-handlers.ts`
- `apps/web-next/lib/socket.ts`
- `apps/web-next/lib/schema.ts`

### Socket 合同

- `channel-files:list`
- `channel-files:search`
- 文件索引 invalidated/changed 广播

### 查询能力

- current-directory direct children；
- cursor pagination；
- role filter；
- filename/path search；
- directories-first + updatedAt 排序；
- 文件夹后代计数和最多 4 个 preview cover；
- 公开来源投影；
- 频道权限校验。

### 可见性

明确排除：

- workspace run log；
- preview derivative；
- document 历史 revision；
- 非 root-delivery 内部 invocation 产物；
- 删除消息中的普通附件。

### 测试

- 分页之外的历史消息附件仍可见；
- 未发消息的公开 Run artifact 可见；
- 私密频道不可越权；
- 内部子调用产物不可泄露；
- 同路径跨 Run/source root 隔离；
- 目录直接子项；
- 搜索结果带公开完整路径；
- 消息删除使普通附件退出索引；
- 内存与 SQLite repository 一致。

### 验证

```bash
node scripts/run-vitest.mjs run apps/server-next/tests/channel-file-index.test.ts
node scripts/run-vitest.mjs run apps/server-next/tests/sqlite-repositories.test.ts
npm run build:server-next
npm run build:web-next
```

## 7. Slice 5：Preview derivative 后台链路

### 目标

为媒体卡片和目录封面提供可缓存、安全、异步的预览资源。

### 主要文件

- `apps/server-next/src/application/artifact-preview-service.ts`（新）
- `apps/server-next/src/application/artifact-preview-worker.ts`（新）
- `apps/server-next/src/application/usecases.ts`
- `apps/server-next/src/dev-server.ts`
- preview processor adapter（新）
- SQLite/memory repositories
- Server 启动与恢复 driver

### 实现要点

- Artifact 提交后幂等 enqueue；
- pending/processing/ready/failed/unsupported；
- 有限重试和 lease/恢复；
- 图片、视频首帧、PDF 首页输出 WebP；
- GIF/SVG 静态化；
- 音频提取封面或 unsupported；
- 内容寻址或 Artifact ID 缓存；
- derivative 路由独立授权；
- 处理器受超时、字节、像素和内存限制；
- 失败只降级卡片。

### 技术选择门禁

实施前做最小 spike，确认生产环境可用的图片/PDF/视频处理器。选择必须满足：

- Node 24；
- macOS 开发与 Railway/Linux 生产；
- 不要求用户 Device 在线；
- 可限制子进程资源；
- 安装体积和许可证可接受。

该 spike 只决定 processor adapter，不改变 Server 所有权 ADR。

### 测试

- 幂等 enqueue；
- worker 崩溃恢复；
- retry 封顶；
- malformed media；
- 超大像素图片；
- 视频首帧；
- PDF 第一页；
- unsupported audio；
- derivative 不进入文件索引；
- 缓存头与不可变 URL。

### 验证

```bash
node scripts/run-vitest.mjs run apps/server-next/tests/artifact-preview-service.test.ts
node scripts/run-vitest.mjs run apps/server-next/tests/dev-server.test.ts
npm run build:server-next
```

## 8. Slice 6：共享 Artifact 卡片、预览器与目录 UI

### 目标

先完成无编辑能力的文件浏览和媒体预览。

### 主要文件

- `apps/web-next/components/artifact/ArtifactCard.tsx`（新）
- `apps/web-next/components/artifact/ArtifactViewer.tsx`（新）
- `apps/web-next/components/artifact/ArtifactActions.tsx`（新）
- `apps/web-next/components/channel-files/ChannelFilesView.tsx`（新）
- `apps/web-next/components/channel-files/FolderCard.tsx`（新）
- `apps/web-next/lib/channel-file-path.ts`（新）
- `apps/web-next/lib/chat-artifact-url.ts`
- `apps/web-next/app/[teamPath]/chat/page.tsx`

### 重构要求

- 从大型 chat page 提取现有 `ChatArtifactPreview` 和 `ArtifactViewer`；
- 时间线、讨论串、任务交付物和文件页复用；
- 保持旧视觉行为后再扩展媒体类型；
- 卡片点击打开站内 viewer；
- hover/focus 操作一致；
- 触屏操作可达；
- Esc、焦点圈、焦点恢复；
- `filePath` URL、面包屑、前进后退；
- 目录只显示直接子项；
- loading、empty、failed、unsupported 状态完整。

### 测试

- 图片/视频/音频/PDF/Markdown 卡片；
- hover 与 keyboard focus；
- 触屏操作入口；
- viewer Esc/focus；
- URL path 往返；
- 文件夹封面和计数；
- 当前目录分页；
- 同一组件在时间线和文件页行为一致；
- 不再出现文件页新标签预览。

### 验证

```bash
node scripts/run-vitest.mjs run apps/web-next/tests/channel-files-view.test.tsx
node scripts/run-vitest.mjs run apps/web-next/tests/artifact-viewer.test.tsx
npm run build:web-next
```

## 9. Slice 7：Channel document Server 能力

### 目标

建立不可变 Markdown revision、权限、冲突、历史、恢复和发布的原子后端合同。

### 主要文件

- `apps/server-next/src/application/channel-document-service.ts`（新）
- `apps/server-next/src/application/channel-document-resource-service.ts`（新）
- `apps/server-next/src/application/usecases.ts`
- repositories/migrations
- `apps/server-next/src/transport/socket-handlers.ts`
- `packages/contracts/src/channel-document.ts`
- `packages/domain/src/channel-document-policy.ts`

### Socket 合同

- `channel-documents:get`
- `channel-documents:history`
- `channel-documents:save`
- `channel-documents:restore`
- `channel-documents:publish`

### 业务不变量

- 有频道访问权的人类成员可保存；
- 归档频道拒绝写；
- `baseRevisionId` 必须等于 current revision；
- 保存创建新 Artifact 和新 revision；
- current pointer 原子更新；
- 同名不合并；
- 恢复复制旧内容创建新 revision；
- 普通保存不创建消息；
- publish 创建消息并记录 publication；
- Run Markdown 首次保存派生文档，不回写 Run；
- 同目标路径冲突要求改名或显式选择；
- resource references 固定具体 Artifact revision。

### Markdown 限制

- UTF-8；
- ≤2 MB 可编辑；
- 2–10 MB 截断预览；
- >10 MB 不解析；
- 最多 500 个相对资源引用；
- 路径不能越过 root；
- 外部图片不自动加载。

### 测试

- 用户权限与私密频道；
- Agent 不能用 Web 文档编辑身份写；
- 并发保存只有一个成功；
- 失败不产生孤儿 revision；
- 恢复创建新最新版；
- 保存与 publish 区分；
- 历史消息 Artifact 不变；
- Run 派生保留 origin；
- 相对资源稳定；
- 缺失/越界引用；
- 归档频道只读；
- idempotency key 重试。

### 验证

```bash
node scripts/run-vitest.mjs run apps/server-next/tests/channel-document-service.test.ts
node scripts/run-vitest.mjs run packages/domain
npm run build:contracts
npm run build:domain
npm run build:server-next
```

## 10. Slice 8：Markdown 编辑器、版本历史与草稿

### 目标

完成用户可见的 Markdown 协作闭环。

### 主要文件

- `apps/web-next/components/channel-documents/MarkdownDocumentEditor.tsx`（新）
- `apps/web-next/components/channel-documents/DocumentHistoryPanel.tsx`（新）
- `apps/web-next/components/channel-documents/DocumentConflictDialog.tsx`（新）
- `apps/web-next/lib/markdown-renderer.tsx`（从 chat page 提取或新建）
- `apps/web-next/lib/markdown-draft.ts`（新）
- `apps/web-next/lib/channel-document.ts`（新）
- `apps/web-next/lib/socket.ts`
- `apps/web-next/app/[teamPath]/chat/page.tsx`

### 编辑体验

- edit/preview/split；
- 基础工具栏；
- Cmd/Ctrl+B、I、S；
- 保存、保存并分享到频道、取消；
- unsaved close guard；
- 2 MB 门禁；
- Run Markdown 首次保存提示；
- 冲突草稿保留；
- 历史预览、下载、恢复；
- archived read-only。

### Markdown 渲染器

- CommonMark + GFM 子集；
- 原始 HTML 作为文本；
- 危险协议过滤；
- 外部图片确认；
- Document resource reference；
- 时间线、文件预览和编辑预览共用。

### 本地草稿

- key 包含 user/team/document/base revision；
- 7 天 TTL；
- 恢复提示；
- 保存/丢弃/登出清理；
- 不跨用户泄露。

### 测试

- 工具栏和快捷键；
- split 响应式布局；
- 保存与 publish；
- 冲突提示和草稿保留；
- 恢复历史；
- 本地草稿 TTL 和用户隔离；
- raw HTML/XSS；
- 外部图片默认阻止；
- relative media；
- 归档只读；
- Run 派生提示。

### 验证

```bash
node scripts/run-vitest.mjs run apps/web-next/tests/markdown-document-editor.test.tsx
node scripts/run-vitest.mjs run apps/web-next/tests/markdown-renderer.test.tsx
node scripts/run-vitest.mjs run apps/web-next/tests/markdown-draft.test.ts
npm run build:web-next
```

## 11. Slice 9：历史迁移与回填

### 目标

让现有频道文件无损进入新索引，不阻塞部署。

### 迁移规则

- 普通消息附件 → role `attachment`；
- 每个 Markdown 消息附件 → 独立 Channel document v1；
- Workspace Run 文件 → `legacy_run` source root；
- 缺失路径 → 分组根目录；
- 不按文件名合并；
- 不推断 final/deliverable/intermediate；
- 不回扫设备；
- preview derivative 延迟回填。

### 实现要求

- migration 幂等；
- backfill 支持断点和批次；
- 文档/索引唯一键防重复；
- preview enqueue 低优先级；
- 旧 URL 和旧 socket 消息不变；
- 大 Team 不锁住主业务写入。

### 测试

- 重复运行无重复记录；
- 同名 Markdown 独立；
- 旧 Run 路径分层；
- 缺失 metadata；
- 删除消息附件；
- 旧下载 URL；
- 大批量分页 backfill；
- 部分失败恢复。

### 验证

```bash
node scripts/run-vitest.mjs run apps/server-next/tests/channel-file-migration.test.ts
node scripts/run-vitest.mjs run apps/server-next/tests/sqlite-repositories.test.ts
npm run build:server-next
```

## 12. Slice 10：端到端验收、灰度与生产检查

### 浏览器场景

在真实频道至少覆盖：

1. 根目录、运行产物、Task、Run、source root、嵌套目录导航；
2. 图片预览与下载；
3. 视频首帧与 Range 播放；
4. 音频播放；
5. PDF 首页与站内预览；
6. Markdown 编辑、保存、publish；
7. 两浏览器并发冲突；
8. 历史恢复；
9. 相对图片绑定；
10. 归档频道只读；
11. 历史文件迁移；
12. 私密频道越权拒绝。

### 烟测落点

- 扩展 `apps/server-next/tests/browser-smoke-script.test.ts`；
- 增加文件目录、preview/download bytes、Range、Markdown save/history smoke；
- 保存截图和关键网络响应；
- 不把真实设备绝对路径写入 fixture、日志或截图。

### 灰度顺序

1. 先部署 schema、兼容读写和旧 UI；
2. 开启 Server index shadow compare，比较旧附件汇总与新索引；
3. 开启流式下载和 Range；
4. 开启 preview worker；
5. 小范围启用新文件页；
6. 启用 Markdown 编辑；
7. 后台迁移历史 Markdown 和 preview；
8. 确认错误率、内存、存储与处理队列后全量。

### 监控

- 上传/下载字节和失败率；
- Range 响应率；
- preview job backlog、时延、失败码；
- Channel file index 查询延迟；
- Markdown 冲突率；
- migration/backfill 进度；
- Server RSS，确认不随单文件大小线性增长；
- Artifact 存储与 derivative 存储增长。

## 13. 每个 Slice 的完成门禁

任何 TypeScript Slice 都必须满足：

- 目标 Vitest 通过；
- 相关 repository memory/SQLite parity 通过；
- matching build 通过；
- diff 只包含当前 Slice；
- 权限失败路径有测试；
- 旧消息、旧下载和旧 Agent payload 保持兼容；
- 没有把设备绝对路径、token、环境变量值或底层异常正文暴露给频道成员。

根据仓库 Local Verification Contract：

- `apps/server-next` 修改后运行 `npm run build:server-next`；
- `apps/daemon-next` 修改后运行 `npm run build:daemon-next`；
- `apps/web-next` 修改后运行 `npm run build:web-next`；
- `packages/contracts` 修改后运行 `npm run build:contracts`；
- `packages/domain` 修改后运行 `npm run build:domain`。

## 14. 建议 Issue 拆分

实施时建议创建以下独立纵向 Issue：

1. Artifact 流式 I/O 与媒体 Range；
2. Agent source root/role 上报；
3. Channel file index 与目录 API；
4. Preview derivative worker；
5. 共享媒体卡片、viewer 与文件目录 UI；
6. Channel document 不可变版本服务；
7. Markdown 编辑器、历史、冲突与草稿；
8. 历史迁移、浏览器 E2E 与灰度。

每个 Issue 必须引用本设计和 ADR 0051–0055，并用中文标题、描述和验收标准。
