# 第六十二切片：workspace run detail UI

本文记录 AgentBean Next 第六十二切片补齐 preview 消息内 workspace run 详情展示。

## 背景

第五十九到第六十一切片已经让 artifact metadata、HTTP viewer、composer upload 与真实浏览器 artifact smoke 进入主线，但 preview 消息里仍只显示 `Workspace run id/status`。这让用户能看到有一次 workspace run，却看不到它来自哪个 device、在哪个 cwd 执行、退出码、耗时和产物数量。

本切片不新增 API，不改变权限边界，只消费 `MessageDto.workspaceRun` 已有 server-side projection。

## 已落地

- `apps/web-next/preview/index.html`
  - message artifact 区域新增 workspace run detail 渲染。
  - 显示 cwd、device id、exit code、duration 与 artifact count。
  - 保持原有 artifact preview/download links 与 session token 生成逻辑。
- `apps/web-next/tests/preview-page.test.ts`
  - 扩展 message artifacts DOM harness，覆盖 workspace run cwd、device、exit、duration 与 artifact count。

## 验证命令

```bash
npm run test:web-next -- --api.host 127.0.0.1 tests/preview-page.test.ts -t "renders message artifacts"
```

## 剩余边界

- Workspace run 仍是消息内联 detail 第一版，尚未提供独立 run detail 页面或 workspace tree。
- Artifact grouping 仍未按 workspace run/dispatch 做更完整的信息架构。
- Tasks、search、saved messages/reactions、admin/metrics 仍属于后续产品 parity。
