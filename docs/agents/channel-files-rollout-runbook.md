# 频道文件库上线与回退 Runbook

本 Runbook 是 Issue #781 的生产保护记录模板。每次启用或回退都要把变更时间、操作者、部署版本和 smoke 产物目录写入发布记录；不把用户文件名、设备绝对路径、Token 或内部 invocation 信息写入日志。

## 开关

Server 通过环境变量独立控制以下能力。未配置时保留当前兼容读路径，风险较高的写入和迁移默认关闭。

| 环境变量 | 默认值 | 作用 |
| --- | --- | --- |
| `AGENTBEAN_CHANNEL_FILES_BROWSER` | `true` | 频道文件目录页；关闭后客户端回退到消息附件读取 |
| `AGENTBEAN_CHANNEL_FILES_INDEX_SHADOW_COMPARE` | `false` | 只读比较旧附件汇总与 Server 文件索引 |
| `AGENTBEAN_CHANNEL_FILES_STREAMING` | `false` | Artifact 流式读、媒体 Range |
| `AGENTBEAN_CHANNEL_FILES_PREVIEW_WORKER` | `true` | 异步图片/视频首帧/PDF preview worker |
| `AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING` | `false` | Markdown 保存、历史恢复和发布 |
| `AGENTBEAN_CHANNEL_FILES_HISTORY_BACKFILL` | `false` | 历史附件/Markdown/preview 幂等回填 |

只允许使用 `true/false`、`on/off`、`yes/no` 或 `1/0`。配置解析失败时 Server 必须拒绝启动。

## 启用顺序

1. 先部署 schema、兼容读路径和 `PREVIEW_WORKER=true`，确认旧消息附件与旧下载 URL 可用。
2. 打开 `INDEX_SHADOW_COMPARE=true`，观察比较次数、缺失、意外和变更计数；差异未归零前不启用迁移。
3. 打开 `STREAMING=true`，验证完整下载、首段/中段/尾段 Range 和越界 416；Server RSS 不应随文件大小线性增长。
4. 以单个 Team 灰度 `BROWSER=true`，验收根目录、运行产物、Task/Run/source root、嵌套目录、面包屑、刷新和浏览器前进/后退。
5. 验收图片、视频首帧、音频、PDF、Markdown 的预览/下载后，再按 Team 打开 `MARKDOWN_EDITING=true`。
6. 最后以小批量打开 `HISTORY_BACKFILL=true`，确认重复执行不产生重复记录，再逐步扩大批次。

## 必须通过的 smoke

- 文件目录：根目录、目录导航、搜索、分页、刷新和浏览器前进/后退。
- 媒体：图片预览/下载、视频首帧与 Range 拖动、音频播放、PDF 首页站内预览。
- Markdown：保存、第二浏览器冲突、草稿恢复、历史恢复、相对资源绑定、保存并分享。
- 安全：私密频道和其他频道返回拒绝；内部日志、preview derivative、危险 HTML、设备绝对路径和其他用户草稿不可见。
- 归档：可浏览、预览、下载和看历史；保存、恢复和发布必须拒绝。

本地 gate：

```bash
npm run test:server-next -- tests/channel-file-rollout.test.ts tests/browser-smoke-script.test.ts
npm run build:server-next
npm run build:web-next
```

真实浏览器 gate 使用 `npm run smoke:agentbean-next-browser -- --json`，保存 JSON、截图和控制台日志；生产验收还必须附上目标 URL、部署版本和关键响应状态。

## 监控与回退

持续观察：上传/下载失败率与字节量、Range 响应率、索引查询延迟、shadow 差异计数、preview backlog/时延/失败码、Markdown 冲突率、回填进度、Server RSS、Artifact 与 derivative 存储增长。

触发任一条件立即回退对应开关，不等待全量发布：权限错误或越权、Range 416 非预期增长、preview backlog 持续增长、Markdown 冲突率异常、RSS/derivative 存储持续增长、迁移重复写入。回退顺序为 `HISTORY_BACKFILL` → `MARKDOWN_EDITING` → `BROWSER`，保留兼容读路径；若是媒体问题再关闭 `STREAMING`，若是预览问题关闭 `PREVIEW_WORKER`。回退后重新跑负向权限 smoke，并记录原因和恢复条件。
