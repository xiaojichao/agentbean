# Agent 拉起：路由、PTY/pipe、异步审批

## 何时适用

新增 agent adapter、改 `runCustomAgentCommand` 路由、动 `ARGV_MODE_ADAPTERS` / `PTY_ADAPTERS`、调 codex PTY 参数、碰到「agent 跑了但没产出」或「dispatch 卡在交互审批」类问题。

## 路由总览

入口是 `runCustomAgentCommand`（`src/executor.ts:100`，被 :52 的 dispatch 处理调用）。它按 `customAgent.adapterKind` 决定走哪条路：

1. **PTY 路径**：先查 `PTY_ADAPTERS`（`src/executor-pty.ts`）。命中（目前只有 codex）就调 `runPtyAgentCommand`，**在此分支 return，不再碰 stdin**（`src/executor.ts:115-118`）。原因：codex 是交互 TUI，关掉 stdin 会让它打 banner 然后 exit 0 不跑查询（静默失败）——见 `src/executor-pty.ts:3-5` 头注释。
2. **ARGV-mode 路径**：否则查 `ARGV_MODE_ADAPTERS`（`src/executor.ts:123`、定义在 `:641`）。命中（hermes、openclaw、claude-code）走 pipe-stdio，但 prompt 落 argv 还是 stdin 由 `promptOnStdin` 决定（`:128`）。
3. **通用 stdin 路径**：未注册的 adapterKind（codex/gemini/kimi-cli……）走通用 stdin 契约。`src/executor.ts:640` 注释标注「audit pending」——这几个 adapter 仍按通用 stdin 处理，没专文契约。

## 本地模式

### 三种 prompt 落点

- **argv**：`ARGV_MODE_ADAPTERS` 注册且 `promptOnStdin !== true`。典型 hermes（`-z` / `-q` oneshot，`src/executor.ts:290`/`:302`）、openclaw（`agent --agent <id> --message`）。
- **stdin（带 joined history）**：`ARGV_MODE_ADAPTERS` 注册且 `promptOnStdin === true`。典型 claude-code `-p`（`src/executor.ts:654`）。
- **stdin（裸 prompt）**：未注册 adapterKind。`promptPayload = request.prompt`（`src/executor.ts:126`，argvMode=false 分支）。

`buildAdapterPrompt`（拼 joined history）与 `buildHermesArgs` 等 per-adapter 构造器在 `src/executor.ts` 内定义，注册时挂到 `ARGV_MODE_ADAPTERS`。

### 异步审批陷阱（核心约束）

AgentBean dispatch 没有交互审批通道——agent 跑在后台、用户不在线。所以每个 adapter **必须**有非交互入口，否则 agent 会卡在工具审批（`[o/s/d]` 类提示）永远挂住。两条已验证的绕过方式：

- **argv-mode oneshot**：hermes 默认 `buildHermesArgs` 在无 args 时落 `-z` oneshot（`src/executor.ts:285-290`），非交互直接出结果。openclaw 走 `agent --agent <id> --message`。
- **PTY bypass**：codex PTY 路径在 `src/executor-pty.ts:64-65` 强制注入 `--dangerously-bypass-approvals-and-sandbox`（若 argv 没带就 push）。这是 codex 在异步 dispatch 能跑的前提。

**没有非交互入口的 agent 无法在异步 dispatch 跑**。kimi-cli 被标记不兼容：它在 `src/executor-helpers.ts:479` 仅出现在 `adapterNeedsCodingRuntimeSecrets` 的 `kimi-cli` case（:472），没有任何 argv-mode / PTY 注册，落通用 stdin 契约且没有审批绕过——不要假设它能异步出活。

### 加新 adapter 的清单

1. 确认它有非交互入口（oneshot flag 或 bypass flag）。没有就别接，会在 dispatch 挂死。
2. 选注册位：TUI/TTY-only → `PTY_ADAPTERS`（`src/executor-pty.ts`）；能吃 pipe → `ARGV_MODE_ADAPTERS`（`src/executor.ts:641`），写 `buildArgs` + 决定 `promptOnStdin`。
3. 如果它在通用 stdin 列表里残留（codex/gemini/kimi-cli 注释，`src/executor.ts:639-640`），注册后从「audit pending」说明里剔除或补注。
4. 需要 coding runtime secrets 的，同步 `src/executor-helpers.ts:472` 的 `adapterNeedsCodingRuntimeSecrets`。

## 佐证文件

- `apps/daemon-next/src/executor.ts:52,100,115-130,280-302,639-654`（路由、`ARGV_MODE_ADAPTERS`、hermes oneshot）
- `apps/daemon-next/src/executor-pty.ts:1-12,51-65`（codex PTY、bypass flag）
- `apps/daemon-next/src/executor-helpers.ts:472,479`（`adapterNeedsCodingRuntimeSecrets`、kimi-cli）

## 反模式

- **给 codex 走 pipe-stdin**：头注释（`src/executor-pty.ts:3-5`）明确——关 stdin 会让 codex 打 banner 后 exit 0 静默失败。codex 必须留 PTY 路径。
- **加 adapter 不接非交互入口**：dispatch 会卡在工具审批。kimi-cli 即为前车之鉴。
- **绕过 `ARGV_MODE_ADAPTERS` 自己拼 argv**：路由与 prompt 落点全靠这张表，分叉会导致 history 拼接和 stdin/argv 误配。
- **删 `--dangerously-bypass-approvals-and-sandbox` 注入**（`src/executor-pty.ts:64`）：删了 codex 在 dispatch 会弹审批挂死。

## 验证命令

```bash
# 路由表与 PTY 早返回
cd apps/daemon-next && grep -nE 'runCustomAgentCommand|PTY_ADAPTERS|ARGV_MODE_ADAPTERS|promptOnStdin' src/executor.ts
# codex 审批绕过
grep -nE 'dangerously-bypass|oneshot|exec' src/executor-pty.ts
# hermes oneshot
grep -nE "'-z'|'-q'|buildHermesArgs" src/executor.ts
# kimi-cli 仅在 secrets 判定，无路由注册
grep -rn 'kimi-cli' src/
```
