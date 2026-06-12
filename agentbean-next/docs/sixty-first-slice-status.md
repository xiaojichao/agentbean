# 第六十一切片：artifact browser smoke

本文记录 AgentBean Next 第六十一切片把 artifact composer upload、preview 与 download 纳入真实浏览器 smoke。

## 背景

第五十九切片补齐 artifact HTTP route 与 viewer，第六十切片补齐 composer 上传控件。此前这些能力已有 usecase、HTTP 与 DOM harness 覆盖，但 `npm run smoke:agentbean-next-browser` 仍只覆盖登录、session restore、custom agent 创建、message dispatch 与 agent reply。

本切片把 artifact 产品面接入真实 Chrome smoke：

- 在浏览器中给 composer file input 注入 markdown 文件。
- 通过 preview composer 发送 artifact-backed human message。
- 等待消息区显示 artifact 文件名。
- 在浏览器里 fetch 渲染出来的 preview/download 链接，并校验响应 bytes。

## 已落地

- `scripts/smoke-agentbean-next-browser.mjs`
  - 新增 `exerciseArtifactBrowserSmoke`，执行 artifact upload、viewer、preview/download fetch 验证。
  - Chrome DevTools page wrapper 新增 `setFileInputFiles`，使用 `DOM.setFileInputFiles` 驱动真实 file input。
  - 主 browser smoke 新增三条检查：
    - `browser-artifact-upload-visible`
    - `browser-artifact-preview-readable`
    - `browser-artifact-download-readable`
- `apps/server-next/tests/browser-smoke-script.test.ts`
  - 用 fake CDP page 覆盖 artifact smoke helper 的操作顺序和返回结果。

## 验证命令

```bash
npm run test:server-next -- --api.host 127.0.0.1 tests/browser-smoke-script.test.ts
npm run build:server-next
node --check scripts/smoke-agentbean-next-browser.mjs
npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 45000 --json
```

## 真实浏览器证据

本地 smoke 输出 `16/16` 通过，其中 artifact 新增三项均通过：

- `browser-artifact-upload-visible`
- `browser-artifact-preview-readable`
- `browser-artifact-download-readable`

最终截图显示消息区已渲染 `browser-smoke-artifact.md`，并展示 `预览` / `下载` 链接。

## 剩余边界

- HTTP upload 仍是 JSON/base64 第一版，尚未实现 multipart form upload。
- Workspace run detail UI、artifact grouping 与 workspace tree 仍需后续 UI/API 切片。
- Tasks、search、saved messages/reactions、admin/metrics 仍属于后续产品 parity。
