# Node.js 26.5.0 SEA 与 PI runtime 打包约束研究

日期：2026-07-12  
基线：Node.js 26.5.0、esbuild 0.28.1  
资料范围：仅使用 Node.js 与 esbuild 的官方文档、官方仓库和官方发布说明。

## 结论摘要

1. Node.js 26.5.0 已提供内置 `node --build-sea <config.json>`，会在一次命令中完成 preparation blob 生成和二进制注入。正常构建链不再需要 `postject`；`--experimental-sea-config` 加 `postject` 是保留用于验证或兼容旧流程的手工路径。[Node.js 26.5.0 SEA 文档：内置构建](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#generating-single-executable-applications-with---build-sea) [Node.js 25.5.0 发布记录：引入 `--build-sea`](https://github.com/nodejs/node/blob/v26.5.0/doc/changelogs/CHANGELOG_V25.md#2026-01-26-version-2550-current-aduh95)
2. SEA 仍是 Stability 1.1（Active development），而 Node.js 26 在 2026 年 10 月前仍为 Current、尚非 LTS。因此 Phase 0 可以给出工程可行性 verdict，但不应把当前 CLI/config 行为视为长期稳定 ABI。[Node.js 26.5.0 SEA 文档：稳定性](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#single-executable-applications) [Node.js 26.0.0 发布说明](https://nodejs.org/en/blog/release/v26.0.0)
3. 对 AgentBean 内置 PI management runtime，最稳妥的第一版路线是：用 esbuild 生成单个 Node CJS bundle，再以 `mainFormat: "commonjs"`、`useSnapshot: false`、`useCodeCache: false` 交给各目标平台原生的 Node 26.5.0 `--build-sea`。这条路线避开 ESM/snapshot、动态 import/code cache、跨平台 V8 cache 及外部文件系统模块加载的组合风险。
4. “在一个平台构建所有平台”并非零风险承诺。Node 文档允许通过 `executable` 指向目标 Node binary，并明确讨论 cross-platform SEA，但跨平台时 snapshot 和 code cache 必须关闭；官方 SEA CI 覆盖又明确排除了 macOS x64、Alpine Linux 和 Linux s390x。发布门禁应以 Windows、macOS arm64、受支持的 glibc Linux 目标机原生构建与启动测试为准。[配置及跨平台限制](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#generating-single-executable-applications-with---build-sea) [平台覆盖](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#platform-support)

## `--build-sea` 配置合同

Node.js 26.5.0 当前读取以下顶层字段：[官方配置示例](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#generating-single-executable-applications-with---build-sea)

| 字段 | 含义与约束 |
| --- | --- |
| `main` | 必填；要嵌入的单个 bundled script。 |
| `mainFormat` | `"commonjs"` 或 `"module"`；默认 `"commonjs"`。 |
| `executable` | 可选；作为载体的 Node executable；未设置时使用当前 `process.execPath` 对应的 Node。 |
| `output` | 必填；最终可执行文件路径。Windows 必须使用 `.exe` 后缀。 |
| `disableExperimentalSEAWarning` | 默认 `false`；只控制实验性警告。 |
| `useSnapshot` | 默认 `false`；启用后，`main` 在构建机执行并生成 V8 startup snapshot。 |
| `useCodeCache` | 默认 `false`；构建时编译 `main` 并嵌入 V8 code cache。 |
| `execArgv` | 可选；固化进可执行文件的 Node 启动参数。 |
| `execArgvExtension` | `"none"`、`"env"` 或 `"cli"`；默认 `"env"`。`none` 会忽略 `NODE_OPTIONS`，`env` 接受 `NODE_OPTIONS`，`cli` 接受 SEA 专用的 `--node-options`。 |
| `assets` | 可选；asset key 到构建机文件路径的字典。 |

配置文件路径及配置中的相对路径均相对于执行 `node --build-sea` 时的当前工作目录解析。为避免 CI runner 工作目录差异，构建器应生成绝对路径，或明确固定 cwd。[官方路径规则](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#generating-single-executable-applications-with---build-sea)

`output` 是最终 executable，不是 blob。旧的 `node --experimental-sea-config` 中，同名 `output` 才表示 preparation blob 路径，不能混用两套语义。[旧 blob 工作流](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#dumping-the-preparation-blob-to-disk)

## 产物与 `postject` 判断

`--build-sea` 内部完成两步：生成 preparation blob，并把它注入 executable。因此 AgentBean 的标准 Node 26 构建链应删除对 `postject` 的运行时依赖和注入步骤；只有在保留旧 Node 兼容链或专门验证 blob 时才需要它。[官方创建过程](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#single-executable-application-creation-process)

不同可执行格式中的注入位置不同：

- Windows PE：名为 `NODE_SEA_BLOB` 的 resource；
- macOS Mach-O：`NODE_SEA` segment 中名为 `NODE_SEA_BLOB` 的 section；
- Linux ELF：名为 `NODE_SEA_BLOB` 的 note；
- 三者都会翻转 `NODE_SEA_FUSE_fce680ab2cc467b6e072b8b5df1996b2` sentinel fuse，标记载体已注入。

以上是 Node 内部产物合同，不应由 AgentBean 自行复刻；应直接调用同版本 Node 的 `--build-sea`。[官方注入说明](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#2-injecting-the-preparation-blob-into-the-node-binary)

## Windows、macOS、Linux 差异

### Windows

- 输出名必须以 `.exe` 结尾。
- 构建后 Authenticode 签名是可选项；未签名 executable 仍可运行。正式分发是否签名属于发行信任策略，而不是 SEA 启动的技术前置条件。
- 官方示例使用 `signtool sign /fd SHA256 <file>.exe`，需要已有证书。[官方 Windows 步骤](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#single-executable-applications)

### macOS

- 注入会改变 Mach-O，因此生成后需要重新签名。官方最小步骤是 `codesign --sign - <output>`，其中 `-` 是 ad-hoc identity；这足以做本地/CI 启动验证，但不是 Developer ID 分发、notarization 或 Gatekeeper 发布流程的替代品。[官方 macOS 步骤](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#single-executable-applications)
- 官方 SEA CI 当前只定期覆盖 macOS arm64；macOS x64 明确“不支持并在测试中跳过”。因此三平台 verdict 中的 macOS 应明确限定为 arm64，不能把 Intel Mac 计为已支持。[官方平台覆盖](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#platform-support)

### Linux

- 不需要代码签名步骤。
- 官方定期测试 Node 支持的 Linux distributions/architectures，但明确排除 Alpine 和 s390x。Alpine 通常意味着 musl 路线，不能由 glibc Linux 的通过结果外推。[官方平台覆盖](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#platform-support)
- Node 文档记录的 Linux arm64 Docker + `postject` native-addon hash table 崩溃只针对旧的手工 postject 路径；采用内置 `--build-sea` 可以避开该特定链路，但 native addon 仍必须逐目标架构构建和实测。[官方 native addon caveat](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#using-native-addons-in-the-injected-main-script)

## CommonJS、ESM、`require` 与 `import` 限制

SEA 只运行一个 embedded main script，`mainFormat` 可选 CommonJS 或 ESM；默认 CommonJS。`mainFormat: "module"` 不能与 `useSnapshot: true` 同用。[官方 module format 规则](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#module-format-of-the-injected-main-script)

embedded main 的模块加载不是普通磁盘 Node 程序：

- 默认情况下，CJS `require()`、ESM 静态 `import` 只能加载 Node built-in modules；加载只存在于文件系统的模块会报错。
- CJS embedded `require` 不是普通 `require`，除 `require.main` 外不带普通 `require` 的其他属性。
- CJS 的 `__filename` 和 `module.filename` 等于 `process.execPath`；`__dirname` 是 executable 所在目录，不是 bundle 源文件目录。
- ESM 的 `import.meta.url` 指向 `process.execPath` 的 file URL，`import.meta.filename` 等于 executable，`import.meta.dirname` 等于 executable 目录，`import.meta.main` 为 `true`；`import.meta.resolve` 不受支持。
- ESM `import()` 只能动态加载 built-ins，不能从文件系统加载模块；此外 `useCodeCache: true` 时 `import()` 完全不可用。
- 如果确实要访问磁盘模块，可用 `module.createRequire()` 创建普通 filesystem require，但这意味着产物不再是自包含单文件，必须把外部依赖作为安装合同管理。

这些限制都指向同一个 Phase 0 要求：PI runtime 的 JS 依赖必须能被 bundle，或被明确划为外部伴随文件；不能假设 SEA 会像 `node app.js` 一样自动解析相邻 `node_modules`。[官方 module loading 规则](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#module-loading-in-the-injected-main-script) [官方 injected main 细节](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#require-in-the-injected-main-script)

## Assets 与 native addon 限制

`assets` 在构建时被读入 preparation blob。运行时它们不是普通文件路径，必须通过 `node:sea` 的 `getAsset()`、`getAssetAsBlob()`、`getRawAsset()`、`getAssetKeys()` 读取。[官方 assets 文档](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#assets)

- `getAsset()` 返回字符串或 ArrayBuffer copy；`getAssetAsBlob()` 返回 Blob。
- `getRawAsset()` 返回不复制的底层 ArrayBuffer，官方警告不要写入，否则可能因 section 不可写或未对齐而崩溃。
- 依赖 `fs.readFileSync(__dirname + ...)` 的包不会自动读取 SEA assets，需要构建期改写、显式 asset adapter，或将文件作为外部安装内容。
- `.node` native addon 可作为 asset 嵌入，但必须先写到临时文件，再由 `process.dlopen()` 加载。它仍然是 OS/architecture/Node ABI 特定产物，不具备“一份 addon 跨三平台”的能力。[官方 native addon 示例](https://github.com/nodejs/node/blob/v26.5.0/doc/api/single-executable-applications.md#using-native-addons-in-the-injected-main-script)

## esbuild 0.28.1 对 SEA 的约束

esbuild 0.28.1 的官方 release note 只列出一个 dev server Windows path traversal 安全修复；没有声明改变 bundling、Node platform 或 module format 行为。因此下面以 0.28.1 对应的官方 API 合同为准。[esbuild 0.28.1 发布说明](https://github.com/evanw/esbuild/releases/tag/v0.28.1)

推荐 SEA bundle 基线：

```text
bundle: true
platform: "node"
target: "node26"
format: "cjs"
packages: "bundle"（默认值；对不能 bundle 的个别依赖显式审计）
```

理由如下：

1. `platform: "node"` 会默认生成 CJS，并自动把 Node built-ins 标记为 external，同时启用 `node` package export condition；这与 SEA 默认的 `mainFormat: "commonjs"` 对齐。[esbuild Platform 文档](https://esbuild.github.io/api/#platform)
2. esbuild 的 `cjs` format 假定运行环境有 `exports`、`require`、`module`，正好对应 SEA CJS embedded main。[esbuild Format 文档](https://esbuild.github.io/api/#format-commonjs)
3. `target: "node26"` 约束输出语法，但 target 只处理语法兼容性，不提供缺失 runtime API 的 polyfill；PI runtime 使用的 API 仍需在 Node 26.5.0 真机验证。[esbuild Target 文档](https://esbuild.github.io/api/#target)
4. `packages: "external"` 会保留所有 package imports，要求依赖运行时仍存在于文件系统。由于 SEA embedded main 默认不能从文件系统加载这些模块，这个设置与真正的单文件产物冲突；除非同时设计 `createRequire()` 和伴随 `node_modules` 部署，否则不应使用。[esbuild Packages 文档](https://esbuild.github.io/api/#packages)
5. 对 `*.node`、运行时计算路径的 dynamic `require/import`、`__dirname`、`import.meta.url`、`fs.readFileSync` 资源发现等，esbuild 官方明确提示 bundling 不一定支持。不能 bundle 的依赖需要逐项 external/asset 化，不能用全局 external 掩盖问题。[esbuild Node bundling 说明](https://esbuild.github.io/getting-started/#bundling-for-node) [esbuild dynamic import/require 警告](https://esbuild.github.io/api/#glob-style-imports)
6. 标记为 `external` 的 import 会保留到运行时：CJS/IIFE 输出保留为 `require`，ESM 输出保留为 `import`。对 SEA 来说，这必须被视为发布边界，而不是 bundler 成功即代表 executable 自包含。[esbuild External 文档](https://esbuild.github.io/api/#external)

不建议 Phase 0 首版选择 ESM bundle。ESM SEA 本身可用，但会同时引入 `mainFormat: "module"`、snapshot 禁用、filesystem import 限制、dynamic import 限制，以及 esbuild CJS/ESM interop 的额外测试矩阵。除非 PI runtime 的实际 bundle 无法输出 CJS，否则 CJS 是较窄、可证伪的路径。

## 对 PI management runtime 的验证清单

官方资料只能证明平台能力，不能证明 PI runtime 本身可 bundle。Phase 0 verdict 至少应通过以下真实探针：

1. 用 esbuild 0.28.1 对实际 PI runtime entry 执行全 bundle，构建日志中不得留下未经批准的 external package、non-literal `require/import` 警告或额外 output chunks。
2. 静态扫描 bundle 中残留的 bare package `require/import`；Node built-ins 可保留，npm packages 必须为零或进入明确的外部部署清单。
3. 检查 PI runtime 是否依赖 `__dirname`、`import.meta.url`、包内 prompt/schema/template 文件、WASM、worker entry、child process script 或 `.node` addon；逐项选择内嵌代码、SEA asset adapter 或外部文件合同。
4. 分别在 Windows x64、macOS arm64、受支持的 glibc Linux x64（如还承诺 arm64则再加 Linux arm64）构建并运行同一 management smoke：启动、内部管理调用、一次失败恢复、正常退出。
5. macOS 在 `--build-sea` 后执行 `codesign --sign -`，随后验证 `codesign --verify` 和实际启动；正式发布另行验证 Developer ID/notarization。
6. Windows 验证 `.exe` 后缀、未签名启动；若发行策略要求签名，再单独验证 Authenticode pipeline。
7. 固定 `useSnapshot: false`、`useCodeCache: false`，直至 PI runtime 的 import、初始化副作用和跨平台缓存均有独立证据。
8. 验证 executable 搬到不含项目源码、`node_modules` 和构建目录的空目录后仍可启动，防止本机文件系统意外兜底造成假阳性。

## Phase 0 建议 verdict

**有条件可行。** Node.js 26.5.0 的内置 `--build-sea` 已足以替代 `postject`，并支持以 CommonJS 或 ESM 运行一个 embedded bundle；esbuild 0.28.1 能提供适合 Node SEA 的单文件 CJS bundle。真正的放行条件不是 API 是否存在，而是 PI runtime 的依赖图能否在不依赖外部 `node_modules`、未声明资源路径和跨平台 native addon 的前提下完成 bundle，并在 Windows、macOS arm64、glibc Linux 的目标 runner 上通过真实 executable smoke。

在这些实测完成前，P0-11 应记为“官方能力已确认、PI runtime 兼容性待实证”，不能仅凭一个 macOS 本机 demo 标记三平台 Green。
