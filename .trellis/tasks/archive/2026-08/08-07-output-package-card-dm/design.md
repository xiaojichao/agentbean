# 技术设计：修通 DM 频道文件包卡片端到端链路

## 方案总览

采用 research 推荐的**方案 b：DM 首次 publish 懒创建 workspace**——最大化复用 #1099 bootstrap，零 schema 变更，与普通频道首次 publish 完全对称。排除了 a（创建时预建，与 `createProjectChannelWorkspace` 域规则「revision 必须非空」冲突）和 c（共享 workspace，与 `UNIQUE(channel_id)` 约束冲突）。

修两层（双重断点，缺一不可）：
- **断点 A（server）**：解除 DM 频道的 workspace 访问硬拒 → DM 能 publish
- **断点 B（web）**：system 消息渲染 OutputPackageCard → 卡片可见

## 断点 A：DM workspace 接入（server）

### 改动：删三处 DM 排除（保留 #all 排除）

三处 access 判定对 `channel.kind === 'direct'` 返回 NOT_FOUND。解除 DM 排除，**保留 `name === 'all'`**（#all 内置频道本就不该有 workspace）：

| 行号 | 函数 | 分支 | 当前 | 改后 |
|---|---|---|---|---|
| usecases.ts:17349 | ensureUserCanViewProjectWorkspace | 主 | `kind === 'direct' \|\| name === 'all'` | `name === 'all'` |
| usecases.ts:17370 | ensureSnapshotChannelAccess | 非成员（device） | 同上 | 同上 |
| usecases.ts:17395 | ensureWorkspacePublishChannelAccess | 非成员（device） | 同上 | 同上 |

注：`ensureSnapshotChannelAccess` / `ensureWorkspacePublishChannelAccess` 的 isMember 分支委托 `ensureUserCanViewProjectWorkspace`，改 17349 自动传导；17370/17395 是非成员 device 分支的独立判断，单独改。

### 为什么只删检查就够（无需补 workspace 创建代码）

解除 access 硬拒后，DM publish 流程自动复用 #1099 的 baseline bootstrap：
1. daemon `fetchProjectChannelWorkspaceCurrent` 对 DM 不再 NOT_FOUND
2. baseline 为空时，#1099 bootstrap（commitWorkspacePublishStaging 放宽 + sqlite bootstrap + repositories `baselineRevisionId` opt）自动创建 init workspace
3. DM 首次 publish 与普通频道首次 publish 完全对称

research 确认：「即使拉 #1099，DM 仍被 access 层挡在 bootstrap 之前」→ 删 access 硬拒后 bootstrap 自然生效，无需额外创建代码。

### daemon 侧：无需改代码

daemon baseline 门（`index.ts:1171` `serverUrl && baselineRevisionId`）本身不检查 channel kind。access 层解了，baselineRevisionId 拉到（server 返回有效 baseline），门自动通过。daemon 0.3.37 已在用户设备。

### 清理路径（已就绪，无需新增）

- `deleteChannel`（usecases.ts:5234）级联 workspace
- migration 0077：`output_packages.channel_id REFERENCES channels(id) ON DELETE CASCADE`
- `archiveChannel` 无 kind 检查 + #1066 archive gate 覆盖 staging 收口

## 断点 B：web 渲染（system 消息 → OutputPackageCard）

### 改动：两处 system 早返回前加 output-package 分支

**chat/page.tsx（ChatBubble，主聊天生产路径）**：
- 位置：`:4790` 兜底 return 之前（taskStatusEvent 分支之后）
- 加：`const pkg = outputPackageFromMeta(meta); if (pkg) return <OutputPackageCard packageMeta={pkg} channelId={msg.channelId} onAddReference={...} onOpenTask={...} onReviseVersion={...} onContinueWithAgent={...} />;`
- 回调接线：复用 ChatBubble 作用域已有的 `onAddPackageReference` / `onOpenTaskDetailById` 等

**channel-message.tsx（旧渲染面）**：
- 位置：`:72` return 之前
- 同样加 output-package 分支（回调不全时保持静态展示）

### 为什么现有 CI 漏

`output-package-card-entry.test.tsx` 只单测 `<OutputPackageCard>` 组件，没经 ChatBubble 集成测。补集成测试：构造 system 消息（`meta.kind='output-package'`）渲染 ChatBubble，断言出现 OutputPackageCard 而非药丸。

## 关键论断：DM publish 一通，卡片查询不挡

research 确认 `ensureUserCanViewChannel`（channel-access.ts，listOutputPackages/getOutputPackage 入口）**本就不检查 channel kind**。web OutputPackageCard 只看 message meta。所以：
- 断点 A 修 → DM publish → OutputPackage 形成 + system 消息追加
- 断点 B 修 → system 消息渲染成卡片
- 两者都修 → DM 卡片端到端通

## 结构决策：单 task，2 slice（2 PR）

不拆 parent/child（两 slice 都是中等以下复杂度，单 task 可管理）。两 slice 独立可验证、独立 PR：
- **Slice 1（断点 B·web）**：小，普通频道即可验证
- **Slice 2（断点 A·server）**：中，DM publish 可验证

依赖：Slice 1、2 独立（可并行/任意顺序）。端到端（Slice 3 验证）依赖两者都合 main。

## 两个澄清点的处理

1. **分支 rebase**：实现用 worktree off origin/main（天然含 #1099 + #1100 + 最新代码）。当前主区 `refactor/extract-channel-access` 落后，不在其上实现。
2. **DM revision 多版本暴露**：跟随普通频道现状——DM publish 自动产生 revision（技术对称），前端暂不单独暴露 diff 视图（普通频道的版本视图同样是 follow-up）。

## 风险

- worktree off origin/main（记忆：worktree node_modules 解析陷阱，须重建本地 @agentbean 软链）
- memory 后端 outputPackages 级联未深查（research 标注 follow-up）
- `ensureUserCanViewChannel` 不挡 DM 为 research 静态结论，Slice 2 TDD 时验证

## 回滚

- Slice 1：还原 web 两处分支（web-only，无 schema）
- Slice 2：还原三处 access 判断（server-only，无 schema）。已形成的 DM workspace 数据保留（无害）
