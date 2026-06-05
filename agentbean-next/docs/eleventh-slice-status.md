# 第十一切片实现状态

本文记录 AgentBean Next 第十一切片当前已经落地的 device detail shell 边界。

## 已实现

- `apps/server-next`
  - 增加 `getDevice` use case。
  - `getDevice` 会读取 device 所属 team，并拒绝非 team member。
  - `DeviceDetailDto` 返回 device projection、该 device 的 runtimes，以及对该 team 可见且绑定到该 device 的 agents。
  - `/web` socket handler 支持 `device:get`。
- `apps/web-next`
  - Web socket client 支持 `device:get` command。

## 已验证

覆盖范围：

- Team member 可以读取 device detail。
- Device detail 包含 `runtimes` 与绑定到该 device 的 visible agents。
- 非 team member 读取 device detail 会得到 `FORBIDDEN`。
- Server socket handler 与 web socket client 都使用 documented `device:get` event。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第十一切片：

- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。

后续第十二切片已补上 `device:scan` 请求路由到 daemon 的最小命令边界。
