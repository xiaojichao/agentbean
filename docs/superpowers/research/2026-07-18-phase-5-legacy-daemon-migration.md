# Phase 5：Legacy Daemon 数据盘点、迁移事务与回滚合同

日期：2026-07-18
范围：GitHub #672。本文只冻结当前 npm Daemon 到用户级 Device Service 的一次性迁移，不实现安装器、系统凭证 adapter 或更新器。

## 结论

Phase 5 不是一次“把所有本地文件复制到新目录”的数据搬家。当前 canonical npm Daemon 已经承载 daemon-next 的 DeviceServiceCore，并使用目标长期数据形状。迁移应冻结为：

> 同一 OS 用户下，对现有本地数据执行原地所有权交接；只转换凭证与非秘密 Profile registry。Workspace、Local Memory、Workspace Run 和 management outbox 保持原路径，不复制、不上传。

Server credential generation 的原子提升是不可逆点：

- 提交前失败：删除 staged credential 和 staged registry，恢复旧 Daemon；旧 credential 仍有效。
- 提交状态未知：查询 migration transaction，禁止猜测和重复生成身份。
- 提交后失败：只能由 Device Service 使用系统凭证库中的新 generation 恢复；旧 auth.json 已失效，绝不恢复明文 credential。

因此“自动回滚到旧 Daemon”只存在于 credential commit 之前。commit 之后是新 Device Service 的自动恢复或签名版本回滚，不是 Legacy Daemon 回滚。

## 仓库事实

### 当前数据根

apps/daemon-next/src/profile-paths.ts 冻结了以下路径：

| 数据 | 当前路径 |
| --- | --- |
| Device 机器身份 | ~/.agentbean/machine-id |
| Profile 明文凭证 | ~/.agentbean/teams/{profile}/auth.json |
| Management durable outbox | ~/.agentbean/teams/{profile}/management/outbox.json |
| Profile Local Memory | ~/.agentbean/teams/{profile}/memory/items.json |
| Scan cache | ~/.agentbean/teams/{profile}/scanned-agents.json |
| Workspace Run | {cwd}/.agentbean/runs/{runId}/... |
| Workspace Local Memory | {cwd}/.agentbean/memory/{profile}.json |

对应源码：

- https://github.com/xiaojichao/agentbean/blob/main/apps/daemon-next/src/profile-paths.ts
- https://github.com/xiaojichao/agentbean/blob/main/apps/daemon-next/src/scan-cache.ts
- https://github.com/xiaojichao/agentbean/blob/main/apps/daemon-next/src/workspace-run.ts
- https://github.com/xiaojichao/agentbean/blob/main/apps/daemon-next/src/memory/local-memory-store.ts

Phase 1 总纲明确规定 Phase 5 只改变分发、系统服务注册、升级、回滚和迁移体验，不改变恢复与 outbox 合同：

https://github.com/xiaojichao/agentbean/blob/main/docs/superpowers/specs/2026-07-10-agentbean-pi-management-agent-design.md

### 当前身份与连接语义

- Server 用 teamId + machineId + profileId 调和 canonical Device。
- Device hello 会续签 device-bound token。
- 当前 socket 路由按 deviceId 保存单个最新 socket；旧 socket 仍可能存在，单靠 latest-wins map 不能构成安全 fencing。
- Management lease 已有 fencing token 和 idempotency；旧 Worker 不能凭旧 fencing 写入当前 Run。
- management outbox 只保存 run/command/idempotency/hash/tool/timestamp，不保存 secret，采用临时文件加 rename 的原子保存。

对应源码：

- https://github.com/xiaojichao/agentbean/blob/main/apps/server-next/src/application/usecases.ts
- https://github.com/xiaojichao/agentbean/blob/main/apps/server-next/src/transport/socket-server.ts
- https://github.com/xiaojichao/agentbean/blob/main/apps/daemon-next/src/management-durable-outbox.ts
- https://github.com/xiaojichao/agentbean/blob/main/packages/domain/src/manager-lease-policy.ts

Node 的 rename API 是现有原子文件替换实现所依赖的平台抽象；迁移 journal 和非秘密 registry 继续采用“同目录临时文件、fsync、rename、父目录 fsync”的耐久写入形状：

https://nodejs.org/api/fs.html#fspromisesrenameoldpath-newpath

## 数据分类

| 对象 | 决策 | 理由与约束 |
| --- | --- | --- |
| auth.json Device token | 一次性导入系统凭证库，随后删除 | 文件字段和 token payload 都不可信；必须经 #674 migration prepare/verify、write/read-back、possession proof 和 generation commit。不得进入备份。 |
| Profile alias、serverUrl、teamId、ownerId | 只作候选输入，转换为非秘密 versioned registry | Server grant 返回 canonical identity；生成随机 immutable profileKey 与 opaque credentialRef。alias 可改名，不是 secret identity。 |
| machine-id | 原地复用 | 保持同一物理 Device identity；只接受当前用户拥有、非 symlink、严格权限、大小有界的 regular file。缺失或损坏时不得在迁移中静默生成新 Device。 |
| Custom Agent 配置 | 从 Server 重新获取 | 当前执行配置以 Server 为事实源；本地 workspace/Agent 配置文件留在原位置，不复制正文。 |
| scan cache | 丢弃并重建 | scanned-agents.json 是优化缓存，源码已把损坏/缺失视为 cache miss；不能作为迁移事实源。 |
| management outbox | 原地复用并严格校验 | 保留 idempotency 和未确认事实；切换前 flush/fsync，切换后使用当前 generation/fencing replay。损坏时 fail closed，禁止重置为空后继续接新工作。 |
| 内存 dispatch outbox | 不迁移 | 旧进程 drain 必须完成或落为 Workspace Run/Server 幂等事实；内存队列不能成为切换依赖。 |
| Workspace Run | 原地复用 | discoverRecoverableWorkspaceRuns 已按 manifest/response/reportedAt 恢复；迁移不复制、不上传、不重写历史内容。 |
| Profile Local Memory | 原地复用 | 保持 ~/.agentbean 路径、文件锁和 schema；迁移期间只读预检，不做 schema rewrite。 |
| Workspace Local Memory | 原地复用 | 保持 workspace/.agentbean/memory；不得扫描未知 workspace、复制到状态目录或上传 Server。 |
| YAML/CLI/env 配置 | 只导入精确 allowlist 的非秘密偏好 | env 插值不是 durable source；token、API key、invite code 和任意自由字段不迁移。 |
| npm package/binary | 保留但禁用，观察期后清理 | 它是兼容 shim 与恢复工具，不是数据备份；commit 后不得用旧明文 token重新上线。 |

## 迁移状态机

每个 OS 用户只有一个 migration transaction；每个 Profile 有子状态。所有状态写入不含 secret 的 migration journal，并由 migrationId 幂等关联 Server transaction。

### 1. discovered

- 只由当前 OS 用户通过本地交互命令显式触发，不自动迁移。
- 检查新 Device Service、旧 npm Daemon、遗留 migration journal 和系统服务注册状态。
- 若已有 committed marker，npm shim 只转发 Device Service 命令，绝不打开 socket。

### 2. preflighted

- 验证签名 payload、目标架构、磁盘空间、系统凭证 backend、当前用户身份和服务注册权限。
- 只接受已知状态根和已知 Profile 目录；所有源文件执行 regular-file、非 symlink、owner、mode/ACL、大小与 schema 检查。
- 调用 #674 的无副作用 Server migration prepare；不得复用会 upsert/clear revocation 的普通 hello。
- 读取 Server authoritative Profile/Device identity；展示迁移计划和明确排除项，不展示 secret 或 Workspace/Memory 正文。
- 若存在 active migration、未知旧进程、无法校验 outbox 或损坏 Memory target，fail closed。

### 3. staged

- 安装签名 Device Service payload，但保持 installed-disabled。
- 写入 staged 非秘密 Profile registry；不覆盖 current registry。
- Server 发行短期一次性 migration grant 和 next-generation credential。
- 当前进程把 credential 写入系统凭证库 generation 项，精确读回并证明 possession。
- 启动 migration-only Supervisor 健康会话：只允许本地 IPC、签名/资产/目录/锁/adapter 自检和 Server migration endpoint；禁止 live Device hello、Dispatch、Task Claim、Manager lease、outbox replay 和业务写入。
- migration-only healthy 后退出或停在只接受 commit 的隔离状态。此时旧 Daemon仍可服务，不存在双 live Device。

### 4. draining-legacy

- npm shim 和迁移器写 desired=migrating，阻止新的旧 Daemon启动。
- 旧 Daemon 停止 admission，等待 active work；超时按 #669 release/abort、持久化可恢复状态、flush/fsync outbox 与 Workspace Run manifest。
- Server 确认旧连接不再领取新工作；本地确认已知旧进程退出。
- 旧版本可能不理解 migration lock，所以本地 lock 不是最终安全边界；Server credential generation 和 connection fencing 才是最终边界。

### 5. committing

此步是 point of no return。

Server 在一个幂等 transaction 中验证：

1. migrationId/grant 未过期且未被消费；
2. staged generation possession proof 正确；
3. migration-only health 证据绑定同一 payload、machineId、profileKey 与 registry hash；
4. 旧 generation 当前且旧 live connection 已进入 drain；
5. 没有并发迁移或身份漂移。

随后原子执行：

- 提升 current credential generation；
- 使旧 auth.json credential 与更低 generation 立即失效；
- 将 canonical Device/Profile 绑定到 immutable profileKey；
- fencing 并主动断开所有较低 generation socket/Worker；
- 记录 committed migration result，重复请求返回同一结果。

所有 Device socket 事件必须绑定连接建立时验证的 credential generation，并在关键 mutation 上复验 current generation。仅替换 agentSocketsByDeviceId 的 map 不足以阻止旧 socket 继续发送或再次 hello。

### 6. activating

- migration-only Supervisor 用已读回的新 credential 转为 normal，或由平台管理器启动同一签名 payload。
- 复用 machine-id、Profile registry、outbox、Workspace Run 和 Local Memory 原路径。
- 先 replay unresolved outbox 和恢复 Server lease/checkpoint，再开放新 admission。
- health 必须同时确认：本地 IPC ready、Server current generation、canonical Device 未分叉、旧 socket 被 fenced、每 Profile 状态明确、outbox replay 无冲突。

### 7. committed / source-cleanup-pending

- 写入 committed 非秘密 marker，再删除 auth.json。
- 删除失败进入 source-cleanup-pending；运行时仍只读系统凭证库，绝不回退 auth.json。
- npm shim 看到 committed marker 后只报告已迁移并转发 Device Service CLI。
- 旧 npm payload 可保留到观察期结束，但保持 disabled；数据清理由 #670 决定。

## 失败与回滚

| 失败点 | 必须行为 |
| --- | --- |
| prepare/stage/health 失败 | 删除 staged credential/registry/payload，保留旧 credential 与旧 Daemon；迁移可用同一 migrationId 重试。 |
| legacy drain 失败但未 commit | 取消迁移，恢复旧 admission；不提升 generation。 |
| commit 请求超时/ack 丢失 | 进入 commit-unknown；查询 Server transaction 和系统凭证 generation。禁止恢复旧 token或再次 prepare 新身份。 |
| Server 确认未 commit | 清理 staged 状态并恢复旧 Daemon。 |
| Server 确认已 commit | 只走 activating；旧 Daemon 永久被 fenced。 |
| commit 后 Device Service 崩溃 | 平台管理器重启同一签名 payload，或由 #666 回滚到上一签名 Device Service 版本；继续使用新系统 credential。 |
| outbox replay 冲突 | Profile Runner degraded/fail closed，不开放新 management session；保留原 outbox供恢复。 |
| auth.json 删除失败 | source-cleanup-pending，重复删除；绝不读取作为 fallback。 |

## 备份合同

- secret 永不进入 migration backup、journal、日志、argv、env 或诊断包。
- auth.json 在 commit 前保持原位就是唯一 Legacy source；不创建第二份副本。commit 后它已经无效，只执行删除。
- Workspace、Workspace Run 与 Local Memory 原文件不改写，因此不复制、不打包、不上传；迁移只记录类别、计数和允许的 schema/hash。
- 非秘密 Profile registry 采用 staged/current 两代文件和原子 rename；旧 generation 在 committed marker 后按保留策略清理。
- 若未来确需 schema rewrite，必须另立 versioned migration，逐文件 bounded backup、恢复演练与内容隐私评审；Phase 5 初始迁移禁止顺带升级这些数据。

## 并发与幂等

- migrationId 在 Server 对 OS user + machineId + legacy profile + target profileKey 唯一。
- 第二个迁移器只能 attach/query 现有 transaction，不能产生第二个 generation。
- 本地 migration lock、Supervisor lock 和 per-Profile lock 防同用户正常进程竞态；Server generation fencing 防不合作的旧 npm 进程、网络分区和隐藏副本。
- 每一步采用 compare-and-set previousState、输入 hash 与 durable result；重复执行只能返回原结果。
- machineId/profile alias/cwd 变化、registry hash 漂移或源文件替换会使既有 grant 失效，返回重新 preflight。

## npm shim

- 未迁移：只提供 status、migrate 和有限 Legacy 启动；显示弃用与目标 Device Service。
- staged/draining/commit-unknown：只进入 recovery/status，不允许另开 Legacy socket。
- committed：不执行旧 runtime；转发 Device Service status/logs/doctor，或提示安装当前平台 CLI。
- shim 不持有新 credential，不读取系统凭证库 secret，也不能用环境变量强制绕过 committed marker。

## 可证伪验收

1. 在每个状态落盘前后强杀迁移器，重复命令都收敛到唯一合法状态。
2. prepare、write、read-back、migration-only health、drain、commit、activate、auth 删除分别注入失败。
3. commit ack 丢失后分别模拟 Server committed/not-committed，验证不会双重提升 generation 或恢复失效 token。
4. 同时启动两个迁移器、旧 npm Daemon 和新 Service；Server 最终只有 current generation 能 hello、接任务或写结果。
5. 保留一个网络分区中的旧 socket，在 commit 后发送 hello、Dispatch result、Task claim 和 management event，全部 stale-generation 拒绝。
6. 带 unresolved outbox 和已完成未 reported Workspace Run 切换；新 Service 只补报一次，idempotency 不产生重复事实。
7. 对 auth.json、machine-id、outbox、Memory、Workspace target 注入 symlink、错误 owner/mode、超限、未知 schema 和切换时替换，全部 fail closed。
8. 迁移前后逐字节比较 Workspace、Workspace Run 与 Local Memory；除预期运行时新事实外，迁移本身零改写、零复制、零上传。
9. 扫描 journal、backup、日志、status、diagnostic 与进程 argv/env，Device token 和模型 credential 零命中。
10. Profile 重命名保持 profileKey/credentialRef；Profile 复制没有 credential reference，必须重新授权。

## 对后续 Issue 的输入

- #666 更新协议必须把 migration-only payload health 与普通版本 health 分开，并在 commit 后只回滚签名 Device Service 版本。
- #668 CLI 必须暴露 migrate plan/status/resume/cancel；cancel 只允许 point of no return 前。
- #670 卸载必须区分保留原地数据、完全清除和 committed migration 后的 Legacy package 清理。
- #673 必须覆盖上述 crash-point、双连接、stale generation、outbox/Workspace recovery 和 no-secret backup 矩阵。

## 第一方依据

- AgentBean 总纲与现有实现：上述 GitHub main 源码链接。
- Apple launchd 登录用户 Agent 边界：
  https://developer.apple.com/library/archive/documentation/MacOSX/Conceptual/BPSystemStartup/Chapters/CreatingLaunchdJobs.html
- systemd user service 与 stop/退出语义：
  https://www.freedesktop.org/software/systemd/man/latest/systemd.service.html
- Windows Task Scheduler InteractiveToken：
  https://learn.microsoft.com/en-us/windows/win32/taskschd/taskschedulerschema-logontype-principaltype-element
- Windows Credential Manager 当前 token credential set：
  https://learn.microsoft.com/en-us/windows/win32/api/wincred/nf-wincred-credreadw
- npm 全局安装目录与可执行入口：
  https://docs.npmjs.com/cli/v11/configuring-npm/folders
