# 资产盘点

本文档区分可复用的项目资产，以及应被替换的实现形态。

## 作为产品来源保留

这些文件捕获了产品意图，应成为重写规格的来源材料：

- `README.md`
- `docs/superpowers/specs/2026-05-09-agentbean-prd.md`
- `docs/superpowers/specs/2026-05-09-agentbean-architecture-design.md`
- `docs/superpowers/specs/2026-06-01-agentbean-current-behavior-baseline-spec.md`
- `docs/superpowers/plans/2026-05-09-agentbean-implementation-roadmap.md`

最重要、必须保留的产品不变量：

- AgentBean 是一个 local-first 的团队协作平台，服务于人类、本地 agent、远端设备 agent，以及由 AgentOS 托管的 agent。
- 一个团队或 team 拥有 channels、DMs、threads、tasks、files、members、devices 和 agent visibility。
- 系统包含三个进程：Web、Server 和 Daemon。
- Web 通过 Socket.IO 与 artifact HTTP routes 和 Server 通信。
- Daemon 通过 Socket.IO 与 Server 通信，并执行本地工具或桥接到 AgentOS gateways。
- 第一版重写仍可接受 SQLite：一个全局数据库，加上 team 作用域的存储。

## 作为行为资产保留

这些区域包含有用的行为与边界情况知识：

- `apps/server/src/routing.ts`
  - 小而隔离的消息路由规则，覆盖 mention、human mention、fallback 和 no-online 状态。
- `apps/server/src/auth.ts`、`apps/server/src/password.ts`、`apps/server/src/invite.ts`
  - 有用的认证与邀请机制，但应移到 application services 后面。
- `apps/server/src/channels.ts`
  - 频道成员关系与私有频道行为，可复用为 domain/use-case 需求。
- `apps/server/src/artifact-routes.ts`、`apps/server/src/storage.ts`
  - 应保留 artifact 与 per-team storage 行为，但 repository 边界需要更干净。
- `apps/server/src/registry.ts`、`apps/server/src/heartbeat-scanner.ts`
  - Runtime 状态、heartbeat、reconnect 与 offline 行为很有价值，但应从 transport code 中拆开。
- `apps/daemon/src/scanner.ts`
  - Runtime detection 与 AgentOS/local-agent scanning 具有很高的迁移价值。
- `apps/daemon/src/adapters/*`
  - Adapter 行为应迁移到稳定的 execution interface 后面。
- `apps/daemon/src/device-daemon.ts`
  - Device lifecycle、scan cache、periodic rescan 与 dispatch 行为很重要，但该文件应被拆解。
- `apps/web/app/[teamPath]/*`
  - Information architecture 与功能覆盖面有参考价值。
- `apps/web/tests/*`、`apps/server/tests/*`、`apps/daemon/tests/*`
  - 现有测试并不完整，但可以作为很好的回归测试种子。

## 重写而不是移植

这些文件是有用参考，但不应复制为目标形态：

- `apps/server/src/index.ts`
  - 职责过多：app boot、auth、Socket.IO handlers、team management、devices、tasks、messages、artifacts 和 dispatch。
- `apps/server/src/db.ts`
  - Schema、migration、row mapping、repository behavior 和 types 耦合过紧。
- `apps/server/src/namespaces/agent.ts`
  - 行为有价值，但 transport handling、persistence、registry updates、device state 与 dispatch coordination 交织在一起。
- `apps/web/lib/socket.ts`
  - 作为单个 client module 过宽，应改成按 feature 分区的 protocol clients。
- `apps/web/lib/store.ts`
  - 包含偏 domain 的 agent dedupe 与 selection logic，并且重复了 server/daemon 规则。
- `apps/web/app/[teamPath]/tasks/page.tsx`
  - Page、local UI state、socket calls、filters、thread UI、upload behavior 与 rendering 混在一起。
- `apps/web/app/[teamPath]/chat/page.tsx`
  - 同样的问题：feature behavior 与 presentation 应在迁移前拆开。

## 需要显式保留的风险

重写版应把这些视为显式需求，而不是偶然实现细节：

- Agent identity 并不简单。Scanned agents、self-registered agents、custom agents、device IDs、runtime paths 与 AgentOS gateway agents 必须稳定去重。
- Team membership 与 agent publishing 是两个不同概念。
- DM 与 private channel visibility 必须在 server-side 强制执行，不能只在 UI 中隐藏。
- Dispatch history 不得重复当前用户 prompt。
- Daemon reconnect 与 periodic scan behavior 是正确性的一部分，不只是可观测性。
- Artifact upload 必须把生成文件连接到 messages、channels、agents 与 workspace runs。
- Device invite flow 必须保留 browser-authenticated users 与等待 token delivery 的 daemon sockets 之间的区别。

## 建议的抽取规则

- 先抽取行为，而不是文件。
- 每个迁移行为都需要在旧代码被替换前拥有一个 acceptance test。
- 共享 normalization rules 应放在一个共享 domain module 中，或从单一 protocol schema 生成。
- Socket event payloads 应在边界处类型化，再转换成 domain commands。
- Repositories 应暴露面向 use case 的方法，而不是 raw table-shaped APIs。
