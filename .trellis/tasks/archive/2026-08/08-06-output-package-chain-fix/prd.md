# 修通项目协作输出包链路（rollout 开启后暴露的三层断点）

## 背景

项目协作 / OutputPackage 功能（设计文档 `docs/superpowers/specs/2026-07-17-project-task-file-management-design.md`，
#1060–#1066 全合 main）在生产从未端到端跑通过。根因是 `projectCollaborationRollout` 五个 flag 默认全 `false`、
且无任何启动配置打开它们（已另开基建修：本地 `.env` + dev 脚本 `--env-file-if-exists`，生产 Railway 变量已开）。

rollout 门打开后，服务器实证暴露出链路上 **3 个独立断点**，导致用户触发剧本创作 Agent 产出文件后，
聊天里没有文件包卡片、Files 视图为空。本任务把这 3 个断点逐层修通，让功能在 `api.agentbean.dev`（生产/测试，
未正式投入使用）端到端可用。

## 生产实证（2026-08-06，team.sqlite / 服务器日志）

- `workspace_publish_stagings = 0`：从未发生一次 workspace 受控发布。
- `output_packages = 0`：没有包。
- `artifacts = 297`，但**全部是 `workspace-run.log`**（`artifact_role=run_output`），**0 个内容文件**。
- `channel_project_profiles = 0`、`project_stages = 0`：没有任何频道被设成项目。
- 服务器日志：`socket handler "project:list-output-packages" threw: OUTPUT_PACKAGE_PAYLOAD_INVALID`，每次开频道都抛。
- 连接的 4 台 daemon 版本 0.3.30/0.3.31/0.3.30/0.3.32，均 ≥ publish 流程引入版本（0.3.29），**排除旧 daemon**。

## Goal

让「Agent 产出内容文件 → 发布形成 OutputPackage → 聊天卡片 / Files artifacts 视图展示」这条链在生产端到端跑通。

## Requirements

- **#1 查询解析 bug**：`listOutputPackages` / `getOutputPackage` 因 socket 层注入的 `currentDeviceId` 未被剥离，
  触发 `assertExactKeys` 抛 `OUTPUT_PACKAGE_PAYLOAD_INVALID`。必须修复，使这两个查询正常返回（无包时返回空，不抛错）。
  并排查所有走「exact-key 严格校验」的 project handler 是否同样中招（如 package-review 命令）。
- **#2 内容文件发布**：查清剧本创作 Agent 把文件写到了哪里、为什么不进 daemon collector 的
  `outputDir` / `reportedOutputPaths` 通道，让一次真实执行能产出可发布内容文件并经 `commitWorkspacePublishStaging`
  形成 OutputPackage。
- **#3 项目设置 + 端到端**：把目标频道设成项目（profile / stage），使 `channelProjectOverview` 非空、Files 的
  artifacts 视图渲染；验证 Agent 产出 → 包 → 卡片 → Files 视图整链可见。

## 约束

- 生产服务器同时是测试环境（未正式投入使用），但仍按 PR → main → Railway 自动部署流程上线，不直接改线上代码。
- 改动遵循仓库现有惯例（剥离 session 字段的方式、collector 通道语义），不引入新依赖。
- 每个 slice 独立可验证、独立提交，避免一次大改。

## Acceptance Criteria

- [ ] **AC1（#1）**：服务器日志不再出现 `project:list-output-packages threw: OUTPUT_PACKAGE_PAYLOAD_INVALID`；
  前端打开频道 + Files 时 `listOutputPackages` 返回成功（空数组也行），Files/Task 包视图不再因报错而空。
- [ ] **AC2（#1 回归）**：新增覆盖「socket bind 注入 currentDeviceId 后调用 exact-key 校验 handler」的测试，
  防止同类回归（单测直接调 usecase 抓不到这个接缝 bug）。
- [ ] **AC3（#2）**：一次会产出文件的真实 Agent 执行后，`workspace_publish_stagings` 出现新行、`output_packages`
  形成对应包；聊天消息下方出现 OutputPackageCard。
- [ ] **AC4（#3）**：目标频道设为项目后，Files 的 artifacts 视图渲染，展示集合/输出包。
- [ ] **AC5（端到端）**：Agent 产出 → 审核/引用入口可点；全链无服务端报错。

## Notes

- 部署拓扑：单 Railway 服务 `api`（`api.agentbean.dev`）跑 server-next，`start:server-next` = `node .../bin.js`，
  dataDir `/data/agentbean-next`（持久 volume），项目表在 `team.sqlite`，设备表在 `global.sqlite`。
- 相关记忆：`agentbean-project-collaboration-rollout-gate`、`agentbean-output-package-deepening`、
  `agentbean-contracts-release-publish-loop`、`agentbean-production-admin`。
