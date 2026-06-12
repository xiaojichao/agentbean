# 第六十三切片：artifact multipart upload

本文记录 AgentBean Next 第六十三切片补齐 artifact multipart upload，并让 preview composer 使用真实 `FormData` 上传。

## 背景

第五十九到第六十二切片已经补齐 artifact HTTP route、viewer、composer upload、browser smoke 与 workspace run detail UI。但 upload route 的产品路径仍是 JSON/base64 第一版：web composer 需要先把 `File` 转成 base64，再 POST JSON。

本切片把 upload route 扩展为兼容型入口：

- 保留 JSON/base64 upload，避免破坏已有脚本和测试。
- 新增 multipart form-data upload，用 `token`、`channelId` 与 `file` 字段上传。
- preview composer 直接发送 `FormData`，由浏览器生成 multipart boundary。

## 已落地

- `apps/server-next/src/dev-server.ts`
  - `POST /api/teams/:teamId/artifacts/upload` 支持 `multipart/form-data`。
  - multipart path 复用 `uploadArtifact` use case、team membership、channel visibility 与 dataDir 存储边界。
  - JSON/base64 path 仍保留为兼容入口。
- `apps/web-next/preview/index.html`
  - composer file upload 改为 `FormData`，不再在前端手动 base64 编码文件。
- `apps/server-next/tests/dev-server.test.ts`
  - 覆盖 multipart upload、preview readback 与 MIME type。
- `apps/web-next/tests/preview-page.test.ts`
  - 覆盖 composer fetch body 是 `FormData`，且包含 token、channelId 与 file。

## 验证命令

```bash
npm run test:server-next -- --api.host 127.0.0.1 tests/dev-server.test.ts -t "multipart artifact"
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts -t "uploads selected composer files"
npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 45000 --json
```

真实浏览器 smoke 输出 `16/16` 通过，其中 artifact 三项均通过：

- `browser-artifact-upload-visible`
- `browser-artifact-preview-readable`
- `browser-artifact-download-readable`

## 剩余边界

- Multipart parser 是 server-next dev/preview route 的最小实现，不提供 streaming 大文件上传。
- Workspace tree、独立 run detail 页面与 artifact grouping 仍需后续 UI/API 切片。
- Tasks、search、saved messages/reactions、admin/metrics 仍属于后续产品 parity。
