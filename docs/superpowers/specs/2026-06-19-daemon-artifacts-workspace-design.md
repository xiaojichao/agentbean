# daemon-next 附件支持与产物归档迁移设计

- 日期：2026-06-19
- 范围：`apps/daemon-next`（+ 极少量 `packages/contracts` 复用）
- 目标组件：daemon-next custom agent 命令执行链路
- 关联文档：`agentbean-next/docs/feature-disposition.md`、`agentbean-next/docs/known-gaps.md`、`agentbean-next/docs/post-flip-gap-audit.md`

## 1. 背景与目标

AgentBean 从原版（`apps/daemon` v0.1.35）迁移到重写版（`apps/daemon-next` v0.2.x）时，daemon 从「全能工作空间管理器」收敛为「轻量通用命令执行器」。原版具备但 daemon-next 缺失的两项能力是：

1. **附件支持（输入）**：dispatch 带附件时，daemon 从 server 下载附件并交给 agent 使用。
2. **产物归档（输出）**：agent 执行后产生的文件（图片、文档、数据等），daemon 扫描、去重、上传回 server 并关联到消息。

代码级核对发现，server-next 侧的 artifact 协议、HTTP route、`WorkspaceRunDto.artifactIds[]`、`DispatchRequestDto.attachments[]` 均已就绪——这是一项「server 侧已搭好、等 daemon 接线」的功能。本设计在 daemon-next 侧补全附件下载与产物归档，**server-next 零改动**。

### 成功标准

- dispatch 携带附件时，daemon-next 下载附件到 per-run `inputs/`，命令可通过 `AGENTBEAN_INPUT_DIR` 环境变量访问。
- custom agent 命令执行后，daemon-next 扫描本次 dispatch 产生的产物文件，逐个上传到 server，产物在聊天中可见、可预览/下载。
- 同一 agent 的并发 dispatch 产物互不污染（per-run 目录隔离）。
- 每次 run 的状态与产物清单持久化到本地 `manifest.json`，回复文本持久化到 `response.md`，可在本地追溯。
- 产物上传通道支持单文件最大 10MB（图片/PDF/zip 等）。

## 2. 迁移基线

### 2.1 原版 daemon 机制（参考）

- **附件下载**（`apps/daemon/src/agent-instance.ts:42-67`）：从 `{serverUrl}{downloadUrl}?token={token}` 下载，写入 `{run.inputDir}/{attachmentId}-{safeFilename}`。
- **附件注入**（`agent-instance.ts:69-75`）：把附件清单（filename/mimeType/size/localPath）追加到 prompt。
- **产物扫描**（`apps/daemon/src/post-process.ts`）：三策略并集——Codex 原生目录（`~/.codex/generated_images`）、回复文本中的路径正则、`outputDirs`/`AGENT_BEAN_OUTPUT_DIRS` 目录扫描（`mtime > dispatchStart` 过滤）。
- **去重归档**（`apps/daemon/src/workspace-manager.ts:144-190`）：SHA256 聚合，文件名优先级（`ig_*.png` > `image*.png` > 其他），归档到 `run.outputDir`。
- **上传**（`apps/daemon/src/uploader.ts:11-60`）：`POST /api/networks/{networkId}/artifacts/upload`，multipart `file` + `channelId` + `uploaderId` + `metaJson`，返回 `{id, filename, downloadUrl}`。
- **目录结构**（`workspace-manager.ts:87-129`）：`~/.agentbean/teams/{teamId}/agents/{agentId}/runs/{runId}/{inputs,outputs,intermediates,logs}` + `manifest.json` + `response.md`。
- **env 注入**（`workspace-manager.ts:131-142`）：`AGENTBEAN_TEAM_ID/AGENT_ID/RUN_ID/WORKSPACE/INPUT_DIR/OUTPUT_DIR/INTERMEDIATE_DIR`。

### 2.2 daemon-next 现状

- `apps/daemon-next/src/executor.ts:154-175`：当前只把 stdout/stderr 打成**单个** `workspace-run.log` artifact，inline `contentBase64` 随 `dispatch:result` 上报。
- `apps/daemon-next/src/index.ts:77-89`：`DispatchRequestPayload` **未声明** `attachments` 字段，附件被丢弃；无下载逻辑。
- `executor.ts:20-38`：`SAFE_ENV_KEYS` 白名单 + `buildChildEnv()`，安全边界已就绪。
- `executor.ts:87-107`：SIGTERM→宽限期→SIGKILL 取消链路已就绪。
- `index.ts:114-116`：已有 `device.token`，可用于 HTTP 认证。
- custom agent 命令在 `customAgent.cwd` 执行（用户配置工作目录，所有 run 共用）。

### 2.3 server-next 现状（无需改动，已验证）

- `apps/server-next/src/dev-server.ts:374-407`：`POST /api/teams/:teamId/artifacts/upload`，支持 multipart 与 JSON/base64，认证用 Bearer 或 query `token`，上限 `MAX_ARTIFACT_UPLOAD_BODY_BYTES = 10MB`（`dev-server.ts:55`）。
- `apps/server-next/src/dev-server.ts:409-452`：`GET /api/teams/:teamId/artifacts/:artifactId/download` 与 `.../preview`，Bearer/query token 认证。
- `apps/server-next/src/application/usecases.ts:2380-2450`：`dispatch:result` 的 `artifacts[]` 处理——`contentBase64` **非必填**（`usecases.ts:543`）；只传 `{id, filename}` 时 server 创建引用型 artifact 并自动关联 message/dispatch/workspaceRun。
- `usecases.ts:2420`：`workspaceRun.artifactIds` 从 `reportedArtifactIds` 自动填充。
- `packages/contracts/src/dispatch.ts:15-20, 37-49`：`DispatchAttachmentDto`（`id/name/mimeType?/sizeBytes?`）与 `DispatchRequestDto.attachments?` 已定义；`getDispatchRequest` 已附带附件。
- `packages/contracts/src/artifact.ts:24-42`：`WorkspaceRunDto.artifactIds: ID[]` 已支持多产物。
- inline 内容上限 `DISPATCH_INLINE_ARTIFACT_CONTENT_MAX_BYTES = 2MB+1KB`（`usecases.ts:3147`）。

## 3. 设计决策

| 决策 | 选定 | 理由 |
|------|------|------|
| 目标场景 | 通用命令场景 | daemon-next 是「任意 shell 命令」模型，不依赖 LLM adapter 特定输出目录，贴合瘦身定位 |
| 迁移范围 | 生产级 | 最小闭环 + per-run 隔离 + 本地持久化 + SHA256 去重 |
| 产物上传通道 | HTTP upload + id 引用（方案 B） | server 零改动（已验证）、支持 10MB 大产物、对齐原版 multipart、统一单条上传路径 |
| 附件下载通道 | server `GET .../artifacts/:id/download` | route 已就绪，Bearer token 认证 |
| per-run 目录位置 | `customAgent.cwd/.agentbean/runs/{runId}/` | 命令保留项目 cwd 上下文，产物就近；附 `.gitignore` 建议 |
| 附件注入方式 | env `AGENTBEAN_INPUT_DIR` 为主 + prompt 清单为辅 | 通用命令不读 prompt，env 约定为主；prompt 兼容会读 prompt 的命令 |
| 产物兜底扫描 | 开启（outputs 目录 + cwd 内 mtime 过滤） | 捕获未遵守约定的命令；有扩展名/忽略目录/mtime 过滤 |

## 4. 架构与组件

在 `apps/daemon-next/src/` 新增 4 个职责单一模块，接入现有 `index.ts` 与 `executor.ts`：

| 模块 | 职责 | 主要依赖 |
|------|------|----------|
| `attachments.ts` | 从 server HTTP download 附件到 per-run `inputs/`，`safeFilename` 处理 | `fetch`、`device.token`、fs |
| `workspace-run.ts` | 创建/管理 per-run 目录树、注入 `AGENTBEAN_*` env、写 `manifest.json`/`response.md` | fs |
| `artifact-collector.ts` | 扫描产物（mtime 过滤 + 扩展名白名单 + 忽略目录 + SHA256 去重） | fs、crypto |
| `artifact-uploader.ts` | HTTP multipart upload 产物到 server，返回 artifact id，含失败重试 | `fetch`、FormData |

接入点：
- `index.ts` dispatch:request handler：调 `workspace-run`（建目录）+ `attachments`（下载附件）+ 注入 env/prompt。
- `executor.ts` `runCustomAgentCommand`：命令结束后调 `artifact-collector` + `artifact-uploader`，组装 `artifacts[]`（id 引用）。

设计原则：4 个模块互不依赖内部实现，可独立单测；`artifact-collector` 不关心上传，`artifact-uploader` 不关心扫描，避免 `executor.ts` 继续膨胀。

## 5. per-run 工作目录模型

每次 dispatch 在 `customAgent.cwd` 下建立隔离目录：

```
{customAgent.cwd}/.agentbean/runs/{runId}/
  ├─ inputs/          ← 附件下载到这里
  ├─ outputs/         ← 引导命令把产物写这里
  ├─ logs/            ← workspace-run.log
  ├─ manifest.json    ← run 状态 + 产物清单
  └─ response.md      ← 最终回复文本
```

- `runId = dispatch.requestId`。
- 命令仍在 `customAgent.cwd` 执行（保留项目上下文），通过 env 引导使用 per-run 子目录。
- 注入 env：`AGENTBEAN_RUN_ID`、`AGENTBEAN_INPUT_DIR`、`AGENTBEAN_OUTPUT_DIR`、`AGENTBEAN_WORKSPACE`（= `{cwd}/.agentbean/runs/{runId}`）。需加入 `executor.ts` 的 `SAFE_ENV_KEYS` 白名单。
- 并发安全：不同 `runId` 子目录互不干扰。
- 项目目录清洁：附 `.gitignore` 模板建议忽略 `.agentbean/`（文档说明，不强制写入用户 `.gitignore`）。

## 6. 端到端数据流

```
dispatch:request（含 attachments[]）
  │
  ├─[workspace-run]     建 .agentbean/runs/{runId}/{inputs,outputs,logs}
  ├─[attachments]       HTTP download 附件 → inputs/{id}-{safeFilename}
  ├─[prompt/env]        追加附件清单到 prompt；注入 AGENTBEAN_INPUT_DIR/OUTPUT_DIR
  │
  ├─[executor]          spawn customAgent.command（cwd=customAgent.cwd, env 含 AGENTBEAN_*）
  │                       ├─ stdout/stderr 捕获（已有）
  │                       └─ SIGTERM→SIGKILL 取消（已有）
  │
  ├─[artifact-collector] 扫描 outputs/ + cwd 内 mtime>startedAt 的匹配文件
  │                       └─ SHA256 去重 → 候选产物列表
  ├─[artifact-uploader]  逐个 HTTP upload → artifact id 列表
  │
  ├─[workspace-run]     写 manifest.json + response.md
  └─[dispatch:result]   用户产物 artifacts:[{id,filename,...}]（id 引用，无 content）+ workspaceRun + log artifact（保留 inline contentBase64）
                          └─ server 自动关联 message/dispatch/workspaceRun.artifactIds
```

## 7. 附件注入约定

- **主**：env `AGENTBEAN_INPUT_DIR` 指向 `inputs/` 目录，用户在 `customAgent.command` 中引用（约定，文档说明）。
- **辅**：把附件清单（filename、mimeType、size、本地路径）追加到 prompt，兼容会读 prompt 的命令。
- 文件命名：`{attachmentId}-{safeFilename}`，`safeFilename` = `basename(filename).replace(/[^a-zA-Z0-9._-]/g,'-').replace(/^-+|-+$/g,'')`（与原版一致）。
- 下载 URL：`{serverUrl}/api/teams/{teamId}/artifacts/{attachment.id}/download`，Header `Authorization: Bearer {device.token}`。`serverUrl` 复用 daemon 现有 server 连接地址。

## 8. 产物扫描规则

扫描源（并集，仅取本次 dispatch 产生）：
1. `outputs/` 目录下所有匹配扩展名的文件。
2. `customAgent.cwd` 内 `mtime > startedAt` 的匹配文件（兜底）。`startedAt` 取命令执行开始时间戳（executor 已记录该值）。

过滤规则（硬编码常量，生产级不含可配置项）：
- 扩展名白名单：`png|jpg|jpeg|gif|webp|svg|pdf|txt|csv|json|md|mp4|mov|zip`（与原版一致）。
- 忽略目录：`.git`、`.agentbean`、`node_modules`、`.next`、`.nuxt`、`.turbo`、`.cache`、`vendor` 等。
- 单根目录文件数上限：2000（防爆）。
- SHA256 去重：同内容只保留一个，文件名更「语义化」者优先（沿用原版 `fileNamePreference` 规则）。

扫描结果为候选产物列表（`{absolutePath, relativePath, sha256, sizeBytes, filename}`）。

## 9. 错误处理与边界

| 场景 | 处理 |
|------|------|
| 附件下载失败 | 记日志，继续执行（命令可能不需要附件），不阻断 |
| 产物 HTTP upload 失败 | 重试 2 次（最多 3 次尝试），仍失败则跳过该产物 + 记日志，不阻断 |
| 单产物 > 10MB | 跳过 + 记日志 |
| 产物数/总量超限 | 上限保护，超出跳过 |
| 扫描无产物 | 正常，`dispatch:result` 只带 log artifact（现状行为） |
| dispatch 被取消 | executor 已有取消链路；已扫描产物仍尝试上传 |

**核心原则**：附件与产物是增强能力，任何环节失败都不阻断 `dispatch:result` 主回复与 log artifact 上报。

## 10. 测试策略

- **单元**：
  - `safeFilename` 边界（特殊字符、空名、路径穿越）。
  - 扫描过滤（mtime 阈值、扩展名白名单/黑名单、忽略目录递归）。
  - SHA256 去重（同内容不同名、不同内容同名）。
  - env 注入正确性、`SAFE_ENV_KEYS` 白名单更新。
  - `manifest.json` 序列化/反序列化。
  - upload 重试逻辑（失败 N 次后放弃）。
- **集成**：mock server HTTP（download/upload），端到端 dispatch → 下载附件 → 执行 → 扫描 → upload → `dispatch:result`，验证 artifactIds 关联。
- **契约**（`packages/contracts`）：daemon-next `DispatchRequestPayload` 增加 `attachments?` 字段后的契约测试。
- **边界**：无附件、无产物、大产物（>10MB）、并发 run（同 agent 两个 dispatch）、upload 失败、dispatch 取消。

## 11. 改动文件清单

| 文件 | 改动 |
|------|------|
| `apps/daemon-next/src/attachments.ts` | 🆕 新增：附件下载 |
| `apps/daemon-next/src/workspace-run.ts` | 🆕 新增：per-run 目录、env 注入、manifest/response 持久化 |
| `apps/daemon-next/src/artifact-collector.ts` | 🆕 新增：产物扫描 + 去重 |
| `apps/daemon-next/src/artifact-uploader.ts` | 🆕 新增：HTTP multipart upload + 重试 |
| `apps/daemon-next/src/index.ts` | 改：dispatch handler 接附件下载 + 目录准备；`DispatchRequestPayload` 加 `attachments?` |
| `apps/daemon-next/src/executor.ts` | 改：注入 `AGENTBEAN_*` env（更新 `SAFE_ENV_KEYS`）；执行后接 collector + uploader；`artifacts[]` 改 id 引用 |
| `apps/daemon-next/tests/` | 🆕 新增对应单元/集成测试 |
| `packages/contracts/` | 复用已有 `DispatchAttachmentDto`（已存在，预计无需新增） |
| `apps/server-next/` | **零改动** |

## 12. 非目标（out of scope）

以下属于「完整复刻」范围，本次不做（可在后续切片评估）：

- 可配置扫描路径/忽略规则/大小上限/上传开关（`config.ts` 式配置）。
- `AGENT_BEAN_OUTPUT_DIRS` 等额外可配置 env 引导。
- Codex 原生目录（`~/.codex/generated_images`）等 adapter 特定扫描。
- 回复文本中的文件路径正则提取。
- intermediates 中间目录区分上传。
- macOS sandbox-exec 沙箱。
- 本地 scan 缓存、定时重扫、应用层心跳。

## 13. 风险与待验证

- **env 注入与 `SAFE_ENV_KEYS`**：新增 `AGENTBEAN_*` env 需加入白名单，确认不破坏现有安全边界（`executor.ts:20-38`）。
- **serverUrl 来源**：确认 daemon-next 现有 server 连接配置可复用为 HTTP base URL（用于 download/upload route）。若连接用的是 socket 地址，需确认 HTTP 同源。
- **大产物上传耗时**：多个大产物串行 upload 可能拉长 dispatch:result 延迟；若成问题，后续可考虑并行 upload（本次先串行，简单可靠）。
- **cwd 兜底扫描噪声**：兜底扫描可能拾取项目内 dispatch 期间新增的无关文件（如 build 产物）；已用扩展名 + 忽略目录 + mtime 过滤缓解，实际噪声需在集成测试与 dogfood 中观察。
- **per-run 目录堆积**：runs 目录不自动清理，长期会占磁盘；本次不做自动清理（属运维项），文档提示可手动清理或后续加 TTL。
