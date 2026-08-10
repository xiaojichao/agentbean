# Research: Composer 机制（预填 / mention / 引用选择器 / 焦点）

- **Query**: 消息输入框在哪个文件，支持哪些预填方式，是否有 package/file selector UI，焦点恢复，「基于包修改」入口
- **Scope**: internal（apps/web-next）
- **Date**: 2026-08-10

## Findings

### Composer 所在位置

实际使用的 composer **不是** `apps/web-next/components/channel-input.tsx`（那是早期简化版，未被 chat 页引用）。生产 composer 有两套，都内联在页面组件里：

1. **主 composer**：`apps/web-next/app/[teamPath]/chat/page.tsx:2633-2701`（textarea data-smoke="chat-message-input" :2653；发送 `sendMessage` :1749-1792）。
2. **Thread composer**：`ThreadPanel` 组件（chat/page.tsx:4714 定义；textarea data-smoke="thread-message-input" :5101-5109；发送 `sendThreadMessage` :1794-1835）。

### 预填方式

| 方式 | 机制 | 位置 |
|---|---|---|
| URL `compose` 参数（跨页预填，#1064） | JSON `{ text?, selections? }` urlencode 进 `?compose=`；effect 解析后写 `threadInput`/`threadSelections` 本地 state，`requestAnimationFrame` 聚焦 threadTextareaRef，随后 `router.replace` 删掉 compose 参数（防刷新重复填充） | chat/page.tsx:348（composeParam）、:1590-1613（effect） |
| 同页直接 setState | `setThreadInput(...)` / `setInput(...)` + `threadTextareaRef.current?.focus()` / `textareaRef.current?.focus()` | 例：:2082-2089（continueWithAgentFromCard）、:2899、:2912-2918 |
| 回复预填 | `setThreadInput('回复 <speaker>: ' + ...)` | :2200-2204 |
| Tasks 页跨页跳转 | `router.push('/<np>/<channel|dm>/<cid>?thread=...&compose=...')` | tasks/page.tsx:366-375 |

注意 compose effect 的守卫：`if (!activeChannel || !composeParam || !threadRootId) return;`（:1594）——必须先有打开中的 thread（由同一 URL 的 `thread` 参数经 :1581-1588 effect 设置）才消费 compose。`parsed.text` 只在当前输入为空时填入（:1602 `prev.trim() ? prev : ...`），selections 直接覆盖（:1605）。

### Package / File selector UI

**Thread composer 有三类 @ 选择器**（chat/page.tsx:4845-4872，`ThreadMentionItem = member | package | file`）：

- `@成员/智能体`：mentionCandidates 过滤。
- `@文件包`：outputPackages（OutputPackageSummaryDto[]，按 packageId/taskTitle 过滤，取前 5）→ 选中产生 `package_projection` current 引用（见选择逻辑，data-smoke="thread-mention-package" :5075）。
- `@文件`：artifactLibrary.collections 的 currentVersion（前 8）→ `artifact_version` 引用（data-smoke="thread-mention-file" :5090）。

**主 composer 的 @ 选择器只有成员/智能体**（:2636-2652，data-smoke="mention-candidate"），没有 package/file 候选；主 composer 的引用选择来自：消息卡片「加到 composer」（:2577-2589）、Files 工具栏（addFilesBoardReference :947-966）、「继续 @Agent」（:2082-2089）。

**引用 chips 展示**：

- 主 composer：`projectReferenceSelections` chips（:2654-2676，data-smoke="project-reference-composer-chips"），label 由 `projectReferenceSelectionLabel`（:4694-4713）生成，可逐个移除。
- Thread composer：`threadSelections` chips（:5111-5133，data-smoke="thread-reference-composer-chips"），同型可移除。

### 选择（selection）类型与去重

`ProjectReferenceSelectionRequestDto`（@agentbean/contracts），kind 包括 `package_projection`（带 policy delivered/current/final + current/final 时带 expectedMemberRevisions fence）、`package_members`（显式成员列表）、`artifact_version`、`bundle_all`、`bundle_subset`、文档类。去重语义：整包/成员选择按 packageId 互斥、版本选择按 versionId 互斥（ThreadPanel onAddSelection :2960-2977；主 composer :2577-2589、:947-966 同规则）。

### 发送落点

- 主：`message.send` payload 带 `selections: projectReferenceSelections`（:1764-1768）。
- Thread：`message.send` 带 `threadId: threadRootId, selections: threadSelections`（:1811）。失败保留 input+selections+attachments 供重试，成功才清空（:1808-1820 注释，#1064 AC11）。

### 焦点恢复

- 预填后聚焦：`threadTextareaRef`（:467 声明，#1064 注释「Task 页『交给 Agent 处理』预填后移焦」）/ `textareaRef`（:461）。
- mutation 对话框关闭后焦点恢复到触发按钮：`restoreFocusSelectorRef` + `queueMicrotask(() => document.querySelector(selector)?.focus())`（StageDeliveryReviewWorkspace.tsx:172-187），selector 用 `[data-smoke=...][data-action=...]`。
- 关闭任务详情后焦点回阶段卡片：closeTaskDetail :2106-2112。

### 「基于此修改」入口现状（#1062/#1063）

- `ReviseVersionRequest` 契约在 OutputPackageCard.tsx:73-85（collectionId/baseVersionId/sourceVersionId/basisReviewId?/packageId?/deliveryId?/collectionRevision）。
- **文件包卡片（OutputPackageCard）当前不展示修订入口**（:99 注释「暂时不在文件包卡片展示修订入口；保留回调契约供后续恢复，不影响 Files 修订入口」）。
- Files 逻辑产物视图保留：ProjectFilesBoard 行内「基于此修改」（包行 :802-821、集合行 :768-786）→ `onOpenRevisionEditor` → page.tsx 的 `openArtifactRevision` 流（:411 state，复用 MarkdownDocumentEditor，saveArtifactVersionRevision 冲突流，basis 只传 sourceVersionId，遵循 #1131）。
- 卡片保留的入口：整包引用三策略（delivered/current/final，:182-197 经 lib/output-package-reference）、成员单选「引用」/多选（:199,385）、「打开审核 Task」onOpenTask、「继续 @Agent」onContinueWithAgent（:424-445）。

## Caveats / Not Found

- 主 composer 无 package/file @ 候选（仅 thread composer 有）；若新需求要主区选择器，现状只能靠卡片/Files 加入。
- compose URL 参数消费后不可重放（立即删除），且仅在 thread 已打开时生效——主 composer 预填没有对应的 URL 机制（task-only 的 delegate 用同页 setState 回落）。
