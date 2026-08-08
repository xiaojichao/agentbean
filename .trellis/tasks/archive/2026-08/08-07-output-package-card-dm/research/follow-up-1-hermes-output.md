# Follow-up #1：xiao-mbp Hermes 不写 AGENTBEAN_OUTPUT_DIR 被守卫拒，xiao-mini 写 AGENTBEAN_OUTPUT_DIR 全链通

调查日期：2026-08-07
范围：只读代码调查（不动代码，仅 research/ 落盘）
配套实证：`channel-triage.md`（已用 server DB 取证的三频道对照）

---

## TL;DR（结论先行）

- **daemon 确实把 `AGENTBEAN_OUTPUT_DIR` 通过 env 传给了 Hermes 子进程**（`index.ts:1080` → `executor.ts:137` → `executor-helpers.ts:245`）。daemon 这一侧没有欠传。
- **Hermes 是外部独立应用**（AgentOS oneshot 网关，非 AgentBean 仓库代码）。daemon 设计上明知 Hermes 不读这个 env：`index.ts:456-459` 注释明写「agentos-hosted（Hermes/OpenClaw）原生产物目录：它们不写 AGENTBEAN_OUTPUT_DIR，而是落到自己的数据目录」。
- **scan / reported 双通道在 daemon 代码里是确定且对称的**（`index.ts:1649-1668` + `artifact-collector.ts:217-273/561-573`）。两台机器的 daemon 版本（0.3.39 / 0.3.37）所对应的这条逻辑自 #1038（0.3.26）/ #1051 / #1053 起未变，差异不在 daemon 版本。
- **真正分水岭在 Hermes 应用本身**：
  - xiao-mini 的 Hermes 把交付文件写进 `AGENTBEAN_OUTPUT_DIR`（= 受管 `run_output` 投影），走 output-dir 扫描通道，**不经过** hidden-segment 守卫 → 卡片出现。
  - xiao-mbp 的 Hermes 把交付文件写进 `~/.hermes/…`，不在 scan 三根覆盖范围内（`~/.hermes` 顶层非递归 + `~/.hermes/output` 递归 + `~` 顶层 createdInWindow），只能靠 reported-path 通道；reported-path 在两道关都被 hidden-segment 守卫拦截（`.hermes` 段以 `.` 开头）→ 卡片不出现。
- **修复层结论**：daemon 代码侧不应动（放宽 hidden-segment 守卫破坏安全不变量、扩 scan 递归会泄漏 Hermes 内部状态）。**修复必须在 device 端**：升级/配置 xiao-mbp 的 Hermes 应用，让其把交付文件写到 (a) `AGENTBEAN_OUTPUT_DIR`（首选，对齐 xiao-mini），或 (b) `~/.hermes/output/`（次选，已在 scan 覆盖内）。

---

## 1. daemon 怎么给 Hermes 传 AGENTBEAN_OUTPUT_DIR

### 1.1 env 构造链路（4 步全证据）

**Step 1 — `workspaceRunEnv(ws)` 把 outputDir 写进 env**：
`apps/daemon-next/src/workspace-run.ts:282-289`
```ts
export function workspaceRunEnv(ws: WorkspaceRunDir): Record<string, string> {
  return {
    AGENTBEAN_RUN_ID: ws.runId,
    AGENTBEAN_WORKSPACE: ws.runDir,
    AGENTBEAN_INPUT_DIR: ws.inputDir,
    AGENTBEAN_OUTPUT_DIR: ws.outputDir,   // ← line 287
  };
}
```
`ws.outputDir = join(runDir, 'outputs')`，`runDir` 来自 `prepareChannelWorkspaceRun()`（`workspace-run.ts:168-211`），**始终是绝对路径**（由 channelProjectionRoot 拼出）。

**Step 2 — dispatch 执行前把 workspaceRunEnv 合并进 `request.customAgent.env`**：
`apps/daemon-next/src/index.ts:1077-1082`
```ts
if (request.customAgent && workspace) {
  request.customAgent = {
    ...request.customAgent,
    env: { ...(request.customAgent.env ?? {}), ...workspaceRunEnv(workspace) },  // ← line 1080
  };
}
```

**Step 3 — executor 用 `customAgent.env` 作为子进程 env 的 customEnv 入参**：
`apps/daemon-next/src/executor.ts:135-141`
```ts
const child = spawn(customAgent.command as string, finalArgs, {
  cwd: customAgent.cwd,
  env: buildChildEnv(process.env, customAgent.env ?? undefined, {   // ← line 137
    includeCodingRuntimeSecrets: adapterNeedsCodingRuntimeSecrets(customAgent.adapterKind),
    commandPath: typeof customAgent.command === 'string' ? customAgent.command : undefined,
  }),
  stdio: ['pipe', 'pipe', 'pipe'],
});
```

**Step 4 — `buildChildEnv` 把 customEnv 整体并入子进程 env（无白名单过滤）**：
`apps/daemon-next/src/executor-helpers.ts:245-253`
```ts
const merged = { ...env, ...(customEnv ?? {}) };   // ← line 245：customEnv（含 AGENTBEAN_OUTPUT_DIR）整体并入
// After customEnv: ensure `node` is resolvable. …
merged.PATH = ensureNodeOnPath(merged.PATH, merged.HOME ?? sourceEnv.HOME, { … });
return merged;
```
注意：`buildChildEnv` 只对 `sourceEnv`（即 `process.env`，LaunchAgent 的最小 env）做 `SAFE_ENV_KEYS` 白名单过滤（`executor-helpers.ts:217-224`），**customEnv 不过滤**。因此 `AGENTBEAN_OUTPUT_DIR` 一定透传到 Hermes 子进程。

**测试佐证**：`apps/daemon-next/tests/workspace-run.test.ts:33`
```ts
expect(env.AGENTBEAN_OUTPUT_DIR).toBe(ws.outputDir);
```

### 1.2 结论

> daemon **确实**把 `AGENTBEAN_OUTPUT_DIR` 通过 env 传给了 Hermes 子进程。xiao-mbp 收不到这个 env 的可能性可以排除——Hermes 子进程的 env 里一定有这个键，值是 `~/.agentbean/.../runs/<agentId>/<taskId>/<attempt>/<runId>/outputs` 这种绝对路径。

---

## 2. Hermes adapter 启动机制

### 2.1 Hermes 是外部应用，不是 AgentBean 代码

`apps/daemon-next/src/executor.ts:116-124` 的注释明确：
> Some agents are interactive TUIs/REPLs by default: feeding the prompt via stdin and closing the pipe makes them echo the input then exit on EOF (Hermes prints "Goodbye!") without ever running the query. Such agents expose a one-shot mode that carries the prompt on argv instead (**Hermes: `-z`**, OpenClaw: `agent --agent <id> --message`).

`ARGV_MODE_ADAPTERS` 注册表（`executor.ts:641-659`）：
```ts
const ARGV_MODE_ADAPTERS: Partial<Record<AdapterKind, AgentAdapterSpec>> = {
  hermes: {
    buildArgs: buildHermesArgs,
    redactCommandArgs: redactHermesCommandArgs,
    extractReply: extractHermesReply,
  },
  openclaw: { … },
  'claude-code': { … },
};
```

`buildHermesArgs`（`executor.ts:280-303`）默认走 `-z` oneshot（非交互、自动放行工具审批）：
```ts
if (!hasChat && !hasQuery) {
  return [...runtime, '-z', prompt];   // ← line 290
}
```

子进程 `cwd` = `customAgent.cwd`（`executor.ts:136`）——这是**设备端 custom Agent 配置**，daemon 不改写。

### 2.2 daemon 对 Hermes 输出行为的认知（关键）

`apps/daemon-next/src/index.ts:456-459` 注释：
```ts
// agentos-hosted（Hermes/OpenClaw）原生产物目录：它们不写 AGENTBEAN_OUTPUT_DIR，
// 而是落到自己的数据目录，因此作为 adapter 默认 source root 参与 mtime 过滤收集。
const hermesHomeDir = join(home, '.hermes');
const openclawHomeDir = join(home, '.openclaw');
```

> daemon 设计上**明知 Hermes 不读 AGENTBEAN_OUTPUT_DIR**，所以额外把 `~/.hermes` 作为 adapter 默认扫描根。这是「legacy Hermes 行为」的兼容设计，不是 daemon 漏传 env。

### 2.3 结论

> Hermes 是**外部应用**（AgentOS oneshot 网关），其是否读 `AGENTBEAN_OUTPUT_DIR` 取决于 Hermes 应用自身版本/配置，daemon 只负责传 env + 提供 fallback 扫描根。两台机器的 daemon 行为一致；差异在 Hermes 应用本身。

---

## 3. scan vs reported 双通道（关键）

### 3.1 scan 通道（resolveAdapterOutputRoots，三根）

`apps/daemon-next/src/index.ts:1649-1668`
```ts
function resolveAdapterOutputRoots(
  adapterKind: string | undefined,
  dirs: { homeDir: string; hermesHomeDir: string; openclawHomeDir: string },
): AdapterOutputRoot[] {
  if (adapterKind === 'hermes') {
    return [
      { dir: dirs.homeDir, recursive: false, createdInWindow: true },          // ① ~ 顶层，非递归，仅 birthtime 在窗口内
      { dir: dirs.hermesHomeDir, recursive: false },                            // ② ~/.hermes 顶层，非递归
      { dir: join(dirs.hermesHomeDir, 'output'), recursive: true },             // ③ ~/.hermes/output，递归
    ];
  }
  …
}
```

`collectArtifacts` 对 adapterRoot 的 ingest 参数（`artifact-collector.ts:529-541`）：
```ts
for (const adapterRoot of input.adapterOutputRoots ?? []) {
  await ingest(
    adapterRoot.dir,
    adapterRoot.dir,
    true,                                  // timeFilter = true（mtime > startedAt）
    makeSourceRoot('adapter_generated', 'Agent 默认输出目录', adapterRoot.dir),
    'run_output',
    adapterRoot.recursive,                 // recursive：根①②=false，根③=true
    false,                                 // reportRootFailure
    ADAPTER_OUTPUT_FILE_EXT_RE,            // 扩展名白名单（png/jpg/pdf/txt/md/mp4/zip…）
    true,                                  // skipHidden = true
    adapterRoot.createdInWindow,           // createdInWindow：根①=true，根②③=false
  );
}
```

**三根的实际覆盖**：
| 根 | 路径 | recursive | createdInWindow | 覆盖的文件 |
|---|---|---|---|---|
| ① | `~` | false | true（birthtime） | 主目录**顶层**、本次 run 期间**新建**的文件（mtime 过滤 + birthtime 过滤） |
| ② | `~/.hermes` | false | false（仅 mtime） | `~/.hermes` **顶层**文件（不进任何子目录） |
| ③ | `~/.hermes/output` | true | false | `~/.hermes/output/**` 全部 mtime 在窗口内的文件 |

**不被 scan 覆盖的位置**（关键盲区）：
- `~/.hermes/<任意子目录>/foo.md`（如 `~/.hermes/profiles/opensns/skills-inventory.md`、`~/.hermes/sessions/<id>/.md`）——根②非递归看不到，根③只看 `output/`。
- `~/<任意子目录>/foo.md`（如 `~/Documents/foo.md`、`~/AI_News/2026/foo.md`）——根①非递归看不到。
- `~/Desktop/foo.md`——根①能看到，但要求 birthtime 在 run 窗口内（如果文件早就存在只是被改写，birthtime 不会更新 → 漏）。

`shouldCollectWindowedFile` 的 birthtime 语义见 `artifact-collector.ts:136-`，createdInWindow=true 的根只收"窗口期内新建"的文件，避免其他进程修改的既有文件被当产物。

### 3.2 reported 通道（extractReportedOutputPaths + isCollectableReportedBase）

**Step 1 — 从回复正文提取候选路径**：`artifact-collector.ts:217-273`，按 6 个正则扫（QUOTED/UNIX/WINDOWS × 文件/目录）。

**Step 2 — 结构校验（提取时第一道关）**：`isPlausibleReportedPath`（`artifact-collector.ts:276-286`）
```ts
function isPlausibleReportedPath(raw: string): boolean {
  if (!raw || raw.startsWith('//') || raw.endsWith('.') || raw.includes('..')) return false;
  const isWindows = /^[A-Za-z]:[\\/]/.test(raw);
  if (!isWindows && !raw.startsWith('/')) return false;
  const segments = raw.split(isWindows ? /[\\/]/ : '/');
  // 隐藏路径段（.ssh/.gnupg/.agentbean 等）永不进入候选。
  if (segments.some((segment) => segment.startsWith('.'))) return false;   // ← line 282
  if (/[\\/]$/.test(raw)) return true;
  return ADAPTER_OUTPUT_FILE_EXT_RE.test(raw);
}
```
**`~/.hermes/...` 在这一步就被丢弃**——根本不会进入 `reportedOutputPaths` 数组。

**Step 3 — 收集时第二道关（realpath 后）**：`isCollectableReportedBase`（`artifact-collector.ts:561-573`）
```ts
function isCollectableReportedBase(realPath: string, excludedPrefixes: readonly string[]): boolean {
  const base = reportedPathBasename(realPath);
  const segments = realPath.split(/[\\/]/);
  if (segments.some((segment) => segment.startsWith('.'))) return false;   // ← line 566
  if (SENSITIVE_REPORTED_BASENAME_RE.test(base)) return false;
  const normalizedPath = realPath.replaceAll('\\', '/');
  for (const prefix of excludedPrefixes) {
    const normalizedPrefix = prefix.replaceAll('\\', '/');
    if (normalizedPath === normalizedPrefix || normalizedPath.startsWith(`${normalizedPrefix}/`)) return false;
  }
  return true;
}
```
即便第一步漏过（不可能，但假设），realpath 后的 `.hermes` 段依然会在第二道关拒收。同时 daemon 还会把 `agentBeanHome`（`~/.agentbean`）作为 excludedPrefix 传入（`index.ts:1131-1133`），保险。

`isPlausibleReportedPath` + `isCollectableReportedBase` 双关的设计目的见注释（`artifact-collector.ts:555-560`）：「隐藏路径段（.ssh/.gnupg/.config 等）与 .agentbean 内部永不发布」——这是**安全不变量**，防内部状态泄漏。

### 3.3 xiao-mbp 为什么走 reported 而非 scan

根据 `channel-triage.md` 实证：
- 频道1 05:37 dispatch：Hermes 报告 `/Users/shaw/.hermes/hermes-skills-index.md` —— 在 `~/.hermes` 顶层，**理论上根②能扫到**。
- 频道2：Hermes 报告 `/Users/shaw/.hermes/profiles/opensns/skills-inventory.md` —— 在 `~/.hermes/profiles/` 子目录，**根②非递归扫不到，根③只看 output/**。

但两个 case 都没收集到。原因有二（按可能性排序）：

1. **Hermes 报告路径 ≠ 实际落盘路径**：Hermes 回复正文里写出 `/Users/shaw/.hermes/hermes-skills-index.md`，但实际文件可能落在 `~/.hermes/<run-id>/hermes-skills-index.md` 之类的子目录（Hermes 内部 sessions/runs 结构），只是回复时显示了规范化的"友好路径"。scan 三根都看不到那个子目录，reported 通道又因 hidden 段拒收 → 全链断。
2. **文件 birthtime/mtime 早于 startedAt**：根②（`~/.hermes` 顶层，timeFilter=true，createdInWindow=false）只过滤 mtime；如果 Hermes 实际是把既有文件原地覆盖（mtime 可能因为 fs 写策略没更新到 startedAt 之后），scan 也会漏。

但无论哪种，**reported 通道一定拒**（hidden 段守卫是硬关）。所以 xiao-mbp 的文件被 `isCollectableReportedBase` 拒是确定性事件，不是偶然——这是 task 标题描述的现象的根因。

> **关键澄清**：task 标题说"被 daemon 隐藏段守卫（`artifact-collector.ts:566 isCollectableReportedBase`）拒"。更精确地说，xiao-mbp 的路径在 `isPlausibleReportedPath`（line 282）就被拦了，根本没进入 reported 候选数组；`isCollectableReportedBase`（line 566）是 realpath 之后的第二道同语义守卫，作用是防 symlink 逃逸。两道关都拒 hidden 段，结果一致。

### 3.4 xiao-mini 为什么全链通

根据 `channel-triage.md` 频道3 实证：
- Hermes 交付文件 `skills-summary.md` 以**相对路径**出现在 output-package 成员里（source_path 不是绝对路径）。
- 这说明文件**来自 output-dir 扫描**（`artifact-collector.ts:517-518`，受管 `run_output` 通道），**不是** reported-path 通道。
- output-dir 扫描的根是 `workspace.outputDir`（即 `AGENTBEAN_OUTPUT_DIR` 的值），ingest 时 sourceRoot.kind = `run_output`，**完全不经过 `isPlausibleReportedPath` / `isCollectableReportedBase`**——因为这是 daemon 自己创建、自己扫描的受管目录，安全模型上信任。

> 即 **xiao-mini 的 Hermes 应用实际上把文件写进了 `AGENTBEAN_OUTPUT_DIR`**（尽管 `index.ts:456-459` 注释说 Hermes 不写——那条注释描述的是 legacy 行为；xiao-mini 上装的 Hermes 版本显然读了 env，或者通过 customAgent.cwd 配置让默认相对输出落进了 runDir/outputs）。

频道3 回复正文里也提到过 `/Users/xiao/hermes-docs/20260807/skills-summary.md`（**非隐藏**绝对路径，**会通过** hidden 段守卫）。但最终 package 只冻结了 1 个成员，是 output-dir 副本胜出（sha256 dedup，managed run_output 优先级高于 reported，见 `artifact-collector.ts:611-668` 的 isManagedRunOutput 判谓 + 移除旧条目逻辑）。这进一步证明 xiao-mini 的 Hermes 同时往两个位置写了相同内容，daemon 选了受管那份。

---

## 4. xiao-mbp vs xiao-mini 差异归属

### 4.1 daemon 版本差异（不相关）

| 设备 | daemon 版本 | 备注 |
|---|---|---|
| xiao-mbp | 0.3.39 | 比 main 的 package.json（0.3.38）还新，可能是预发版 |
| xiao-mini | 0.3.37 | 略旧于 main |

**两者都包含相关逻辑**：
- #1038（0.3.26，`65931c18`）"修复 AgentOS 产物收集漏掉主目录顶层交付文件" —— 加入根①（`~` 顶层 createdInWindow）。
- #1050/#1052（`d230f602`/`79d5b46a`，0.3.27-28）reported-path 接入受控发布 + 优先级。
- #1054（`628de2b8`）reported-path 安全缺口收口（hidden 段守卫强化）。
- #1085（`7536427a`，0.3.29+）reported-path 支持目录递归收集。

xiao-mini 的 0.3.37 早于 #1085 但**晚于** #1054——hidden 段守卫已经存在。如果 xiao-mini 的 Hermes 也写 `~/.hermes/...`，0.3.37 一样会拒。**所以差异不在 daemon**。

### 4.2 Hermes 应用本身（真正差异源）

`index.ts:456-459` 的注释"它们不写 AGENTBEAN_OUTPUT_DIR"是**设备无关的 legacy 行为描述**。两台机器装的 Hermes 应用版本/配置不同：

- **xiao-mini 的 Hermes**：会把交付文件写进 `AGENTBEAN_OUTPUT_DIR`（要么应用版本新到会读这个 env，要么 customAgent.cwd 被配置成 runDir、Hermes 默认相对输出就落进了 `outputs/`）。这是符合 daemon 期望的"新行为"。
- **xiao-mbp 的 Hermes**：保持 legacy 行为，文件落在 `~/.hermes/...` 自己的数据根。

`customAgent.command / args / cwd / env` 都是**设备端 custom Agent 配置**（scanner 从设备本机扫描得到的，server 派发时透传）。daemon 不改写。两台设备的 Hermes 配置（command 路径、args、cwd）很可能也不同。

### 4.3 归属结论

> 差异**在 device 端的 Hermes 应用版本/配置**，**不在 daemon 代码**。daemon 侧的处理对两台设备是对称的——传同样的 env、跑同样的 scan 三根 + 同样的 reported 双关守卫。xiao-mini 的 Hermes "做对了"（写 AGENTBEAN_OUTPUT_DIR），xiao-mbp 的 Hermes "做错了"（写 ~/.hermes/）。

---

## 5. 修复层结论与推荐方案

### 5.1 daemon 代码侧可改的选项（**均不推荐**）

| 选项 | 做法 | 风险 |
|---|---|---|
| A. 放宽 hidden 段守卫 | 在 `isPlausibleReportedPath` / `isCollectableReportedBase` 给 `.hermes` 开后门 | **破坏安全不变量**。守卫防的是 `.ssh/.gnupg/.config/.agentbean` 内部状态泄漏。一旦开口子，下次别的 dotdir 跟风，语义崩塌。 |
| B. 把 `~/.hermes` 扫描改递归 | 改 `resolveAdapterOutputRoots` 根②为 `recursive: true` | **泄漏 Hermes 内部状态**（sessions/checkpoints/pairing/cache）。`index.ts:1638-1648` 注释明说"只扫描受限范围，避免把数据目录里的内部状态当作产物上传"。 |
| C. 新增 Hermes 专属适配器源根 | 在三根之外加 `~/.hermes/profiles/` 之类 | 同 B，且要随 Hermes 版本追每个新子目录，维护负担+泄漏面只增不减。 |

**结论：daemon 代码不应该动**。当前设计是深思熟虑的（注释完备、双关守卫、三根 scan 范围都有明确语义），改任何一处都破坏既定安全边界。

### 5.2 device 端修复（**推荐**）

按优先级：

**P1（首选）—— 升级 xiao-mbp 的 Hermes 应用，使其写 `AGENTBEAN_OUTPUT_DIR`**：
- 对齐 xiao-mini 的成功行为。
- 文件走受管 `run_output` 通道（output-dir 扫描），无 hidden 段守卫介入，最干净。
- 落地：在 Hermes 应用仓库加 `AGENTBEAN_OUTPUT_DIR` 支持（优先级高于 Hermes 自己的默认输出根），或在 xiao-mbp 的 custom Agent 配置里把 cwd 指到 runDir、让 Hermes 默认相对输出落进 `outputs/`。

**P2（次选）—— 配置 xiao-mbp 的 Hermes 把交付文件写到 `~/.hermes/output/`**：
- scan 根③（`~/.hermes/output`，recursive=true）会自动覆盖，无需走 reported。
- 落地：Hermes 应用的 output-dir 配置项，或 customAgent.args 里传 Hermes 的 output 标志。

**P3（兜底）—— 让 Hermes 把交付文件写到主目录顶层**（如 `~/hermes-skills-index.md`）：
- scan 根①（`~` 顶层 createdInWindow=true）会覆盖，但要求文件是本次 run 期间**新建**的（birthtime 在窗口内）。
- 不推荐：birthtime 语义脆弱（复制/覆盖文件不一定刷新 birthtime），且主目录顶层污染严重。

### 5.3 不改 daemon 的额外理由

- `index.ts:456-459` 的设计注释已经把责任划清：daemon 知道 Hermes 不写 AGENTBEAN_OUTPUT_DIR，所以提供了 `~/.hermes` scan 兜底。这是**双保险设计**，不是 bug。
- xiao-mini 的成功证明 daemon 链路本身没问题。把 xiao-mbp 的 Hermes 行为对齐 xiao-mini 即可，零代码改动。
- 如果未来 Hermes 应用长期不修，可考虑在 device 端加一层 wrapper 脚本（customAgent.command 指向 wrapper）：wrapper 启动 Hermes，结束后把 `~/.hermes/...` 下的交付文件 copy 进 `${AGENTBEAN_OUTPUT_DIR}`。这是 device 端桥接，不污染 daemon 主代码。

---

## 关键文件:行号速查

| 关注点 | 文件:行号 |
|---|---|
| env 里设 AGENTBEAN_OUTPUT_DIR | `apps/daemon-next/src/workspace-run.ts:287` |
| 把 workspaceRunEnv 合并进 customAgent.env | `apps/daemon-next/src/index.ts:1077-1082` |
| executor 用 customAgent.env 启动子进程 | `apps/daemon-next/src/executor.ts:135-141` |
| buildChildEnv 整体并入 customEnv（不过滤） | `apps/daemon-next/src/executor-helpers.ts:245` |
| daemon 明知 Hermes 不写 AGENTBEAN_OUTPUT_DIR | `apps/daemon-next/src/index.ts:456-459` |
| Hermes adapter 注册（ARGV_MODE_ADAPTERS） | `apps/daemon-next/src/executor.ts:641-646` |
| Hermes 默认 `-z` oneshot 启动 | `apps/daemon-next/src/executor.ts:280-303` |
| Hermes scan 三根定义 | `apps/daemon-next/src/index.ts:1649-1668` |
| scan 三根的 ingest 参数（recursive/createdInWindow/skipHidden） | `apps/daemon-next/src/artifact-collector.ts:529-541` |
| 受管 output-dir 扫描（不走守卫） | `apps/daemon-next/src/artifact-collector.ts:517-518` |
| reported-path 提取 | `apps/daemon-next/src/artifact-collector.ts:217-273` |
| 第一道关：isPlausibleReportedPath（hidden 段拒） | `apps/daemon-next/src/artifact-collector.ts:276-286`（尤其 line 282） |
| 第二道关：isCollectableReportedBase（realpath 后再拒） | `apps/daemon-next/src/artifact-collector.ts:561-573`（尤其 line 566） |
| AGENTBEAN_OUTPUT_DIR 测试 | `apps/daemon-next/tests/workspace-run.test.ts:33` |
| 配套实证（三频道对照） | `.trellis/tasks/archive/2026-08/08-07-output-package-card-dm/research/channel-triage.md` |
