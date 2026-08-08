# 实施计划：修通 DM 频道文件包卡片端到端链路

## 前置

- worktree off origin/main（含 #1099/#1100），建本地 @agentbean 软链（记忆：worktree node_modules 解析陷阱）
- daemon 已 0.3.37（用户设备，无需再发版）

## Slice 1：断点 B·web 渲染（独立 PR，普通频道可验证）

1. **[TDD 红]** 写集成测试：system 消息（`meta.kind='output-package'`）经 ChatBubble 渲染 → 断言 OutputPackageCard 出现、琥珀药丸不出现。放 `apps/web-next/`，参照 `output-package-card-entry.test.tsx` + 现有 ChatBubble 测试惯例
2. **[实现]** `chat/page.tsx:4790` 兜底 return 前加 output-package 分支，接线 `channelId` + `onAddReference`/`onOpenTask`/`onReviseVersion`/`onContinueWithAgent`
3. **[实现]** `channel-message.tsx:72` return 前加 output-package 分支（回调不全保持静态展示）
4. **[验证]** `pnpm --filter @agentbean/web-next test` + `tsc` + lint
5. **[PR]** 普通频道即可端到端验证（普通频道 formation 成功 → 卡片出现，不再只是药丸）

**Review gate**：web 测试绿 + tsc 0 error + 集成测试覆盖 system→卡片路径

## Slice 2：断点 A·server DM workspace 接入（独立 PR，DM publish 可验证）

1. **[TDD 红]** 写测试：DM 频道（`kind='direct'`）经 `ensureUserCanViewProjectWorkspace`/`ensureSnapshotChannelAccess`/`ensureWorkspacePublishChannelAccess` 不再 NOT_FOUND；`#all` 频道仍 NOT_FOUND
2. **[实现]** 删三处 `kind === 'direct' ||`（usecases.ts:17349/17370/17395），保留 `name === 'all'`
3. **[TDD 红]** 写集成测试：DM 首次 publish → bootstrap 建 init workspace → `commitWorkspacePublishStaging` 成功 → `formPackage` 形成 OutputPackage + system 消息（复用 #1099 测试模式：workspace-publish-dispatch.test.ts）
4. **[验证]** `ensureUserCanViewChannel` 对 DM 不挡（listOutputPackages/getOutputPackage 对 DM 返回）——research 静态结论的运行时确认
5. **[验证]** `pnpm --filter @agentbean/server-next test` + `tsc`
6. **[PR]**

**Review gate**：server 测试绿 + tsc + DM bootstrap 集成测覆盖

## Slice 3：端到端验证（依赖 Slice 1+2 合 main）

1. 部署 server（web + server main）
2. DM 频道触发 Hermes-agent-xiao-mbp 执行
3. 验证：讨论串出文件包卡片 + server `output_packages` 表有记录
4. 盯日志：无 NOT_FOUND / staging 跳过 / `BASELINE_UNAVAILABLE`

**Review gate**：端到端实证（日志 + DB 行 + UI 截图）

## Follow-up（本 task 不做，记入收尾）

- 原型图三屏联动（任务审核看板 / 文件版本表 / 预览编辑浮窗）——AC5 拆出
- memory 后端 outputPackages 级联验证（research 标注）
- daemon `fetchProjectChannelWorkspaceCurrent` 失败处加 `console.warn`（辅助诊断，research 建议；治「静默跳过」的可观测性）

## Rollback points

- 每个 Slice 独立 PR，任一红可单独回退
- Slice 2 回退后已形成的 DM workspace 数据保留（无害，CASCADE 清理在 deleteChannel）
