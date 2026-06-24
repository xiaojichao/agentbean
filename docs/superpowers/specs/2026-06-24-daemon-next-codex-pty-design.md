# daemon-next codex PTY 支持设计

- 日期：2026-06-24
- 范围：`apps/daemon-next`
- 目标组件：daemon-next executor 的 custom agent 命令执行链路（codex PTY 分支）
- 关联记忆：`daemon-next-tui-agent-stdin`（TUI agent stdin 审计）
- 旧契约参考：`apps/daemon/src/adapters/codex.ts`

## 1. 背景与目标

daemon-next 默认用 `spawn + child.stdin.end(prompt)` 喂所有 custom agent，假设 agent 是「读 stdin → 处理 → 打印 → 退出」的一次性 CLI。这个假设对**交互式 TUI/REPL agent 不成立**：codex 是 TUI，stdin 立即 EOF 会触发 TUI 直接退出或打印 banner 后 exit 0，banner 被当作成功结果 → **静默失败**。

hermes/openclaw/claude-code 已通过 `ARGV_MODE_ADAPTERS` / `promptOnStdin` 修复并部署。codex 是 `scanner.ts` 默认注册的三大 runtime 之一（与 claude-code/gemini 并列，`adapterKind` 默认值即为 `codex`），与 claude-code **同等频率、同等重要**，必须真正可跑而非显式降级。

codex 的调用契约（源自旧 `apps/daemon/src/adapters/codex.ts`）：

- prompt 走 **argv 位置参数**（末尾）
- 必须 **PTY**（`spawnPty`）——TUI 渲染依赖 TTY，pipe 模式不可靠
- `exec --skip-git-repo-check --output-last-message <file> --json`
- 回复优先从 `--output-last-message` 文件读取，fallback 用 `extractCodexReply` 解析 PTY 输出

### 成功标准

- codex dispatch 走 PTY 路径，argv 含 `exec` / `--skip-git-repo-check` / `--output-last-message <tmpfile>` / `--json` + payload。
- 回复优先读 `--output-last-message` 文件，fallback `extractCodexReply` 解析。
- node-pty 不可用时 codex 返回**明确错误**（显式失败，非静默成功）。
- payload 不出现在持久化的 `workspaceRun.command`（脱敏）。
- hermes/openclaw/claude-code/generic 路径**零回归**（现有测试全绿）。
- daemon-next CI（`--ignore-scripts`、Linux 无 `.node`）无需改动即可通过。

## 2. 基线

### 2.1 旧 daemon codex adapter（契约参考）

`apps/daemon/src/adapters/codex.ts`：

- `spawnRuntimeProcess`（L153-202）：`try { spawnPty } catch { spawnChild(pipe) }`——先 PTY、失败退化 pipe（优雅退化参考）。
- `normalizeExecArgs`（L80-102）：默认 `exec`，强制 `--skip-git-repo-check`、注入 `--output-last-message`、强制 `--json`。
- `extractCodexReply`（L47-59）：stripAnsi + removeEchoedPayload（PTY 回显去除）+ 匹配 `codex\n…` 标签或末尾 `user\n` 之后内容。
- `readOutputLastMessage`（L147-151）：优先读文件。
- `renderPayload`（L21-29）：`# system` / `# role: speaker` / `# user` 格式（extractCodexReply 依赖此标记）。
- 超时 `AGENTBEAN_CODEX_TIMEOUT_MS` 或 900s + SIGTERM → 2s → SIGKILL。

### 2.2 daemon-next executor 现状

`apps/daemon-next/src/executor.ts`：

- 单一 pipe spine：`spawn(cmd, args, {stdio:['pipe','pipe','pipe']})`。
- `ARGV_MODE_ADAPTERS`（L546）：hermes/openclaw/claude-code，`AgentAdapterSpec = {buildArgs, promptOnStdin?, redactCommandArgs?, extractReply?}`。
- 完善的取消/安全链路：超时 → SIGTERM → 宽限期 → SIGKILL（L105-122）、`maxAccumulatedBytes` 字节上限（L136）、`SAFE_ENV_KEYS` + `buildChildEnv` secrets 边界（L21-39）、`buildRedactedLog` / `buildLogArtifactContent` / `buildLogExcerpt` / `formatCommand`（L219-250）。
- `package.json`：依赖 `@agentbean/contracts` / `js-yaml` / `socket.io-client`，**无 node-pty**。

### 2.3 node-pty 可行性（spike 结论，2026-06-24）

| 场景 | 可行性 | 机制 |
|---|---|---|
| 本地开发（darwin-arm64） | ✅ 零编译 | `prebuilds/darwin-arm64` 包内自带 |
| 发布·macOS/Windows | ✅ 零编译 | prebuilds 自带 |
| 发布·Linux 用户 | ✅ 需编译工具链 | 无 linux prebuilt → `node-gyp rebuild` fallback |
| daemon-next CI（ubuntu + `--ignore-scripts`） | ⚠️ 需绕过 | 无 linux prebuilt + 跳过编译 = 无 `.node` |

关键证据：`node-pty@1.1.0` 的 install 脚本为 `node scripts/prebuild.js || node-gyp rebuild`，prebuilds 只覆盖 darwin/win（无 linux）。`--ignore-scripts` 跳过脚本后 darwin/win 仍有 prebuilds（require OK），但 Linux 无可用 `.node`。旧 `apps/daemon` 的 CI 用不带 `--ignore-scripts` 的 `npm ci`，故在 Linux 上走 node-gyp 编译成功。

## 3. 设计决策

| 决策 | 选定 | 理由 |
|---|---|---|
| codex 投入 | 完整 PTY 支持 | codex 与 claude-code 同等重要，必须真跑 |
| node-pty 定位 | 可选依赖 + lazy import | CI `--ignore-scripts` 下 Linux 无 `.node` 不影响非 codex 路径；不可用时显式失败 |
| PTY 融入方式 | 双路径 + `PTY_ADAPTERS` 注册表 | pipe 路径零回归；与 `ARGV_MODE_ADAPTERS` 对称；共享 helper 复用 |
| codex 是否进 ARGV_MODE_ADAPTERS | 否，独立 PTY 路径 | codex 契约需临时文件生命周期 / 读文件 / PTY spawn / payload 回显去除，超出 `{buildArgs, extractReply, redact}` 三件套 |
| 退化策略 | 显式失败（不退 pipe） | 用户已排除 pipe 退化；不可用 → 明确错误 result |
| CI 解法 | 零改动（lazy import 绕过） | codex 测试用 mock，不依赖真 `.node` |
| 超时 | 900s + `AGENTBEAN_CODEX_TIMEOUT_MS` 覆盖 | 沿用旧 adapter，代码生成任务常 >5min |
| 临时文件 | 读完即删 | 轻量，不留垃圾 |

## 4. 架构与组件

### 4.1 文件结构

- `executor.ts`：`ARGV_MODE_ADAPTERS`(pipe) 不变 + 新增 `PTY_ADAPTERS` + `runCustomAgentCommand` 开头委托分支；共享 helper 导出。
- `executor-pty.ts`（新）：`runPtyAgentCommand` + lazy import + codex 专属逻辑（移植自旧 codex.ts）。

### 4.2 PTY_ADAPTERS（与 ARGV_MODE_ADAPTERS 对称）

```ts
interface PtyAdapterSpec {
  normalizeArgs: (baseArgs: string[], outputPath: string) => { args: string[]; outputLastMessagePath?: string };
  renderPayload: (request: DispatchRequestPayload) => string;
  extractReply: (ptyOutput: string, payload: string, outputPath?: string) => string;
  redactCommandArgs?: (args: string[]) => string[];
  timeoutMs?: number;
}
const PTY_ADAPTERS: Partial<Record<AdapterKind, PtyAdapterSpec>> = {
  codex: { normalizeArgs, renderPayload, extractReply, redactCommandArgs, timeoutMs: 900_000 },
};
```

### 4.3 codex argv 构建（normalizeArgs，移植 normalizeExecArgs）

默认 `exec`（尊重 `e`）→ 强制 `--skip-git-repo-check` → 注入 `--output-last-message <tmpfile>`（用户未配时）→ 强制 `--json`。最终 argv = `[...normalizeArgs(args, tmpfile).args, payload]`。

### 4.4 数据流

```
dispatch → createCommandExecutor → runCustomAgentCommand
  → if adapterKind ∈ PTY_ADAPTERS:
      runPtyAgentCommand(request, spec):
        mkdtemp tmpfile
        argv = [...normalizeArgs(args, tmpfile).args, renderPayload(request)]
        const pty = await import('node-pty')      // lazy；失败 → 返回错误 result
        spawnPty(cmd, argv, { cwd, env: buildChildEnv(...), cols:80, rows:30 })
        onData 累积（超 maxAccumulatedBytes → SIGKILL）
        超时（spec.timeoutMs）→ SIGTERM → 宽限期 → SIGKILL
        onExit:
          exit=0 → reply = readOutputLastMessage(tmpfile) ?? extractReply(output, payload, tmpfile)
          exit≠0 → body = "codex exit N: <detail>", status=failed
          超时   → body = "codex 超时", status=failed
        读后删 tmpfile
        返回 DaemonDispatchResult { body, artifacts:[workspace-run.log], workspaceRun:{…} }
  → else if adapterKind ∈ ARGV_MODE_ADAPTERS: 现有 pipe argv 路径（零改动）
  → else: generic stdin pipe（零改动）
```

### 4.5 错误处理（显式失败，非静默）

- node-pty import 失败 → `body = "Codex 需要 PTY 运行时(node-pty)，当前环境不可用：<detail>"`、`status=failed`。
- codex exit≠0 → `body = "codex exit N: <stripped detail>"`、`status=failed`。
- 超时 → `body = "codex 超时"`、`status=failed`。
- 全部返回 `DaemonDispatchResult`，不 reject（守 executor 约定）。

### 4.6 共享 helper

PTY 路径复用 `executor.ts` 导出的：`buildChildEnv`（secrets 边界，**强制**——PTY 输出同样被记录上传）、`buildLogArtifactContent` / `buildLogExcerpt` / `buildRedactedLog` / `formatCommand`。超时 + SIGTERM→SIGKILL + maxBytes 移植并适配 PTY 的 onData 字符串模型（PTY 无 stderr 分离，stdout/stderr 混在同一 data 流）。

## 5. 测试策略

- **CI（mock 单元测试）**：注入假 spawnPty（lazy import 可替换），断言：
  - argv 含 `exec` / `--skip-git-repo-check` / `--output-last-message` / `--json` + payload。
  - `workspaceRun.command` 不含 payload（redact）。
  - `extractReply` 优先读 `--output-last-message` 文件，fallback 解析 PTY 输出（含回显 / ANSI）。
  - node-pty import 失败时返回显式错误 result（status=failed）。
  - exit≠0 / 超时 返回 failed body。
  - history 拼接进 payload。
- **本地 darwin（端到端）**：PTY 跑 fake node 脚本，验证 argv 落地 + 文件写入 + 回复读取（不依赖真 codex 二进制；若设备已装 codex 可补真端到端）。
- **回归**：现有 `executor.test.ts` 的 hermes/openclaw/claude-code/generic 测试全绿。

## 6. 风险与约束

- **CI 测试边界**：codex 端到端不在 CI（Linux 无 `.node`），只跑 mock。本地 darwin 补端到端。这是 lazy import 换来零 CI 改动的必然代价。
- **secrets 边界**：PTY 路径必须复用 `buildChildEnv` + `buildRedactedLog`，否则 host 密钥经 PTY 输出泄漏到日志 artifact。
- **node-pty 不可用退化**：显式失败（明确错误），不静默成功、不退 pipe。
- **Linux 用户安装**：发布后 Linux 用户需编译工具链（node-gyp fallback），与 apps/daemon 同款，已被接受。

## 7. 非目标（YAGNI）

- 不泛化成通用 PTY agent 框架（目前只有 codex；未来再加时再抽象）。
- 不改 `ARGV_MODE_ADAPTERS` 及现有 pipe 路径。
- 不改 daemon-next CI 配置。
- 不处理 kimi-cli（架构性不兼容，仅用户自配，非默认注册，另案）。

## 8. 验收标准

- [ ] codex dispatch 走 PTY，argv 含 exec / --skip-git-repo-check / --output-last-message / --json + payload。
- [ ] 回复优先读文件，fallback extractCodexReply。
- [ ] node-pty 不可用 → 显式失败（非静默）。
- [ ] payload 不在 workspaceRun.command。
- [ ] hermes/openclaw/claude-code/generic 零回归。
- [ ] daemon-next CI 无需改动即通过。
