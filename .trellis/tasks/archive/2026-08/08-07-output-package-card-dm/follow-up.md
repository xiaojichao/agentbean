# Follow-up(server/web DM 卡片 task 收尾后)

本 task（#1106/#1107）核心目标达成：DM 频道（server/web 层）出文件包卡片，频道 3（DM xiao-mini）生产实证全链通（`stagings=1 committed` + `packages=1` + system 消息=1）。

剩余三个独立 follow-up，根因证据见 `research/channel-triage.md`。

## 1. device-agent：Hermes-xiao-mbp 输出隐藏路径（频道 1/2 出卡片的解锁点）

xiao-mbp 的 Hermes 把文件写 `~/.hermes/`（隐藏目录）→ daemon 安全守卫（`apps/daemon-next/src/artifact-collector.ts:566` `segments.some(s => s.startsWith('.'))`）拒收 → 不 publish → 无卡片/无同步。

xiao-mini 的 Hermes 写 `AGENTBEAN_OUTPUT_DIR`（相对路径）→ output-dir 扫描 → 全链通（频道 3）。

**修复**：让 xiao-mbp Hermes 写 `AGENTBEAN_OUTPUT_DIR`（对照 xiao-mini 的 Hermes 配置）。device-agent 适配，非 server/web 代码。

**注意**：不能简单放宽 daemon 隐藏守卫（`.hermes`）——它是安全设计（防 `.ssh`/`.gnupg`/`.config` 等敏感路径发布）。

## 2. web 布局：卡片位置（主线 → 讨论串）

频道 3 卡片出现在「消息主线」，原型图（`docs/superpowers/prototypes/2026-07-28-chat-task-file-package-flow-prototype.html`）要求在「讨论串（thread）」。涉及 web 消息流归类（output-package system 消息的 threadId + 布局逻辑），可能需消息流重构。

## 3. 体验：hidden-path 拒收诊断透出

reported-path 被隐藏守卫拒时，当前静默（`REPORTED_PATH_REJECTED` 未渲染，受 `index.ts:1341` `result.workspaceRun` 门控）。用户无感知为何没卡片。考虑透出诊断。

## 验证状态

- **#1106**（DM access 接入 + SystemMessageBubble 渲染）：频道 3 DM 实证全链通 ✓
- **#1107**（begin route baselineRevisionId 可选）：解非隐藏路径的 BAD_REQUEST ✓
- **#1099**（commit bootstrap）：对 DM 生效（频道 3 baseline="" bootstrap）✓
- 频道 1/2：device-agent（xiao-mbp Hermes `~/.hermes/`）未修 → follow-up #1

## 颠覆性归因（教训）

静态 research 推断「DM 被 server 硬拒」，但生产 DB 实证推翻：频道 3（DM）全链通。真分水岭是 **device-agent 行为（Hermes 输出路径）**，不是 server/web 代码或频道类型。跨层故障（卡片不出现）的症状在 web，根因可能在 device-agent 文件写入习惯——只看 server/web 代码会误判。
