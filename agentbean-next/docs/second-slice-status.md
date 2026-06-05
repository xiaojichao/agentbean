# 第二切片实现状态

本文记录 AgentBean Next 第二切片当前已经落地的 channel controls 边界。

## 已实现

- `packages/contracts`
  - 增加 `CreateChannelCommandDto` 与 `UpdateChannelCommandDto`。
  - 继续复用 `channel:create` 与 `channel:update` socket event constants。
- `packages/domain`
  - Private channel 创建时自动把 creator 加入 human members，保证创建者可见。
  - 非默认频道的设置更新只允许 creator 执行。
  - 默认 `all` 频道只允许 creator 更新 `title`，不允许 rename、visibility 或 member list 更新。
- `apps/server-next`
  - `createChannel` 与 `updateChannel` use cases。
  - In-memory 与 SQLite `ChannelRepository.update`。
  - SQLite 使用现有 `channels.description` 列保存 `ChannelDto.title`。
  - `/web` socket handler 绑定 `channel:create` 与 `channel:update`。
- `apps/web-next`
  - Web socket client 暴露 `createChannel` 与 `updateChannel`。

## 已验证

覆盖范围：

- Domain creator/private-channel/#all 权限规则。
- Server use cases 的 private channel creator visibility、creator-only management 与 `all` title-only 管理。
- SQLite channel create/update persistence。
- Web socket client 与 server socket handlers 的 `channel:create` / `channel:update` 协议路径。

本地命令：

```bash
npm run test:phase1
npm run build:packages
```

## 暂未实现

这些不属于第二切片：

- 成员弹窗 UI shell 与组件渲染；第七切片已补齐 human/agent member 详情 DTO。
- Channel archive/delete/leave。
- DM thread 创建与 agent DM。
- 浏览器 UI shell 与组件渲染。
