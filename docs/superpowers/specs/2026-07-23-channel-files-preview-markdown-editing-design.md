# 频道文件预览、目录浏览与 Markdown 编辑设计

- 日期：2026-07-23
- 状态：已确认
- 范围：频道详情页“文件”标签、Artifact 预览、Agent Run 产物目录、Markdown 频道文档
- 相关设计：
  - `docs/superpowers/specs/2026-07-17-project-task-file-management-design.md`
  - `docs/superpowers/specs/2026-06-19-daemon-artifacts-workspace-design.md`
- 相关 ADR：
  - `docs/adr/0051-channel-documents-use-immutable-artifact-revisions.md`
  - `docs/adr/0052-artifact-paths-do-not-determine-delivery-role.md`
  - `docs/adr/0053-artifact-previews-use-asynchronous-derivatives.md`
  - `docs/adr/0054-artifact-io-is-streamed-with-configurable-limits.md`
  - `docs/adr/0055-channel-files-use-a-server-owned-index.md`

## 1. 结论

频道文件标签页升级为 Server 驱动的频道文件库，而不是浏览器对已加载消息附件的临时平铺。

文件库统一展示：

- 频道消息和讨论串中的公开附件；
- Channel document 的当前 revision；
- 明确交付物；
- 未发布为消息但允许频道成员查看的 Run artifact；
- Run artifact 的来源根和目录层级。

当前目录中的图片、视频、音频、PDF 和 Markdown 使用预览卡片。鼠标悬浮或键盘聚焦时显示预览、下载操作，Markdown 额外显示编辑。文件夹以卡片进入，页面使用面包屑、浏览器历史和可分享 URL 保持目录位置。

Markdown 编辑采用“逻辑频道文档 + 不可变附件版本链”。保存创建新 revision，不覆盖消息和 Agent Run 当时引用的文件；恢复旧版本也通过创建新 revision 完成。

## 2. 当前事实与问题

当前 `apps/web-next/app/[teamPath]/chat/page.tsx` 中的文件页有以下限制：

- `conversationFiles` 只遍历当前浏览器已经加载的 `messages`；
- 文件页是扁平列表，不读取 `Artifact.relativePath`；
- 图片只有 56×56 缩略图，视频和其他媒体显示通用附件图标；
- 文件点击打开新标签，没有复用时间线和讨论串中的站内预览器；
- Markdown 只能渲染预览，没有编辑、版本、冲突或恢复能力；
- 未关联消息的 Run artifact 无法进入文件页；
- 历史分页之外的消息附件会漏失。

当前文件 HTTP 链路也不满足媒体预览：

- 单文件上限固定为 10 MB；
- 上传和读取把完整文件放入内存；
- 视频和音频没有 HTTP Range；
- `previewUrl` 返回原文件，没有独立缩略图；
- Server 没有 Artifact 内容更新或 Channel document API。

Daemon 已经提供：

- 每次运行独立的 `AGENTBEAN_OUTPUT_DIR`；
- Agent 工作目录的 mtime 兜底扫描；
- Codex 等适配器的额外生成目录；
- Artifact 的 `workspaceRunId` 和 `relativePath`。

但现有上传协议会丢失 Artifact source root 身份，也没有显式 Artifact role。

## 3. 目标

- 文件页完整、稳定地展示当前频道可见文件，不依赖聊天加载进度。
- 在目录内以真实预览图展示图片、视频等媒体。
- 时间线、讨论串、文件页复用相同的预览和下载体验。
- 支持 Agent 默认输出目录、工作目录和显式额外输出根。
- 让中间产物可查、可预览，但不淹没主要交付物。
- 为 Markdown 提供安全的源码编辑、预览、版本历史、冲突检测和恢复。
- 保持历史消息、Agent Run、审核证据和最终版事实不可变、可追溯。
- 为大媒体提供流式传输、Range 播放和异步缩略图。

## 4. 非目标

- WYSIWYG 富文本编辑。
- 多人实时光标或 OT/CRDT 协同。
- 内容逐行 diff、版本评论或分支。
- 硬删除文件、目录移动、批量重命名、拖拽整理。
- 手工创建空目录。
- 用目录、文件名或 `pathKind` 自动判断最终版。
- HTML、脚本、可执行文件的站内执行或嵌入。
- 跨频道文件库。

## 5. 领域模型

### 5.1 Message artifact revision

消息、讨论串或 Agent 交付引用发布时的不可变文件快照。后续编辑不能改变该 Artifact 的内容。

### 5.2 Channel document

频道内可持续编辑的逻辑 Markdown 文档，拥有稳定 `documentId` 和线性 revision 链。文档身份由 revision 链维护，不由文件名推断。

每个 revision 绑定一个新的不可变 Artifact。文档记录当前 revision 指针，历史消息继续引用发布时的旧 Artifact。

### 5.3 Artifact source root

一次 Agent Run 收集文件时采用的有边界目录。首版支持：

- `run_output`：系统提供的 `AGENTBEAN_OUTPUT_DIR`；
- `agent_workspace`：Agent 工作目录 mtime 兜底；
- `configured_output`：Agent 配置显式声明的环境变量目录；
- `adapter_generated`：适配器特有生成目录；
- `legacy_run`：历史数据合成来源根。

Server 只保存 source root 的稳定 ID、kind、公开名称和策略，不保存或公开设备绝对路径。

### 5.4 Artifact role

首版角色：

- `intermediate`：中间产物；
- `run_output`：没有进一步业务声明的普通运行产物；
- `deliverable`：Agent 结果清单或 Server 流程明确声明的交付物；
- `attachment`：普通消息附件。

目录可以给出默认角色，但角色必须显式落库。`final` 不属于 Artifact role；最终版继续由 ProjectArtifactCollection/Version 的审核事实和指针表达。

### 5.5 Run artifact

一次 Agent Run 从某个 source root 收集的不可变文件。Run artifact 保留任务、Run、Agent、source root 和根内相对路径。

### 5.6 Channel file directory

根据文件的公开逻辑路径形成的虚拟导航层。目录不是独立权限对象，也不持久化空目录。

### 5.7 Artifact preview derivative

系统为不可变 Artifact revision 生成的受限尺寸预览资源。它不进入文件索引、消息附件、版本历史、Agent 输入或项目交付物。

### 5.8 Document resource reference

Markdown revision 中相对路径与具体 Artifact revision 的稳定映射。历史预览不能通过同名路径动态切换到未来文件。

## 6. 文件索引与可见性

### 6.1 Server 事实源

新增 Channel file index，按频道授权查询。客户端不再通过消息列表构造文件页。

索引项至少包含：

```ts
interface ChannelFileEntry {
  id: string;
  kind: 'artifact' | 'document';
  teamId: string;
  channelId: string;
  artifactId: string;
  documentId?: string;
  filename: string;
  logicalPath: string;
  mimeType: string;
  sizeBytes: number;
  role: 'intermediate' | 'run_output' | 'deliverable' | 'attachment';
  sourceRoot?: {
    id: string;
    kind: string;
    label: string;
  };
  origin?: {
    messageId?: string;
    taskId?: string;
    workspaceRunId?: string;
    agentId?: string;
  };
  documentRevision?: number;
  preview?: {
    status: 'pending' | 'ready' | 'failed' | 'unsupported';
    url?: string;
    width?: number;
    height?: number;
    durationMs?: number;
  };
  createdAt: number;
  updatedAt: number;
}
```

字段可按代码风格拆分，但这些语义不能丢失。

### 6.2 包含范围

- 未删除的公开消息和讨论串附件；
- Channel document 当前 revision；
- 公开的 deliverable；
- 当前频道允许公开的 Run artifact；
- 中间产物，但收纳在“运行产物”目录。

### 6.3 排除范围

- `workspace-run.log` 等内部日志；
- preview derivative；
- 文档旧 revision；
- 未交付到当前频道根任务的内部子调用产物；
- 已删除消息中不再公开的普通附件；
- 越过频道或 Team 授权边界的 Artifact。

### 6.4 根目录结构

频道文件页根目录优先展示：

- 频道文档；
- 普通上传文件；
- 明确交付物；
- “运行产物”目录。

“运行产物”按任务或 Run 分组，再按 source root 和 `relativePath` 展示：

```text
运行产物/
  任务 A/
    Run 12/
      默认运行输出/
        reports/
          brief.md
          images/
            cover.png
      Agent 工作目录/
        scratch/
          draft.json
```

不同 Run 或不同 source root 中的同名路径不能合并。

### 6.5 目录查询

服务端目录查询只返回当前路径的直接子目录和直接文件：

```ts
interface ListChannelFilesInput {
  teamId: string;
  channelId: string;
  path: string;
  role?: ArtifactRole | 'all';
  cursor?: string;
  pageSize?: number;
}
```

同层目录先于文件，各组按最近更新时间降序。目录项包含后代文件数和最多 4 个可用 preview derivative，用于文件夹封面拼图。

目录位置写入 URL，例如：

```text
/{teamPath}/channel/{channelId}?chatTab=files&filePath=运行产物%2F任务A
```

浏览器前进、后退和刷新必须恢复位置。

### 6.6 搜索

搜索跨目录执行，结果显示：

- 文件名；
- 公开逻辑路径；
- Artifact role；
- 来源任务、Run、Agent；
- 更新时间。

搜索不返回设备绝对路径，也不能绕过目录可见性。

## 7. Agent 输出根与产物角色

### 7.1 默认输出根

每个 Run 自动注册 `AGENTBEAN_OUTPUT_DIR`，公开名称为“默认运行输出”。

### 7.2 显式额外输出根

Agent 配置可声明：

```ts
interface AgentArtifactSourceRootConfig {
  id: string;
  label: string;
  envVarName: string;
  defaultRole: 'intermediate' | 'run_output' | 'deliverable';
  recursive: boolean;
}
```

Daemon 在本机解析环境变量，校验路径和收集边界。Server 不接收绝对路径。

环境变量缺失、路径不存在、不可读或越界时：

- 跳过该 source root；
- Run 主执行不因此失败；
- 记录稳定诊断码；
- 在 Run 详情显示收集状态和被跳过原因。

### 7.3 工作目录兼容扫描

工作目录保留 mtime 兜底：

- 只收集 Run 开始后新增或修改的支持类型；
- 保留忽略目录、文件数量和容量上限；
- 默认 role 为 `run_output`；
- 不把工作目录绝对路径公开给频道成员。

### 7.4 Agent 结果清单

Daemon 上报的结果清单为每个 Artifact 携带：

- source root ID；
- 根内相对路径；
- SHA256；
- size；
- MIME；
- 显式 role 或 source root 默认 role；
- Run/Task/Invocation 来源。

目录名只能提供默认 role，不能自动设置最终版。

## 8. 媒体卡片与站内预览器

### 8.1 文件卡片

文件页使用响应式卡片网格：

- 图片、视频：16:9 真实缩略图；
- 音频：内嵌封面或通用音频封面；
- PDF：第一页缩略图；
- Markdown：渲染后的首屏摘要；
- 文本、JSON、CSV：安全文本摘要；
- 未支持文件：类型和文件信息卡片。

卡片下方统一显示文件名、大小、角色、发布者或 Agent、时间。

### 8.2 文件夹卡片

- 显示文件夹名、后代文件数；
- 最多 4 个后代缩略图组成封面；
- 点击进入目录；
- 不展示空目录。

### 8.3 操作合同

桌面端悬浮、键盘聚焦时显示：

- 预览；
- 下载；
- Markdown 的编辑。

点击卡片主体打开站内预览器，不打开新标签。触屏设备始终显示操作按钮或明确的更多菜单。

时间线、讨论串和文件页复用同一个 Artifact card、viewer 和 action model。

### 8.4 支持格式

- 图片：JPEG、PNG、WebP、GIF、AVIF、SVG；
- 视频：MP4、WebM、MOV；
- 音频：MP3、M4A、WAV、Ogg；
- 文档：Markdown、纯文本、JSON、CSV、PDF。

HTML、脚本、可执行文件和未知二进制只允许下载。

### 8.5 预览器

- 图片：适应窗口、查看原图；
- 视频：播放、暂停、进度、音量、全屏；
- 音频：原生播放器；
- PDF：站内查看；
- Markdown：安全渲染；
- 文本/JSON/CSV：受限文本预览。

Esc 关闭，焦点保持在模态框内，关闭后回到触发卡片。

## 9. Preview derivative 生命周期

### 9.1 状态

```ts
type ArtifactPreviewStatus =
  | 'pending'
  | 'processing'
  | 'ready'
  | 'failed'
  | 'unsupported';
```

原 Artifact 持久化成功后创建幂等任务，任务键绑定 Artifact ID/revision。

### 9.2 处理结果

- 图片：限制尺寸的 WebP；
- 视频：安全时间点的首帧 WebP；
- PDF：第一页 WebP；
- GIF/SVG：静态 WebP；
- 音频：提取内嵌封面，否则 `unsupported`；
- Markdown 摘要：由文档预览服务生成，不作为独立文件。

### 9.3 失败

处理器采用有限重试。失败只影响卡片缩略图：

- 文件仍可下载；
- 支持格式仍可打开原文件预览；
- Markdown 仍可编辑；
- UI 显示通用卡片；
- Run/管理员诊断可见稳定失败码。

### 9.4 所有权

规范 derivative 由 Server 文件生命周期拥有。浏览器和 Daemon 可以提供临时本地预览，但不能成为长期缓存事实源。

## 10. 流式 I/O 与容量

### 10.1 默认限制

- 单文件：250 MB；
- 单次 Run 归档总量：1 GB；
- Markdown 完整编辑：2 MB；
- Markdown 截断预览：2–10 MB；
- Markdown >10 MB：不解析，只下载；
- 每个 Markdown revision 最多解析 500 个相对资源引用。

限制允许部署配置，但 API 必须返回实际限制。

### 10.2 上传

- HTTP multipart 流式写入临时文件；
- 校验容量、MIME、SHA256 后原子提交；
- 失败清理临时文件；
- 不先创建一个可能没有内容的 Artifact 记录；
- 浏览器上传前校验已知限制；
- Daemon 对超限文件记录清单和稳定诊断。

### 10.3 读取

- 下载与原文件预览使用文件流；
- 视频和音频实现单 Range 请求；
- 返回 `Accept-Ranges`、`Content-Range`、正确的 206/416；
- 强制下载类型继续使用安全 `Content-Disposition`；
- 不把完整文件读入 Server 内存。

### 10.4 处理防护

缩略图处理限制：

- 输入字节数；
- 最大像素；
- 解码时间；
- 子进程时间和内存；
- 输出尺寸；
- PDF 页数只处理第一页。

异常媒体只能导致 derivative 失败。

## 11. Markdown 频道文档

### 11.1 自动建立文档

- 新的 Markdown 消息附件自动建立 Channel document；
- 每个附件独立建立，不能按文件名合并；
- Agent Run 中未发布的 Markdown 仍是只读 Run artifact；
- 首次编辑 Run Markdown 时派生新的 Channel document。

### 11.2 从 Run 派生

示例：

```text
运行产物 / 任务 A / Run 12 / 默认输出 / reports/brief.md
```

首次保存后创建：

```text
频道文档 / 任务 A / reports/brief.md
```

新文档记录：

- origin Artifact；
- taskId；
- workspaceRunId；
- agentId；
- 原 source root；
- 原相对路径。

原 Run artifact 保持只读。

### 11.3 权限

- 拥有频道访问权的人类成员可编辑；
- Agent 继续通过交付新 Artifact 产生内容；
- 归档频道只读；
- 私密频道继续使用频道成员门禁；
- 本次不提供 Channel document 删除或归档入口。

### 11.4 编辑器

首版使用 Markdown 源码编辑，不做 WYSIWYG。

模式：

- 编辑；
- 预览；
- 宽屏左右分栏。

工具栏：

- 标题；
- 粗体；
- 斜体；
- 链接；
- 无序/有序列表；
- 引用；
- 行内代码；
- 代码块。

快捷键：

- `Cmd/Ctrl+B`；
- `Cmd/Ctrl+I`；
- `Cmd/Ctrl+S`。

操作：

- 保存；
- 保存并分享到频道；
- 取消。

有未保存内容时，关闭或切换页面需要确认。

### 11.5 保存与发布

“保存”：

- 创建新的 Artifact；
- 创建新的 Channel document revision；
- 原子更新 current revision；
- 不创建频道消息。

“保存并分享到频道”：

- 完成上述保存；
- 创建一条引用新 revision Artifact 的频道消息；
- 记录 publication message ID。

普通保存不制造消息通知。需要协作提醒时由用户明确发布。

### 11.6 乐观并发

编辑器打开时记录 `baseRevisionId`。保存条件：

- current revision 仍等于 base revision；
- 文档未归档；
- 用户仍拥有频道访问权。

冲突时：

- 返回稳定冲突码；
- 不创建分叉 revision；
- 保留用户草稿；
- 提供查看最新版、复制草稿、重新载入并合并。

首版不自动三方合并，也不允许强制覆盖。

### 11.7 版本历史

每个 revision 展示：

- 版本号；
- 编辑者；
- 时间；
- 来源；
- 是否发布到频道；
- 文件名和逻辑路径。

历史版本可以预览和下载。

“恢复此版本”复制历史内容并创建新的最新版。它不能移动指针、删除后续版本或修改历史消息。

### 11.8 本地草稿

- 按用户、Team、documentId、baseRevisionId 隔离；
- 定期写入浏览器本地存储；
- 7 天过期；
- 刷新或崩溃后提示恢复；
- 成功保存、明确丢弃或退出登录时清除；
- 恢复后仍执行并发冲突检查。

## 12. Markdown 渲染与资源引用

### 12.1 语法

采用 CommonMark + GFM 子集：

- 标题、粗体、斜体、删除线；
- 链接、图片；
- 引用；
- 无序列表、有序列表、任务列表；
- 表格、分隔线；
- 行内代码、fenced code block。

首版不支持 Mermaid、数学公式、可执行代码块或插件。

### 12.2 安全

- 原始 HTML 按文本显示；
- 禁止 iframe、script、事件属性；
- 拒绝 `javascript:` 等危险协议；
- 外部图片默认不自动加载，用户确认后加载；
- 普通外链在新标签打开；
- 时间线、预览器和编辑器共用同一渲染器。

### 12.3 相对资源

支持：

```md
![效果图](./images/result.png)
[演示视频](./videos/demo.mp4)
```

保存或归档 revision 时：

1. 基于当前文档目录规范化路径；
2. 限制在所属 source root 或文档资源空间；
3. 解析到具体 Artifact revision；
4. 保存 Document resource reference；
5. 历史渲染使用固定引用。

无法解析时显示“引用文件不存在”。`../` 只能在同一 source root 内规范化，不能越界。

## 13. 数据与 API 边界

### 13.1 建议持久化对象

实现可以调整表名，但必须表达：

- Artifact source root；
- Artifact role；
- Channel document；
- Channel document revision；
- Document resource reference；
- Artifact preview derivative；
- Preview job；
- Channel file index/read model。

### 13.2 元数据事件

沿用 Socket 元数据操作：

- `channel-files:list`
- `channel-files:search`
- `channel-documents:get`
- `channel-documents:save`
- `channel-documents:history`
- `channel-documents:restore`
- `channel-documents:publish`

所有输入显式携带 Team/Channel，并在 Server 重新校验权限。

### 13.3 二进制 HTTP

建议路由：

- `POST /api/teams/:teamId/channels/:channelId/artifacts/upload`
- `GET /api/teams/:teamId/artifacts/:artifactId/preview`
- `GET /api/teams/:teamId/artifacts/:artifactId/download`
- `GET /api/teams/:teamId/artifacts/:artifactId/thumbnail`

Markdown 保存可以使用流式 HTTP 内容上传获得临时内容引用，再通过 Socket usecase 原子创建 revision；也可以使用单一受控 HTTP 命令。无论采用哪种传输，业务提交必须在 Server usecase 中完成，不能由客户端拼接多步非原子状态。

### 13.4 实时更新

以下变化广播频道文件索引失效或增量事件：

- 新消息附件；
- Agent Run artifact 完成；
- 文档保存、恢复或发布；
- preview derivative ready/failed；
- 消息删除；
- 频道归档。

打开文件页的客户端应增量刷新；打开旧 base revision 的编辑器继续保留草稿，保存时由 Server 判冲突。

## 14. 迁移

迁移必须幂等：

- 现有消息附件：role=`attachment`；
- 现有 Markdown 消息附件：每个 Artifact 建一个单 revision Channel document；
- 带 `workspaceRunId` 和 `relativePath` 的文件：归入 `legacy_run` source root，按 Run 隔离；
- 缺失来源信息：放在对应分组根目录；
- 不按文件名合并；
- 不推断 intermediate、deliverable 或 final；
- 不回扫 Agent 设备；
- preview derivative 低优先级或访问时补齐。

迁移后旧消息和下载 URL 继续有效。

## 15. 错误与诊断

至少冻结这些诊断类别：

- 文件不存在或无权限；
- 上传单文件超限；
- Run 总量超限；
- source root 缺失、不可读或越界；
- preview pending/failed/unsupported；
- Markdown 非 UTF-8、超限或引用过多；
- 文档 revision 冲突；
- 频道已归档；
- 相对资源不存在或越界；
- Range 非法。

用户界面显示可操作中文提示；底层路径、命令、秘密和任意异常正文不能泄露给普通频道成员。

## 16. 验收场景

### 场景 1：目录中的图片

Agent 交付 `reports/images/cover.png`。用户进入文件页，只在打开 `reports/images` 后看到真实缩略图；悬浮可预览、下载。

### 场景 2：目录中的视频

Agent 交付 MP4。卡片显示异步生成的视频首帧和播放标识；站内预览器支持 Range 播放和拖动。

### 场景 3：中间产物

Agent 工作目录产生临时 JSON 和图片。它们进入“运行产物 / Task / Run / Agent 工作目录”，标记为中间或普通运行产物，不进入最终版候选。

### 场景 4：Markdown 编辑

用户打开 Markdown，切换源码与预览，保存后得到 v2。原消息仍展示 v1，文件页展示 v2。

### 场景 5：保存并发布

用户选择“保存并分享到频道”，系统创建 v3 并发布带 v3 Artifact 的新消息；v1/v2 历史不变。

### 场景 6：并发冲突

两位成员同时基于 v3 编辑。第一位保存 v4；第二位保存时收到冲突，草稿保留，没有 v3 分叉或静默覆盖。

### 场景 7：恢复版本

用户恢复 v2，系统创建 v5，当前指针变为 v5；v3/v4 仍可预览。

### 场景 8：相对图片

Markdown v1 引用 `./images/a.png`。后来同路径出现新图片，历史 v1 仍渲染原 Artifact revision。

### 场景 9：归档频道

归档后文件页仍可浏览、预览、下载和查看文档历史，但所有编辑、恢复和发布操作被拒绝。

### 场景 10：历史迁移

迁移后旧图片、视频和 Markdown 出现在正确分组；同名 Markdown 不合并，旧链接继续有效，部署不等待全部缩略图生成。

## 17. 与项目文件管理设计的关系

本设计实现“文件库可浏览、可预览、可编辑”的基础层，不替代 ProjectArtifactCollection、ProjectArtifactVersion、ArtifactReview 或最终版指针。

- Artifact source root 和相对路径负责来源与导航；
- Artifact role 负责中间产物、普通运行产物和交付物分类；
- Channel document 负责 Markdown 协作版本；
- ProjectArtifactCollection/Version 负责项目阶段、审核和最终版。

同一个 Artifact revision 可以同时作为 Channel document revision 的内容事实和 ProjectArtifactVersion 的文件事实，但两个上下文的状态不能互相隐式推断。
