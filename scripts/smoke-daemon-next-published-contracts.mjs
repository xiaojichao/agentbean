#!/usr/bin/env node
/**
 * C-2 防幽灵导出门控：验证「用户从 npm install @agentbean/daemon-next 后，
 * daemon-next dist 引用的 @agentbean/contracts 运行时值导出都在 npm 解析到的 contracts 里」。
 *
 * 真实场景（Bug C 原始）：daemon-next dist 编译时引用了 workspace contracts 的值导出
 * （FORMAL_MEMORY_KINDS 等），但 daemon-next package.json 的 contracts dep 锁了旧版（如 0.2.5），
 * 而 0.2.5 npm 包缺这些导出。用户 install daemon-next → npm 按 deps 装 contracts@0.2.5
 * （嵌套）→ daemon-next 启动 ESM link SyntaxError。见 [[agentbean-contracts-release-publish-loop]]。
 *
 * 本脚本在 daemon-next publish 前跑：本地 pack daemon-next tarball（保留其真实 contracts dep）
 * → 临时 install（npm 按 daemon-next deps 自动装 contracts，**不覆盖**，模拟用户 install）
 * → 加载 daemon-next dist 里引用 contracts 值导出的模块 → 缺导出则 ESM link 崩 → exit 1 阻断 publish。
 *
 * 设计要点：不显式指定 contracts 版本，让 npm 按 daemon-next package.json 的 deps 解析，
 * 这样 daemon-next deps 锁旧时 npm 装旧版（嵌套），真实复现幽灵路径。
 */

import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const rootDir = join(fileURLToPath(new URL('.', import.meta.url)), '..');

/**
 * daemon-next dist 里引用 @agentbean/contracts 运行时值导出的模块（非 import type）。
 * 加载这些模块触发 ESM link，若解析到的 contracts 缺任一值绑定则 SyntaxError。
 * 首项 agent-memory-projection-policy.js = FORMAL_MEMORY_KINDS（历史幽灵崩点）。
 * 新增 contracts 值导出引用时，把对应 dist 模块路径加入此列表即可扩大覆盖。
 */
/**
 * 历史幽灵崩点（Bug C：FORMAL_MEMORY_KINDS）。扫描结果必须包含它们——
 * 若扫描逻辑退化成空集，此处 fail-closed，防止门禁恒真绿灯。
 */
const CONTRACTS_VALUE_IMPORTER_MUST_INCLUDE = [
  'dist/packages/domain/src/agent-memory-projection-policy.js',
];

/** dist 是 tsc 产物，`import type` 已被擦除：凡静态 import/export 自 contracts 的模块都触发 ESM link。 */
const CONTRACTS_STATIC_BINDING_RE = /^\s*(?:import|export)\s+[^'']*?from\s*'@agentbean\/contracts'/m;

/** 扫描安装后的 daemon-next dist，找出所有静态绑定 @agentbean/contracts 的模块（相对 daemon-next 根）。 */
function scanContractsValueImporters(daemonNextRoot, log) {
  const importers = [];
  const distRoot = join(daemonNextRoot, 'dist');
  const stack = [distRoot];
  while (stack.length > 0) {
    const dir = stack.pop();
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const entryPath = join(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(entryPath);
        continue;
      }
      if (!entry.name.endsWith('.js')) continue;
      const source = readFileSync(entryPath, 'utf8');
      if (CONTRACTS_STATIC_BINDING_RE.test(source)) {
        importers.push(relative(daemonNextRoot, entryPath));
      }
    }
  }
  importers.sort();
  const missingAnchor = CONTRACTS_VALUE_IMPORTER_MUST_INCLUDE.filter((p) => !importers.includes(p));
  if (missingAnchor.length > 0) {
    throw new Error(
      `contracts importer scan found ${importers.length} modules but missed known importer(s): ${missingAnchor.join(', ')}`,
    );
  }
  if (importers.length === 0) {
    throw new Error('contracts importer scan found zero modules; the gate cannot verify anything');
  }
  log(`  · scanned daemon-next dist: ${importers.length} module(s) statically bind @agentbean/contracts`);
  return importers;
}

function run(command, args, options) {
  return execFileSync(command, args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  });
}

function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function parseArgs(argv) {
  return { keepTemp: argv.includes('--keep-temp') };
}

export function runSmokeDaemonNextPublishedContracts({
  root = rootDir,
  keepTemp = false,
  log = console.log,
} = {}) {
  const tempDir = mkdtempSync(join(tmpdir(), 'daemon-next-published-contracts-'));
  try {
    run('npm', ['run', 'build:contracts'], { cwd: root });
    run('npm', ['run', 'build:daemon-next'], { cwd: root });

    const daemonNextDir = join(root, 'apps/daemon-next');
    const daemonNextPackageJson = readJson(join(daemonNextDir, 'package.json'));
    const daemonNextVersion = daemonNextPackageJson.version;
    const declaredContractsDep = daemonNextPackageJson.dependencies?.['@agentbean/contracts'];
    if (!declaredContractsDep) {
      throw new Error('daemon-next does not declare @agentbean/contracts dependency');
    }

    const packagesDir = join(tempDir, 'packages');
    const installDir = join(tempDir, 'install');
    mkdirSync(packagesDir, { recursive: true });
    mkdirSync(installDir, { recursive: true });

    const packOut = run('npm', ['pack', '--json', '--pack-destination', packagesDir, daemonNextDir], {
      cwd: daemonNextDir,
    });
    const daemonTarball = join(packagesDir, JSON.parse(packOut)[0].filename);

    writeFileSync(
      join(installDir, 'package.json'),
      `${JSON.stringify({ name: 'daemon-next-published-contracts-smoke', private: true }, null, 2)}\n`,
    );
    // 只装 daemon-next tarball，让 npm 按其 deps 自动解析 contracts（从 npm 注册表）。
    // 这复现用户 `npm install @agentbean/daemon-next` 的真实解析路径。
    run('npm', ['install', '--ignore-scripts', daemonTarball], { cwd: installDir });

    const daemonNextRoot = join(installDir, 'node_modules/@agentbean/daemon-next');
    const installedDaemonNextVersion = readJson(join(daemonNextRoot, 'package.json')).version;
    if (installedDaemonNextVersion !== daemonNextVersion) {
      throw new Error(`installed daemon-next ${installedDaemonNextVersion} != built ${daemonNextVersion}`);
    }

    // 找到 daemon-next 实际解析到的 contracts（可能嵌套），报告其 version。
    const installedContractsJsonPath = [
      join(daemonNextRoot, 'node_modules/@agentbean/contracts/package.json'),
      join(installDir, 'node_modules/@agentbean/contracts/package.json'),
    ].find((p) => {
      try {
        readFileSync(p);
        return true;
      } catch {
        return false;
      }
    });
    const resolvedContractsVersion = installedContractsJsonPath
      ? readJson(installedContractsJsonPath).version
      : '(missing)';

    for (const importerPath of scanContractsValueImporters(daemonNextRoot, log)) {
      const moduleFile = join(daemonNextRoot, importerPath);
      // 动态 import 该模块：触发其 `import { FORMAL_MEMORY_KINDS, ... } from '@agentbean/contracts'`。
      // 若解析到的 npm contracts 缺该值绑定，ESM link 抛 SyntaxError，execFileSync 非 0 退出。
      run(
        process.execPath,
        ['--input-type=module', '--eval', `await import(${JSON.stringify(moduleFile)})`],
        { cwd: installDir },
      );
      log(`  ✓ ${importerPath} linked against resolved @agentbean/contracts@${resolvedContractsVersion}`);
    }

    log(`daemon-next published-contracts smoke passed (daemon-next@${daemonNextVersion} declared contracts dep ${declaredContractsDep}, resolved ${resolvedContractsVersion})`);
    return { tempDir, daemonNextVersion, declaredContractsDep, resolvedContractsVersion };
  } finally {
    if (!keepTemp) {
      rmSync(tempDir, { recursive: true, force: true });
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = parseArgs(process.argv.slice(2));
  runSmokeDaemonNextPublishedContracts(args);
}
