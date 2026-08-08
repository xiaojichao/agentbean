# PRD:修通 DM 频道文件包卡片端到端链路

## 背景

用户在生产 DM 频道（`direct`，@Hermes-agent-xiao-mbp）触发 Agent 执行。Agent 成功执行，生成的文件同步到设备 `.agentbean` 目录，但聊天界面**无文件包卡片、无「Agent 交付 N 个文件」琥珀药丸**，UI 整体不符原型图（`docs/superpowers/prototypes/2026-07-28-chat-task-file-package-flow-prototype.html`）。

**产品决策（2026-08-07）**：DM（私聊）频道也要支持文件包卡片——私聊 agent 产出文件应可见、可引用。这是新需求（原型图原本是项目频道场景，代码当前把 DM 设计性排除）。

## 根因（双重断点，缺一不可）

诊断经代码证据（Explore 全链路）+ 本机 daemon 日志实证（trellis-research）+ 用户界面判别（无药丸）三层确认：

### 断点 A：DM 频道 publish 链设计性硬拒（当前症状直接因）

```
DM (kind='direct')
  → server 三处硬拒 NOT_FOUND (usecases.ts:17340 / 17361 / 17386: channel.kind==='direct')
  → daemon fetchProjectChannelWorkspaceCurrent 拿 {ok:false}
  → baselineRevisionId 一直 undefined（frozen 也是空）
  → index.ts:1171 双门 (serverUrl && baselineRevisionId) false → staging 整段静默跳过（无报错）
  → server 从未收到 commit → formPackage 未调用 → 无 system 消息 → 无药丸无卡片
```

文件走独立的 legacy artifact upload 端点（`artifact-uploader.ts:87`），与 workspace staging publish 互不相干——解释「文件同步到设备」但「无卡片」。

### 断点 B：web 渲染结构断点（确定性，全频道受影响）

- server 只把 output-package meta 挂 **system 消息**（`output-package-handler.ts:464-489`，`senderKind:'system'`）
- `ChatBubble` 对 system 消息**早返回**（`chat/page.tsx:4749-4802`），只渲染 `{msg.body}` 琥珀药丸；卡片分支（`:5063-5074`）在早返回后的非 system 分支 → **结构性不可达**
- `channel-message.tsx:64-93` 同样断裂
- 现有测试 `output-package-card-entry.test.tsx` 只单测组件，没经 ChatBubble 集成测 → CI 全绿却漏

**关键**：即使断点 A 修通、药丸出现，断点 B 仍让卡片不显示。两个必须都修。

## 验收标准

- **AC1［断点 B·web］**：`chat/page.tsx` + `channel-message.tsx` 的 system 消息分支，携带 `output-package` meta 时渲染 `<OutputPackageCard/>`（接线 `channelId` + `onAddReference`/`onOpenTask`/`onReviseVersion`/`onContinueWithAgent` 回调）而非琥珀药丸。补**经 ChatBubble 的集成测试**（覆盖 system 消息 → 卡片路径，堵住 CI 盲点）。
- **AC2［断点 A·server］**：DM 频道解除 workspace 硬拒，DM 拥有有效的 Project Channel Workspace（预创建或首次 publish 懒创建——具体方案见 design）→ `fetchProjectChannelWorkspaceCurrent` 对 DM 返回有效 baseline。
- **AC3［断点 A·daemon］**：daemon baseline 对 DM 频道拉取成功 → `index.ts:1171` staging 分支进入 → commit 到达 server。
- **AC4［端到端］**：DM 频道 Agent 执行后，讨论串出现文件包卡片（文件列表 + 状态 chip + 操作按钮），server 形成 OutputPackage 记录（`output_packages` 表 + `agent_publications`）。
- **AC5［UI 对齐］**：卡片形态对齐原型图 `package-card`（标题/meta/文件行 F1..Fn/操作按钮）。范围评估：若原型图三屏联动（任务看板/文件版本表/预览浮窗）工作量过大，本 task 只交付讨论串卡片，其余拆 follow-up。
- **AC6［无回归］**：普通项目频道卡片功能不受影响；现有测试全绿；补 DM 端到端集成测试。

## 范围

- **In**：断点 A（DM workspace 接入：server 解硬拒 + workspace 创建 + daemon baseline）+ 断点 B（web 渲染）+ DM 端到端卡片
- **Out**：原型图完整三屏联动（任务审核看板 / 文件版本表 / 预览编辑浮窗）若过大 → 拆 follow-up task

## 约束

- DM workspace 语义需 design 明确（revision 历史 / baseline 语义 / 与普通频道对称性）
- 技术选型沿用仓库现有惯例（解除硬拒方式、workspace 创建时机参照普通频道）
- rollout 门已确认不影响卡片链路（全仓 grep 零引用）
- worktree 隔离 + 独立分支修复

## 证据索引

- 断链诊断：`research/dm-workspace-status.md`、`research/local-daemon-log.md`、`research/formation-authority.md`
- web 断点：前轮 Explore 报告（`chat/page.tsx:4749-4802` / `:5063-5074`、`channel-message.tsx:64-93`、`OutputPackageCard.tsx:57`）
- 原型图：`docs/superpowers/prototypes/2026-07-28-chat-task-file-package-flow-prototype.html`
