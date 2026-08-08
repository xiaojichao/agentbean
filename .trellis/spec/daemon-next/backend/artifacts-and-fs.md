# 产出物收集、reported 路径、fs:read 白名单

## 何时适用

动 agent 产出物收集（artifact-collector）、改 reported 路径递归、动 fs:read / fs:list、改 `AGENTBEAN_OUTPUT_DIR` 注入、调产出文件类型/大小过滤、排查「agent 产出了但没收到」或「fs:read 拒绝合理路径」。

## AGENTBEAN_OUTPUT_DIR 注入

每个 agent 子进程的环境变量由 `workspaceRunEnv(ws)`（`src/workspace-run.ts:282`）构造，其中 `:287` 注入 `AGENTBEAN_OUTPUT_DIR: ws.outputDir`。agent（或其包装）把产出写到这个目录，collector 再从中扫描。**所有 agent 共用同一注入路径**，不要在 executor 里另写一份 env。

## reported 路径递归收集

`src/artifact-collector.ts` 负责 reported 路径收集。核心流程：

- 入口判定路径是文件还是目录：`stat.isDirectory()`（`:680`）。目录则递归 `collectReportedDirectory`（`:681`，定义在 `:751`）。
- 递归用栈式遍历 + `readdirSync(current, { withFileTypes: true })`（`:765`，文件收集的同款调用见 `:391`）。`Dirent` 直接判类型，不做二次 `stat`。
- 每文件过 `ADAPTER_OUTPUT_FILE_EXT_RE`（`:17` 定义为 `/\.(png|jpe?g|gif|webp|svg|pdf|txt|md|mp4|mov|zip)$/i`，`:685` 处过白名单）、mtime 窗、size 上限、sha256 去重。
- 拒绝（扩展名不符、超限等）发 `REPORTED_PATH_REJECTED`（错误码枚举见 `:200`，拒绝逻辑 `:639`），并通过 `reject(basename(...))`（`:671`、`:686` 等）只泄 basename。

### basename-only 诊断（隐私铁律）

`src/artifact-collector.ts:642` 注释明文：「只暴露 basename：诊断行会随 run 回报上 Server，不得泄露本机目录结构」。所有 reject / 诊断路径都走 `basename(...)`（`:671`、`:697`、`:809`）。**不要在诊断里回绝对路径或父目录**——这些会进 server，泄露用户机器目录结构。

## reported 提取两关（extractReportedOutputPaths）

reported 路径在进入收集前先过两道提取关，**任一关拒都静默返回空**（无诊断），排查「agent 报了路径但没卡片」先怀疑这里：

1. **交付语境**（`isDeliveryContextAt`）：路径所在分句含交付词（`DELIVERY_CONTEXT_RE`，含「文件路径」行内标签）；或冒号收尾声明行 + 换行后**裸路径行**（整行仅路径+收尾标点，免词表——agent 措辞变体如「已经生成在：」不可枚举）；或交付标题小节。引用词（参考/来源/引用）同行或上一行时优先拒。
2. **结构校验**（`isPlausibleReportedPath`）：绝对路径、无 `..`、隐藏段白名单 `AGENT_DATA_DIRS`（只放行 `.hermes`/`.openclaw`，其余 dotfile 段拒）、扩展名白名单（目录路径免扩展名）。

**reported vs scan 守卫分离**：reported 信任 agent 声明（白名单放行已知 agent 数据目录）；scan（adapter 根/output-dir）走 `skipHidden` 一刀切，防 daemon 主动扫数据目录泄漏 sessions。`isCollectableReportedBase(realPath, excluded, trustReported)` 的 `trustReported` 参数区分两通道（reported=true）。

**kind 决定去向**：reported 产物 kind=`run_output` → 进 staging（卡片链路的唯一入口之一）；adapter 根扫描产物 kind=`adapter_generated` → 只走 legacy upload，**永远不出卡片**（`index.ts` `projectionRunOutputs` 只 filter `run_output`）。

**home 相对路径先展开**：Agent 常报告 `~/Desktop/...`；`extractReportedOutputPaths` 必须用 daemon 本轮解析出的 `homeDir` 展开为绝对路径后再过结构/realpath 闸，不能把其中的 `/Desktop/...` 截成根目录路径。

**交付目录提示只在真实 executor 边界注入**：`AGENTBEAN_OUTPUT_DIR` 的说明与绝对路径由 command executor 追加到运行时 prompt，不改 socket dispatch 的原始 prompt，也不污染 echo stub、结果指纹或 Server 消息正文。

## fs:read：白名单（非黑名单）

`src/file-reader.ts` 实现 #1084 切片3 的「本机 snapshots 副本单文件字节读取」（频道文件预览/下载本机优先）。它是**白名单语义**，与 `directory-lister.ts` 的 denylist 语义**结构性不同**，不可合并。头注释（`src/file-reader.ts:14-17`）专门强调这点。

### 合法 root

入参 `path` resolve 后必须落在 `~/.agentbean/workspaces/<teamId>/channels/<channelId>/snapshots/<revisionId>/` 子树内（`src/file-reader.ts:9-11`、`:92` 的 `snapshotRoot` 计算）。`teamId` / `channelId` / `revisionId` 走 safe-segment 校验，无法夹带 `..` / `/`。

### 四道闸（`src/file-reader.ts:84-101`）

1. 闸 1-2（:84/:88）：safe-segment 与 resolve 阶段，越界直接 `OUTSIDE_SNAPSHOTS`。
2. 闸 3（:95-97）：lexical containment——resolve 消解 `..` 后确认 target 落在 snapshotRoot 子树。
3. 闸 4（:100-101）：realpath containment——防符号链接逃逸（snapshotRoot 中间段或 target 叶子是符号链接指向外）。

越界一律返 `OUTSIDE_SNAPSHOTS`（专用码，`src/file-reader.ts:39`），**区别于「文件不存在」**。路径不存在时 `realpathSync` 抛 ENOENT 归一为 `PATH_NOT_FOUND`，不暴露「是文件但越界」与「不存在」的区别。

### 上限

`MAX_READ_FILE_BYTES = 10 * 1024 * 1024`（10 MiB，`src/file-reader.ts:23`）。

### 为什么 denylist 在此失效

`directory-lister.ts` 的 denylist（`.ssh`/`.aws/...`）依赖「列出用户 home 下要遮蔽的目录」。但 fs:read 的 root 恒位于 `agentBeanHome/workspaces/<team>/<channel>/snapshots/<rev>/`，与用户 home 下的凭证目录不相交（`src/file-reader.ts:16-17`）。所以这里用结构性白名单——不在 snapshots 子树就拒——比 denylist 更强且不会漏。

## 本地模式

- **reported 收集要递归**：collector 已支持目录（`collectReportedDirectory`），agent 把产物放子目录也能收到，**不要**在外层再 flatten。
- **新增可收产出扩展名**：改 `ADAPTER_OUTPUT_FILE_EXT_RE`（`:17`），同步跑 `tests/artifact-collector.test.ts`。
- **改 fs:read 容量**：改 `MAX_READ_FILE_BYTES`（`:23`），同步测 `tests/file-reader.test.ts` 的超限用例。
- **诊断只能 basename**：新增任何 reject 分支都用 `basename(...)`，不要把 `realPath` / `absPath` 直接塞进诊断。

## 佐证文件

- `apps/daemon-next/src/workspace-run.ts:282,287`（`workspaceRunEnv`、`AGENTBEAN_OUTPUT_DIR`）
- `apps/daemon-next/src/artifact-collector.ts:17,200,391,639-642,671,680-686,697,751,765,809`（递归、basename-only、拒绝码）
- `apps/daemon-next/src/file-reader.ts:9-17,23,39,84,88,92,95-97,100-101`（白名单、四闸、OUTSIDE_SNAPSHOTS、MAX_READ）
- `apps/daemon-next/tests/artifact-collector.test.ts`（reported 递归）
- `apps/daemon-next/tests/file-reader.test.ts`（白名单遏制、符号链接逃逸、sha256）

## 反模式

- **在诊断/拒绝里回绝对路径**：违反 basename-only（`:642`），会泄露本机目录结构到 server。
- **把 fs:read 的白名单与 directory-lister 的 denylist 合并**：语义不同（头注释 `src/file-reader.ts:14-17`），合并会让 snapshots 子树外的合法列出被错误放行或合法读取被错误拒绝。
- **改 reported 路径但不动 `ADAPTER_OUTPUT_FILE_EXT_RE`**：新扩展名产出的文件会被静默拒（`REPORTED_PATH_REJECTED`），看起来「agent 产出了但没收到」。
- **绕过 realpath 闸**（`:100`）：lexical containment 过了不代表安全，符号链接逃逸只能靠 realpath 抓。删了闸 4 会让 `snapshots/<rev>/evil -> /etc` 类链接把敏感文件读出去。
- **在 executor 里另注入 OUTPUT_DIR**：统一走 `workspaceRunEnv`（`:287`），分叉会让 collector 找不到产物。

## 验证命令

```bash
# 确认递归收集入口
cd apps/daemon-next && grep -nE 'collectReportedDirectory|withFileTypes|isDirectory' src/artifact-collector.ts
# 确认 basename-only 诊断
grep -nE 'basename\(|REPORTED_PATH_REJECTED|只暴露' src/artifact-collector.ts
# 确认 fs:read 四闸与白名单
grep -nE 'OUTSIDE_SNAPSHOTS|realpath|lexical|snapshotRoot|MAX_READ_FILE_BYTES' src/file-reader.ts
# 跑产出与文件读取测试
npm run test:daemon-next -- tests/artifact-collector.test.ts tests/file-reader.test.ts
```
