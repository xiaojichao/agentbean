# 第十二切片实现状态

本文记录 AgentBean Next 第十二切片当前已经落地的 device scan routing 边界。

## 已实现

- `apps/server-next`
  - 增加 `requestDeviceScan` use case。
  - `requestDeviceScan` 会根据 device 所属 team 校验 `userId` membership。
  - 目标 device 不存在时返回 `NOT_FOUND`，非 member 返回 `FORBIDDEN`，非 online device 返回 `DEVICE_OFFLINE`。
  - `/web` socket handler 支持 `device:scan`。
  - `/agent` socket 成功 `device:hello` 后会按 `deviceId` 建立当前 daemon socket 映射。
  - `device:scan` 成功后只向匹配 device 的 daemon socket 发送 `device:scan-requested`。
- `apps/web-next`
  - Web socket client 支持 `scanDevice` command。

## 已验证

覆盖范围：

- Team member 可以为 online device 创建 scan request。
- 非 team member 扫描同一 device 会得到 `FORBIDDEN`。
- 不存在的 device 会得到 `NOT_FOUND`。
- Server socket handler 与 web socket client 都使用 documented `device:scan` event。
- 真实 Socket.IO 双 daemon 场景中，scan request 只投递给匹配 device 的 daemon socket。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第十二切片：

- 成员弹窗 UI shell 与组件渲染。
- Channel leave/archive/delete。

后续第十三切片已补上 Daemon-next 收到 `device:scan-requested` 后重新上报 runtime/agent snapshot 的最小协议边界。
