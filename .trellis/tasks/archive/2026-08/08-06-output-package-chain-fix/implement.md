# 执行计划：修通项目协作输出包链路

## 执行顺序

按依赖关系：**Slice 1（独立，先做）→ Slice 2（研究 + 修）→ Slice 3（设置 + 端到端）**。
Slice 1 不依赖其它，可立即开工并独立上线。

---

## Slice 1 — 修复 #1 currentDeviceId 剥离

- [ ] 1.1 起独立分支 `fix/output-package-query-session-envelope`（base main）。
- [ ] 1.2 `usecases.ts` `listOutputPackages`：`const { userId, teamId, currentDeviceId, ...wireInput } = packageInput;`
- [ ] 1.3 `usecases.ts` `getOutputPackage`：同上剥离 `currentDeviceId`。
- [ ] 1.4 排查 package-review 命令及其它 exact-key project handler，若中招一并修。
- [ ] 1.5 补测试：注入 `currentDeviceId` 后调 `listOutputPackages`/`getOutputPackage` 断言不抛、返回成功（AC2）。
- [ ] 1.6 本地验证：
  - `npm run build:server-next` 通过；
  - 相关 `vitest` 套件绿；
  - 若动 contracts barrel，**必跑 tsc**（幽灵导出坑，见记忆 `agentbean-vitest-not-tsc-blindspot`）。
- [ ] 1.7 提 PR → 合 main → Railway 自动部署。
- [ ] 1.8 生产验证（AC1）：
  - `curl -s https://api.agentbean.dev/metricsz` 确认服务在线；
  - `railway logs | grep "list-output-packages threw"` **应无新抛**；
  - 浏览器开频道 + Files，确认不报错（空也算通过）。

**Review gate**：1.6 全绿才提 PR；1.8 日志清净才算 Slice 1 完成。

---

## Slice 2 — 修复 #2 内容文件未发布

- [ ] 2.1 **研究**（不改代码）：从用户处拿到剧本文件在设备上的实际路径；查这次 run 的 `outputDir` 配置；
  读 run 的 `workspace-run.log`（artifact 里有）找产出路径线索；比对 collector 扫描规则（`IGNORED_OUTPUT_DIRS` / manifest）。
- [ ] 2.2 定论：是 Agent 写错位置（→ A 改输出位置）、还是没 report（→ B report 机制）、还是 collector 规则不匹配（→ C daemon 侧）。
- [ ] 2.3 按定论实现（优先 A/B）。
- [ ] 2.4 起分支 → 改 → 测试 → PR → 合 → 部署。
- [ ] 2.5 生产验证（AC3）：触发该 Agent 执行 →
  - SSH 查 `workspace_publish_stagings` 出现新行、`output_packages` 形成包；
  - 聊天出现 OutputPackageCard。

**Review gate**：2.1 研究结论写入本文件 2.2 后才动手改；2.5 DB 出现 publish+package 才算完成。

---

## Slice 3 — #3 项目设置 + 端到端

- [ ] 3.1 用 project stage 命令把目标频道设成项目（profile + stage），使 `channelProjectOverview` 非空。
- [ ] 3.2 端到端验证（AC4/AC5）：Agent 产出 → 包 → 卡片 → Files artifacts 视图渲染；审核/引用入口可点。
- [ ] 3.3 全程 `railway logs` 无 socket 抛错。

---

## 验证命令速查

```bash
# 本地构建
npm run build:server-next

# rollout 门状态（生产）
curl -s https://api.agentbean.dev/metricsz | python3 -m json.tool

# 生产 socket 抛错检查
railway logs 2>&1 | grep -iE "socket handler .* threw|OUTPUT_PACKAGE_PAYLOAD_INVALID" | tail

# 生产 DB 诊断（只读脚本，已上传 /tmp/ab-diagnose*.cjs）
railway ssh -- NODE_PATH=/app/node_modules node /tmp/ab-diagnose.cjs

# daemon 版本（global.sqlite devices.daemon_version）
railway ssh -- NODE_PATH=/app/node_modules node /tmp/ab-devices.cjs
```

## 回滚点

- 每个 slice 独立 PR；任一 slice 出问题，revert 该 PR 即可（无 schema/不兼容变更）。
- 若 Slice 1 修复引发新问题，revert 后 listOutputPackages 回到「抛错返回空」原状（不恶化）。

## 当前状态

- rollout 门：生产 + 本地已开（基建另修，不在本任务）。
- **Slice 1 ✅ 完成（已上生产）**：PR #1094 CI 绿(7m9s) → squash 合 main(84c8ba41)。
  注意：**合并 main 不会自动部署**，需 `railway redeploy --from-source`。新部署 038919c9 上线，
  dist 确认含 `currentDeviceId` 剥离（list+get 各 1）。AC1 达成：日志 `list-output-packages threw` = 0。
  AC2 达成：回归测试 `output-package-session-envelope.test.ts` 已加并通过。
- **部署 gotcha**（供 Slice 2/3 复用）：Railway 此项目只在改配置/变量时自动 redeploy；代码合并需手动
  `railway redeploy --from-source -y`，再读 dist 二次确认（CI/合并 ≠ 已部署）。
- **Slice 2 ✅ 完成（已发版）**：根因 = daemon reported 目录正则不认 Markdown 反引号
  （`UNIX/WINDOWS_REPORTED_DIR_RE` 边界集缺反引号），Agent 用反引号报的目录被静默丢弃。
  #1096 修 + 发 **0.3.35** 到 npm latest（CI 自动 publish+promote latest）。生产实证确认提取生效
  （`[workspace-publish] count=1`，Hermes 反引号报的路径被收集）。本机 daemon 全局包已升 0.3.35。
- **Slice 3 ✅ 代码完成（PR #1099 CI 中）**：根因 = **workspace bootstrap 死锁**——publish 要
  workspace baseline，workspace 靠已有文件建，首次产出无处奠基（`BASELINE_UNAVAILABLE` /
  `REPORTED_OUTPUTS_NOT_PUBLISHED`）。修：publishRevision 首次发布(空 baseline)事务内 bootstrap
  初始 workspace+revision；commit 流程无 workspace 跳过恢复/pre-conflict；begin 放宽 baseline 必填；
  daemon 无 baseline 也继续 publish（全链路 baseline 可选，HTTP 发 '' 满足 NOT NULL）。发 **0.3.36**。
  验证：7 个新 bootstrap 测试（repo 级 + commit 端到端）+ 101 现有 publish 测试零回归。
- **下一步**：#1099 合 main → server `railway redeploy --from-source` + daemon 0.3.36 自动发 →
  设备 `npx @agentbean/daemon@latest` → 重触发 Agent 端到端验证（卡片出现）。
- **设备 daemon 更新方式**：device-service payload 是 238B 转发启动器，跑全局 npm 包
  `@agentbean/daemon`；`npm i -g @agentbean/daemon@latest` + `launchctl kickstart -k gui/$(id -u)/com.agentbean.device-service` 即升级。
- **遗留观察**：本机 0.3.35 daemon 偶发 `socket has been disconnected` + `LOCAL_MEMORY_PATH_CHECK_FAILED`、`LEGACY_RUNTIME_FENCE` 日志噪声；未阻塞 Agent 执行，待 0.3.36 后复看。
