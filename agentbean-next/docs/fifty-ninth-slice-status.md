# 第五十九切片：artifact HTTP route 与 preview viewer

本文记录 AgentBean Next 第五十九切片新增的 artifact HTTP upload/download/preview route 与 web-next preview artifact viewer。

## 背景

post-flip follow-up 收敛后，artifacts/workspace runs 已经有 server-next metadata、authorization 与 message projection，但还缺真正 HTTP 文件入口与用户可见的 artifact 展示。

本切片补齐第一版：

- HTTP JSON upload route。
- HTTP preview/download route。
- web-next preview 消息中的 artifact/workspace run 展示。

## 已落地

- `apps/server-next/src/application/usecases.ts`
  - 新增 `uploadArtifact`，复用 team membership 与 channel visibility 授权。
  - 新增 `getArtifactFile`，在 `getArtifact` 的授权基础上向 HTTP 层返回内部 `storagePath`。
- `apps/server-next/src/dev-server.ts`
  - 新增 `POST /api/teams/:teamId/artifacts/upload`。
  - 新增 `GET /api/teams/:teamId/artifacts/:artifactId/preview`。
  - 新增 `GET /api/teams/:teamId/artifacts/:artifactId/download`。
  - route 支持 bearer、query 或 JSON body token；通过 `auth:whoami` session token 解析用户。
  - 文件写入 `AGENTBEAN_NEXT_DATA_DIR` 下的 `artifacts/` 子目录，metadata 存在 SQLite repository。
- `apps/web-next/preview/index.html`
  - 消息中展示 `MessageDto.artifacts`。
  - 展示 `MessageDto.workspaceRun` 的 run id/status。
  - 为 artifact 生成 preview/download links，并附带当前 session token。

## 验证命令

```bash
npm run test:server-next -- --api.host 127.0.0.1 tests/dev-server.test.ts tests/sqlite-repositories.test.ts
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts
npm run build:server-next
npm run build:web-next
```

## 剩余边界

- 本切片的 upload route 使用 JSON/base64 第一版，尚未实现 multipart form upload。
- web-next preview 在本切片中只展示消息中已有 artifacts；后续第六十切片已补上 composer 上传控件。
- 后续第六十二切片已补上 workspace run detail UI，第六十四切片已补上消息内 artifact grouping；真实 workspace tree 仍需后续 UI 切片。
- HTTP route 当前挂在 server-next dev/production entry；旧 AgentBean 的 Next.js App Router 产品页面仍未迁入。
