# 测试风格、代表文件、运行命令

## 何时适用

写新测试、改既有测试、加测试清单、跑本地验证、排查 CI 上 daemon-next 段挂掉。

## 配置与命令

- 配置：`apps/daemon-next/vitest.config.ts`——`environment: 'node'`，`include: ['tests/**/*.test.ts']`。
- 测试数：`apps/daemon-next/tests/` 共 67 个 `.test.ts` 文件。
- 命令（根目录跑）：

```bash
# 只跑 daemon-next
npm run test:daemon-next
# 等价于：cd apps/daemon-next && ../../node_modules/.bin/vitest run tests --config vitest.config.ts

# 纳入全包门禁：daemon-next 段必须加 --api.host 127.0.0.1
npm run test:packages
# 在根 package.json:20 展开为：... && npm run test:daemon-next -- --api.host 127.0.0.1 && ...

# 跑单个文件（在 apps/daemon-next 下）
../../node_modules/.bin/vitest run tests/file-reader.test.ts --config vitest.config.ts
```

**`--api.host 127.0.0.1` 提示**：`test:packages` 与 `test:ci` 中 daemon-next 段带这个 flag（根 `package.json:20`）。不带的话部分依赖 socket 握手的测试（dispatch 管线、device-service 之类）会打不开本地 server 而挂。本地单跑纯单元测试（如 `file-reader`）不需要它。

## 本地风格

- **真文件系统，不 mock `node:fs`**：涉及 IO 的测试用 `mkdtempSync(tmpdir(), ...)` 建临时 home，`mkdirSync`/`writeFileSync`/`symlinkSync` 摆真实结构，测完靠 tmpdir 自动回收。见 `tests/file-reader.test.ts:1-7` 的 import 与 `setupSnapshot` helper（:17-21）。这是验证符号链接逃逸、白名单 containment 的唯一可靠方式——mock `realpathSync` 会漏掉真实跨盘/链接行为。
- **直接 import `../src/...`**：不经过 barrel，直接从源文件导入被测符号（如 `import { readFile, MAX_READ_FILE_BYTES } from '../src/file-reader'`）。改导出时同步改测试 import。
- **注释挂 issue 号与不变量**：测试头部交代背景（如 `// #1084 切片3 fs:read 核心安全闸测试`）与「关键不变量 / gotcha」，方便后来者知道这条测试守的是什么。见 `tests/file-reader.test.ts:9-15`。
- **`describe` + 多 `test`**：一个文件一个主题，`describe` 分组，`test`（非 `it`）写用例。

## 代表文件（按主题）

| 文件 | 守什么 |
| --- | --- |
| `tests/file-reader.test.ts` | fs:read 白名单遏制、符号链接逃逸（闸 4 realpath）、`OUTSIDE_SNAPSHOTS` 专用码、`MAX_READ_FILE_BYTES` 上限、sha256 回包、限速器 |
| `tests/artifact-collector.test.ts` | reported 路径递归收集、`ADAPTER_OUTPUT_FILE_EXT_RE` 过滤、`REPORTED_PATH_REJECTED`、basename-only 诊断 |
| `tests/executor-pty.test.ts` | codex PTY argv 归一化、`--dangerously-bypass-approvals-and-sandbox` 强制注入、reply 提取 |
| `tests/executable-paths.test.ts` | `executableSearchDirs` 覆盖 nvm/volta/fnm/mise/asdf/pnpm/bun/Homebrew、`pushVersionBins` 版本目录扫描、不存在目录静默返回 |
| `tests/device-service-core.test.ts` / `tests/device-service-host.test.ts` | device-service 运行时、装载/卸载、状态机 |
| `tests/dispatch-pipeline.test.ts` | dispatch 事件分发管线（依赖 `--api.host`） |

## 加测试清单

1. 新功能 / 改既有行为，**先**写测试落不变量（参考上述代表文件的注释风格）。
2. 涉及文件 IO 一律用 tmpdir + 真实 `node:fs`，不要 mock fs。
3. 导入走 `../src/<file>`，别加 barrel 中转。
4. 涉及 socket/dispatch 的测试，确认本地能带 `--api.host 127.0.0.1` 跑过。
5. 改完跑 `npm run test:daemon-next`，关键路径再跑 `npm run test:packages` 确认组合态。

## 佐证文件

- `apps/daemon-next/vitest.config.ts`（environment=node、include glob）
- `apps/daemon-next/tests/file-reader.test.ts:1-21`（import、注释、`setupSnapshot`）
- `apps/daemon-next/tests/{artifact-collector,executor-pty,executable-paths}.test.ts`
- 根 `package.json:18,20,22`（`test:daemon-next`、`test:packages`、`test:ci` 脚本）

## 反模式

- **mock `node:fs` / `realpathSync`**：fs:read 安全闸（白名单 + 符号链接逃逸）只有真实文件系统能验证，mock 会让闸 4（`:100`）形同虚设。
- **测试不经 `--api.host` 就声明全绿**：`test:packages` 组合态带这个 flag，本地单跑纯单测可省，但 socket 类测试不带会假阳性失败。
- **通过 barrel 导入被测符号**：daemon-next src 扁平，直接 `../src/<file>`，barrel 中转会掩盖循环依赖与导出漂移。
- **改 src 导出不同步测试 import**：直接 import 意味着改名/删导出会让测试编译失败——这正是想要的，别用 `@ts-ignore` 压掉。

## 验证命令

```bash
# 全 daemon-next 套件
npm run test:daemon-next
# 组合态（含 --api.host）
npm run test:packages
# 单文件
cd apps/daemon-next && ../../node_modules/.bin/vitest run tests/file-reader.test.ts --config vitest.config.ts
# 确认测试数
ls apps/daemon-next/tests/*.test.ts | wc -l
```
