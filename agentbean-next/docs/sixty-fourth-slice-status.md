# 第六十四切片：message artifact grouping

本文记录 AgentBean Next 第六十四切片在 preview 消息内按来源分组展示 artifacts。

## 背景

Artifact metadata、HTTP viewer、composer upload、browser smoke、workspace run detail 与 multipart upload 已经落地，但消息里的 artifact 列表仍是平铺的。对于同时包含 agent workspace output 与用户上传附件的消息，用户无法快速区分哪些文件来自 workspace run，哪些只是消息附件。

本切片不新增 API，不改变 server 授权边界，只消费 `ArtifactDto.workspaceRunId`、`ArtifactDto.pathKind` 与 `WorkspaceRunDto.artifactIds`。

## 已落地

- `apps/web-next/preview/index.html`
  - message artifact 区域新增分组渲染。
  - workspace output 归入 `Workspace 输出`。
  - 其余 upload/generated artifacts 归入 `消息附件`。
- `apps/web-next/tests/preview-page.test.ts`
  - 扩展 message artifacts DOM harness，覆盖同一条消息内 workspace output 与 message attachment 的分组展示。

## 验证命令

```bash
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts -t "renders message artifacts"
npm run smoke:agentbean-next-browser -- --skip-build --timeout-ms 45000 --json
```

真实浏览器 smoke 输出 `16/16` 通过，artifact upload、preview bytes、download bytes 与 console clean 均通过。

## 剩余边界

- 后续第六十五切片已补上 message inline workspace artifact tree；独立 run detail 页面仍需后续 UI/API 切片。
- 分组仍是 message inline 第一版，尚未提供跨 run/dispatch 的 artifact browser。
- Tasks、search、saved messages/reactions、admin/metrics 仍属于后续产品 parity。
