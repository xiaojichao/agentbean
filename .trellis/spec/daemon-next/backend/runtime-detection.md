# 可执行检测与 launchd PATH

## 何时适用

改动 agent 可执行文件发现（scanner）、为 agent 子进程补 PATH、动版本管理器（nvm/volta/fnm/mise/asdf）目录扫描、排查「agent 装了但显示未安装」或「daemon 能跑 agent 但 scanner 检测不到」。

## 单一真相：executableSearchDirs

`src/executable-paths.ts:22` 的 `executableSearchDirs(home)` 是版本管理器与 Node 工具链 bin/shim 目录的**唯一真相源**。两个消费者共用：

- **scanner 运行时检测**：`src/scanner.ts:105` 的 `pathEntries()` 在 `process.env.PATH` 之外追加 `executableSearchDirs(home)`（`src/scanner.ts:108`），用于扫已安装的 claude/codex/gemini 等。
- **executor 子进程 PATH 修复**：`src/executor-helpers.ts:118` 的 `candidateNodeBinDirs` 在 `:131` 循环 `executableSearchDirs(home)`，再在 `:202` 用于给 agent 子进程补 PATH（找 node 本体）。

头注释（`src/executable-paths.ts:7`）记录了历史 bug：曾经 scanner 的 `pathEntries` 漏了 nvm/volta/fnm 而 executor-helpers 的 `candidateNodeBinDirs` 早已处理，导致「daemon 能执行 nvm 装的 agent，却检测不到它们已安装」（装在版本管理器路径的 claude/codex/gemini 显示「未安装」）。统一到此函数正是为防再次分叉。

## 本地模式

### launchd 下 PATH 极简

daemon 作为 macOS LaunchAgent 后台服务（见 [architecture.md](architecture.md)）时，`process.env.PATH` 只有 `/usr/bin:/bin:/usr/sbin:/sbin`（`src/executable-paths.ts` 第 10 行注释）。nvm/volta/fnm 只在交互 shell 动态注入 PATH，后台服务**必须**显式纳入这些位置才能发现可执行文件。这就是 `executableSearchDirs` 存在的原因。

### 它推哪些目录（`src/executable-paths.ts:24-35`）

- 包管理器全局 shim：`~/Library/pnpm`、`~/.local/share/pnpm`、`~/.local/bin`、`~/.bun/bin`、`~/.npm-global/bin`
- 版本管理器静态 current/shim：`~/.nvm/current/bin`、`~/.fnm/current/bin`、`~/.volta/bin`、`~/.asdf/shims`、`~/.local/share/mise/shims`
- 版本管理器版本化目录（版本号可变，需 `readdirSync` 扫描，`pushVersionBins` `:42`）：`~/.nvm/versions/node/*/bin`、`~/.fnm/node-versions/*/installation/bin`、`~/.local/share/fnm/node-versions/*/installation/bin`
- 系统全局：`/opt/homebrew/bin`、`/usr/local/bin`

目录不存在或不可读时 `pushVersionBins` 静默返回（`src/executable-paths.ts:46-48`），不会抛。

### 加新版本管理器/工具链

1. 静态目录直接 `push(join(home, '...'))`，**不要**在 scanner 或 executor-helpers 各写一份。
2. 版本化目录加到 `pushVersionBins` 调用，传对 suffix（nvm 是 `bin`，fnm 是 `installation/bin`）。
3. 改完跑 `tests/executable-paths.test.ts`。

## 佐证文件

- `apps/daemon-next/src/executable-paths.ts:7,10,22-35,42-48`（单一真相、launchd PATH、目录列表、`pushVersionBins`）
- `apps/daemon-next/src/scanner.ts:7,105,108`（import 与 `pathEntries` 消费）
- `apps/daemon-next/src/executor-helpers.ts:9,118,130-131,202`（`candidateNodeBinDirs` 消费）
- `apps/daemon-next/tests/executable-paths.test.ts`

## 反模式

- **复制 PATH 目录到第二处**：历史 bug 就是这么来的（scanner 与 executor-helpers 各维护一份）。任何新目录只改 `executableSearchDirs`。
- **在 scanner 里硬编码 nvm 路径绕过 `pathEntries`**：会再次分叉，导致「能跑但检测不到」。
- **假设后台服务 PATH 含 nvm**：launchd PATH 只有 `/usr/bin:/bin:/usr/sbin:/sbin`，nvm/volta/fnm 不会自动在。
- **`pushVersionBins` 不处理异常**：版本目录可能在容器/CI 不存在，`readdirSync` 抛了会让整个 scanner 崩。现有 `try/catch` 静默返回是正确的，别改成抛。

## 验证命令

```bash
# 确认只有一个真相函数
cd apps/daemon-next && grep -rn 'executableSearchDirs' src/
# 确认两个消费者都走它
grep -nE 'executableSearchDirs|candidateNodeBinDirs|pathEntries' src/scanner.ts src/executor-helpers.ts
# 确认 launchd PATH 假设
grep -n 'usr/bin:/bin' src/executable-paths.ts
# 跑测试
npm run test:daemon-next -- tests/executable-paths.test.ts
```
