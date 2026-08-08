# Session Handoff — 2026-08-08（原型功能收敛会话）

## Accomplished

**起始问题**：用户问"为什么按 2026-07-17 设计 + 2026-07-28 原型实现的系统，最终得到的不是原型表达的样子"。

**根因结论**（已验证）：状态契约层（#1059-#1066 epic）全对；界面形态层从未排进任何切片；且 rollout 门（5 个 `AGENTBEAN_PROJECT_*` flag）默认全关。设计文档 §8 "原型按钮只是展示形态"成了合规逃脱通道。

**本会话 PR 链**（全部已合 main 并部署生产 agentbean.dev）：

| PR | 内容 | 备注 |
|---|---|---|
| #1126 | 原型收敛 5 commit（话题入口列表/讨论串引用接线/任务详情交付视图/task-only 详情/活跃排序） | 后被部分回滚 |
| #1127 | 回滚主聊天区话题化 | **squash 空 commit 事故**——MERGED 但 main 没收到改动 |
| #1128 | 重新推进回滚（API squash） | ✅ 生效；普通消息恢复气泡+滚底 |
| #1129 | 删除 composer「发送后会创建新话题」提示语 | ✅ |
| #1130 | 讨论串文件包卡片原型对齐 4 项：成员行 file-sub（collection·current server vN·来源时间）、OutputPackagePreviewModal 预览/编辑浮窗、引用 chip PKG 短号、@选择器扩展文件/文件包 | ✅ 生产实证 |
| #1131 | **server 修复**：save-artifact-version-revision 剥离 bind 注入的 currentDeviceId（该 API 自 #1062 起经 socket 从未成功） | ✅ Railway 已部署 |
| #1132 | 浮窗保存 basis 只传 sourceVersionId（package/delivery 须成对且 source 须为冻结成员） | ✅ 生产实证保存生成 v5 + 轻量事件 |

**生产运维**：`railway variables set AGENTBEAN_CHANNEL_FILES_MARKDOWN_EDITING=true`（此前从未开，保存报 revision-editing-disabled）。

**关键文件**：
- `apps/web-next/components/OutputPackagePreviewModal.tsx`（新建，原型式包内浮窗）
- `apps/web-next/components/OutputPackageCard.tsx`（file-sub + 预览按钮 + onOpenPreview）
- `apps/web-next/components/SystemMessageBubble.tsx`（透传）
- `apps/web-next/app/[teamPath]/chat/page.tsx`（接线 + @选择器 + 引用 chip 标签）
- `apps/server-next/src/application/usecases.ts:7508`（currentDeviceId 剥离）

## Current State

- 生产 agentbean.dev：普通消息正常气泡+底部滚底；文件包卡片成员行信息/预览编辑浮窗/保存链路/@文件包选择器全部实证可用（保存生成 v5、轻量事件「test01 保存了《skills-summary.md》新版本 v5」已见）。
- main HEAD：`740384a0`（#1132）。
- 本地 untracked 文件（.agents/.codex/.trellis/tasks 等）已全部恢复（wip-untracked-feat-parity stash 已 pop 干净）。**不要对新会话 stash pop**——stash 栈顶是别人的 `wip-local-unrelated`。
- 本地工作区当前分支：fix/package-preview-basis（已合并删除远程）。本地 dev server（4100）+ web-next dev（4101）可能还在后台跑。
- Trellis 任务 `08-07-update-fence-self-lock`(#1114 daemon update 自锁）状态 in_progress/stale——本会话没碰它，是另一条线。

## Pending

**原型剩余深化项**（用户认可的方向，未排期）：
1. 短编号（F1/F2）歧义选择器（多个包含 F1 时弹选择器）
2. 讨论串最大化视图
3. 图片内置编辑（原型首版不做）
4. @文件包 final 显式选择的 @ 入口（当前 @包 只插 current；final 要从卡片按钮）
5. 引用 chip 的 F1/v4 短编号展示（当前成员引用 chip 是「PKG-xxx · N 项」）

**流程项**：#1130/#1131/#1132 没有对应 issue（#1125 已被 #1126 关闭）。如需追溯可补。

## Context for Next Session

**必读记忆**（~/.claude/projects/-Users-shaw-AgentBean/memory/）：
- `agentbean-project-collaboration-rollout-gate.md` — rollout 门 + 本次收敛全景
- `feedback-no-rework-working-mainchat.md` — **别再重做主聊天区**；消息分普通/讨论串/任务三类；原型是功能参考不是界面蓝图
- `agentbean-socket-bind-injection-vs-exact-keys.md` — bind 注入 currentDeviceId 陷阱 + probe 验证姿势
- `agentbean-gh-pr-merge-worktree-main-busy.md` — **MERGED ≠ 改动进 main**；squash 后必须 `git show origin/main --stat` 验证非空；worktree 占用时用 API squash
- `agentbean-local-dev-run-recipe.md` — 本地联调姿势（web-next 必须 NEXT_PUBLIC_AGENT_BEAN_SERVER_URL=4100）

**关键模式**：
- 合并 PR 用：`gh api -X PUT repos/xiaojichao/agentbean/pulls/<N>/merge -f merge_method=squash -f commit_title="..."`，然后 `git fetch origin main` + `git show origin/main --stat` 验证非空
- 生产 server 日志：`railway logs | grep threw`
- 生产实测：browser-harness 接管用户 Chrome（`list_tabs()` → `switch_tab()` 到 agentbean.dev tab）
- web 前端=Vercel（main 自动部署），server=Railway（CI Deploy production，仅 server 改动触发）
- 生产 rollout flags 全开 + MARKDOWN_EDITING 已开

**用户工作风格**：要快、别废话；动手前先问（AskUserQuestion 拍板范围）；重视功能实质不重演界面；改坏已工作功能会严厉指出。

## Resume Commands

```bash
# 确认 main 最新
git fetch origin main && git log origin/main --oneline -3

# 本地联调(两个后台)
node --env-file=.env apps/server-next/dist/apps/server-next/src/bin.js   # server :4100
NEXT_PUBLIC_AGENT_BEAN_SERVER_URL=http://localhost:4100 npm --prefix apps/web-next run dev  # web :4101

# 生产状态验证
node -e "fetch('https://api.agentbean.dev/metricsz').then(r=>r.json()).then(j=>console.log(JSON.stringify(j.projectCollaboration.rollout)))"
railway logs | grep -i threw | tail -5
```
