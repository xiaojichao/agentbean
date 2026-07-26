#!/usr/bin/env node

// SQLite migration 静态注册守卫。
//
// 背景（#838 / #841）：team/0047_task_coordination_preferred_skills.sql 曾被漏注册在
// applyTeamMigrations()（注册列表从 0046 直接跳到 0048），该列因此从未建过，而
// task-claim-broker.ts 的 publishOffer 已经在消费 coordination.preferredSkills ?? []，
// 取值恒为 [] —— 静默失效数月且无任何报错。
//
// 本守卫做两个方向的断言：
//   1. 正向：migrations/{global,team}/*.sql 每个文件都必须在对应的 apply*Migrations() 中注册。
//   2. 反向：注册列表引用的每个路径都必须存在对应文件（悬空引用会让 resolveMigrationPath
//      在启动时抛 "SQLite migration not found" 直接崩服务）。
//
// 解析原则一律 fail-closed：目录为空、注册函数找不到、函数体解析不出来，都报红而不是放行，
// 避免出现"扫不到东西所以全绿"的空转假绿（参考 #836）。

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const MIGRATIONS_DIR = 'apps/server-next/src/infra/sqlite/migrations';
const REGISTRY_FILE = 'apps/server-next/src/infra/sqlite/repositories.ts';
const SCOPES = [
  { scope: 'global', registrar: 'applyGlobalMigrations' },
  { scope: 'team', registrar: 'applyTeamMigrations' },
];

// applyMigration(db, 'team/0047_x.sql') / applyMigration(db, 'team/0021_x.sql', { disableForeignKeys: true })。
// 只匹配调用本身而不匹配裸字面量：注释里提到的路径、以及非注册用途的同形字符串都不算已注册。
const REGISTRATION_PATTERN = /applyMigration\s*\(\s*[^,()]*,\s*(['"`])([^'"`]+)\1/g;

const args = process.argv.slice(2);
const rootFlag = args.indexOf('--workspace-root');
const root = resolve(rootFlag >= 0 ? args[rootFlag + 1] ?? '' : fileURLToPath(new URL('..', import.meta.url)));
const violations = [];

const registryPath = resolve(root, REGISTRY_FILE);
if (!existsSync(registryPath)) {
  console.error(`${REGISTRY_FILE}:MIGRATION_REGISTRY_MISSING: SQLite migration 注册文件不存在`);
  process.exit(2);
}
const registrySource = readFileSync(registryPath, 'utf8');

let registeredTotal = 0;
for (const { scope, registrar } of SCOPES) {
  const body = readFunctionBody(registrySource, registrar);
  if (body === null) {
    violations.push(
      `${REGISTRY_FILE}:MIGRATION_REGISTRAR_UNPARSEABLE: 找不到或无法解析 ${registrar}() 函数体，`
      + '守卫无法确认注册完整性（fail-closed）',
    );
    continue;
  }

  const scopeDir = resolve(root, MIGRATIONS_DIR, scope);
  const files = existsSync(scopeDir)
    ? readdirSync(scopeDir).filter((name) => name.endsWith('.sql')).sort()
    : [];
  if (files.length === 0) {
    violations.push(
      `${MIGRATIONS_DIR}/${scope}:MIGRATION_DIR_EMPTY: 未扫到任何 .sql，`
      + '守卫会空转假绿，必须先确认目录路径正确（fail-closed）',
    );
    continue;
  }

  const registered = [...body.matchAll(REGISTRATION_PATTERN)].map((match) => match[2]);
  registeredTotal += registered.length;
  const registeredNames = new Set(
    registered
      .filter((path) => path.startsWith(`${scope}/`))
      .map((path) => path.slice(scope.length + 1)),
  );

  // 正向：每个 migration 文件都必须被注册，否则它从未跑过。
  for (const file of files) {
    if (!registeredNames.has(file)) {
      violations.push(
        `${REGISTRY_FILE}:MIGRATION_NOT_REGISTERED: ${registrar}() 未注册 ${scope}/${file}`
        + '（该 migration 永远不会执行）',
      );
    }
  }

  // 反向：注册引用的路径必须存在，且必须属于本 scope。
  for (const path of registered) {
    if (!path.startsWith(`${scope}/`)) {
      violations.push(
        `${REGISTRY_FILE}:MIGRATION_SCOPE_MISMATCH: ${registrar}() 注册了非 ${scope} 路径 ${path}`,
      );
      continue;
    }
    if (!existsSync(resolve(root, MIGRATIONS_DIR, path))) {
      violations.push(
        `${REGISTRY_FILE}:MIGRATION_FILE_MISSING: ${registrar}() 引用了不存在的 ${path}`
        + '（启动时 resolveMigrationPath 会抛 SQLite migration not found）',
      );
    }
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'));
  process.exit(1);
}

console.log(
  `MIGRATION_REGISTRATION_READY: ${registeredTotal} 条 migration 全部静态注册，且无悬空引用`,
);

// 取出具名函数的函数体（含首尾花括号），注释内容替换为等长空白以保留偏移。
// 字符串/模板字面量整体保留但不参与花括号配对，避免 SQL 模板里的括号打断解析。
// 解析不出来一律返回 null，由调用方 fail-closed。
function readFunctionBody(source, functionName) {
  const declaration = new RegExp(`\\bfunction\\s+${functionName}\\s*\\(`).exec(source);
  if (!declaration) {
    return null;
  }

  // 先跳过参数列表：参数默认值（如 = {}）会让"声明后第一个 {"指错地方。
  let cursor = declaration.index + declaration[0].length - 1;
  let parens = 0;
  for (; cursor < source.length; cursor += 1) {
    if (source[cursor] === '(') {
      parens += 1;
    } else if (source[cursor] === ')') {
      parens -= 1;
      if (parens === 0) {
        cursor += 1;
        break;
      }
    }
  }
  if (parens !== 0) {
    return null;
  }

  const bodyStart = source.indexOf('{', cursor);
  if (bodyStart < 0) {
    return null;
  }

  let depth = 0;
  let body = '';
  for (let index = bodyStart; index < source.length;) {
    const char = source[index];
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const lineEnd = source.indexOf('\n', index);
      const end = lineEnd < 0 ? source.length : lineEnd;
      body += ' '.repeat(end - index);
      index = end;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) {
        return null;
      }
      body += ' '.repeat(end + 2 - index);
      index = end + 2;
      continue;
    }
    if (char === '\'' || char === '"' || char === '`') {
      const literal = readStringLiteral(source, index);
      if (literal === null) {
        return null;
      }
      body += literal;
      index += literal.length;
      continue;
    }

    if (char === '{') {
      depth += 1;
    } else if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return `${body}}`;
      }
    }
    body += char;
    index += 1;
  }

  return null;
}

// 读一个字符串/模板字面量（含引号），未闭合返回 null。
function readStringLiteral(source, start) {
  const quote = source[start];
  for (let index = start + 1; index < source.length; index += 1) {
    const char = source[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === quote) {
      return source.slice(start, index + 1);
    }
    if (quote !== '`' && char === '\n') {
      return null;
    }
  }
  return null;
}
