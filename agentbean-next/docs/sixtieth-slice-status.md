# 第六十切片：artifact composer upload

本文记录 AgentBean Next 第六十切片新增的 preview composer artifact 上传控件。

## 背景

第五十九切片已经补齐 artifact JSON/base64 HTTP upload、preview/download route 与消息内 artifact viewer，但 web-next preview 的 composer 还不能让用户选择文件并随消息发送。

本切片把上一切片的 HTTP route 接到 preview composer：

- composer 支持选择本地文件。
- 发送消息前先上传选中文件。
- `message:send` 携带上传返回的 artifact ids。
- server-next 将当前用户上传、同 team/channel 的 upload artifact 绑定到 human message。

## 已落地

- `apps/server-next/src/application/usecases.ts`
  - `SendMessageInput` 新增 `artifactIds`。
  - `sendMessage` 会验证 artifact 属于当前 team/channel、由当前用户上传且 `pathKind` 是 `upload`。
  - 验证通过后把 artifact 绑定到 human message，并在返回的 `MessageDto` 中投影 `artifacts`。
- `apps/web-next/preview/index.html`
  - composer 新增 file input。
  - 提交时把文件转为 base64，调用 `POST /api/teams/:teamId/artifacts/upload`。
  - upload 成功后把 artifact ids 传给 `message:send`。
- `apps/web-next/src/index.ts`
  - web socket client 的 `SendMessageInput` 暴露 `artifactIds`。

## 验证命令

```bash
npm run test:server-next -- --api.host 127.0.0.1 tests/first-slice.test.ts -t "sendMessage attaches"
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts -t "uploads selected composer files"
```

## 剩余边界

- HTTP upload 仍是 JSON/base64 第一版，尚未实现 multipart form upload。
- 后续第六十一切片已补上真实浏览器 artifact upload/preview/download smoke。
- 后续第六十二切片已补上 workspace run detail UI，第六十四切片已补上消息内 artifact grouping；workspace tree 仍需后续 UI/API 切片。
