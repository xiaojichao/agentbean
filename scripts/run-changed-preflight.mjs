#!/usr/bin/env node
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

import { classifyChangedFiles, normalizePath } from './detect-ci-changes.mjs';

const TARGETS = [
  {
    id: 'server-next',
    prefix: 'apps/server-next/',
    commands: [
      npmCommand('test:server-next-ci'),
      npmCommand('build:server-next'),
    ],
  },
  {
    id: 'daemon-next',
    prefix: 'apps/daemon-next/',
    commands: [
      npmCommand('test:daemon-next', ['--api.host', '127.0.0.1']),
      npmCommand('build:daemon-next'),
    ],
  },
  {
    id: 'web-next',
    prefix: 'apps/web-next/',
    commands: [
      npmCommand('test:web-next', ['--api.host', '127.0.0.1']),
      npmCommand('build:web-next'),
    ],
  },
];

const FULL_COMMANDS = [npmCommand('test:ci'), npmCommand('build:packages')];
const PACKAGE_NEUTRAL_PATH_RE = /^(?:docs\/|[^/]+\.md$|LICENSE(?:\.|$))/u;

function npmCommand(script, forwardedArgs = []) {
  const argv = ['run', script];
  if (forwardedArgs.length > 0) argv.push('--', ...forwardedArgs);
  return {
    id: script,
    executable: 'npm',
    argv,
    display: `npm ${argv.join(' ')}`,
  };
}

function uniqueCommands(commands) {
  const seen = new Set();
  return commands.filter((command) => {
    if (seen.has(command.id)) return false;
    seen.add(command.id);
    return true;
  });
}

export function planChangedPreflight(files) {
  const normalizedFiles = [...new Set((files ?? []).map(normalizePath).filter(Boolean))].sort();
  if (normalizedFiles.length === 0) {
    return {
      mode: 'none',
      reason: '没有检测到改动',
      files: [],
      targets: [],
      fallbackFiles: [],
      commands: [],
    };
  }

  const targetIds = new Set();
  const fallbackFiles = [];
  for (const file of normalizedFiles) {
    const target = TARGETS.find((candidate) => file.startsWith(candidate.prefix));
    if (target) targetIds.add(target.id);
    else if (classifyChangedFiles([file]).should_validate || !PACKAGE_NEUTRAL_PATH_RE.test(file)) {
      fallbackFiles.push(file);
    }
  }

  if (fallbackFiles.length > 0) {
    return {
      mode: 'full',
      reason: '包含跨切面或未映射路径，回退完整 CI 等价检查',
      files: normalizedFiles,
      targets: [],
      fallbackFiles,
      commands: FULL_COMMANDS,
    };
  }

  const targets = TARGETS.filter((target) => targetIds.has(target.id));
  return {
    mode: targets.length > 0 ? 'targeted' : 'none',
    reason: targets.length > 0
      ? '按改动面运行对应 package 测试与 matching build'
      : '改动不涉及 package 执行面',
    files: normalizedFiles,
    targets: targets.map((target) => target.id),
    fallbackFiles: [],
    commands: uniqueCommands(targets.flatMap((target) => target.commands)),
  };
}

function runGit(args, cwd) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' });
  if (result.error) throw new Error(result.error.message);
  if (result.status !== 0) {
    throw new Error(result.stderr.trim() || `git ${args.join(' ')} 执行失败`);
  }
  return result.stdout;
}

function lines(value) {
  return String(value ?? '')
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function collectChangedFiles({
  base = 'origin/main',
  cwd = process.cwd(),
  git = runGit,
} = {}) {
  const outputs = [
    git(['diff', '--name-only', '--diff-filter=ACDMR', `${base}...HEAD`, '--'], cwd),
    git(['diff', '--name-only', '--diff-filter=ACDMR', '--cached', '--'], cwd),
    git(['diff', '--name-only', '--diff-filter=ACDMR', '--'], cwd),
    git(['ls-files', '--others', '--exclude-standard'], cwd),
  ];
  return [...new Set(outputs.flatMap(lines).map(normalizePath).filter(Boolean))].sort();
}

export function executePreflight(plan, {
  cwd = process.cwd(),
  run = (command) => spawnSync(command.executable, command.argv, {
    cwd,
    env: process.env,
    stdio: 'inherit',
  }),
} = {}) {
  for (const command of plan.commands) {
    console.log(`\n▶ ${command.display}`);
    const result = run(command);
    if (result.error) throw new Error(result.error.message);
    if (result.status !== 0) return result.status ?? 1;
  }
  return 0;
}

function formatPlan(plan) {
  const linesOut = [
    `AgentBean changed preflight：${plan.mode}`,
    `改动文件：${plan.files.length}`,
    `原因：${plan.reason}`,
  ];
  if (plan.targets.length > 0) linesOut.push(`执行面：${plan.targets.join(', ')}`);
  if (plan.fallbackFiles.length > 0) {
    linesOut.push(`触发完整回退：${plan.fallbackFiles.slice(0, 5).join(', ')}`);
  }
  if (plan.commands.length === 0) linesOut.push('命令：无 package preflight 命令');
  else linesOut.push('命令：', ...plan.commands.map((command) => `- ${command.display}`));
  return linesOut.join('\n');
}

function parseArgs(argv) {
  const options = { base: 'origin/main', planOnly: false, files: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--base') {
      const base = argv[index + 1];
      if (!base) throw new Error('--base 缺少 ref');
      options.base = base;
      index += 1;
    } else if (value === '--plan') options.planOnly = true;
    else if (value === '--help' || value === '-h') options.help = true;
    else if (value.startsWith('-')) throw new Error(`未知参数：${value}`);
    else options.files.push(value);
  }
  return options;
}

export function assertNode24(version = process.versions.node) {
  if (Number(String(version).split('.')[0]) !== 24) {
    throw new Error(`需要 Node 24，当前为 ${version}`);
  }
}

function main() {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) {
      console.log(`用法：
  npm run preflight:changed
  npm run preflight:changed -- --plan
  npm run preflight:changed -- --base origin/main
  npm run preflight:changed -- apps/server-next/src/example.ts`);
      return;
    }
    assertNode24();
    const files = options.files.length > 0
      ? options.files
      : collectChangedFiles({ base: options.base });
    const plan = planChangedPreflight(files);
    console.log(formatPlan(plan));
    if (!options.planOnly) process.exitCode = executePreflight(plan);
  } catch (error) {
    console.error(`CHANGED_PREFLIGHT_ERROR: ${error.message}`);
    process.exitCode = 1;
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
