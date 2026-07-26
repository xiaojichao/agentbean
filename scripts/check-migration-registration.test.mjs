import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-migration-registration.mjs', import.meta.url));
const MIGRATIONS_DIR = 'apps/server-next/src/infra/sqlite/migrations';
const REGISTRY_FILE = 'apps/server-next/src/infra/sqlite/repositories.ts';

const GLOBAL_MIGRATIONS = ['0001_first_slice.sql', '0002_device_invites.sql'];
const TEAM_MIGRATIONS = [
  '0001_first_slice.sql',
  '0037_artifact_sources.sql',
  '0047_task_coordination_preferred_skills.sql',
];

function write(root, path, source) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker, '--workspace-root', root], { encoding: 'utf8' });
}

function registrar(name, body) {
  return `export function ${name}(db: SqliteDatabase): void {\n${body}\n}\n`;
}

function calls(paths) {
  return paths.map((path) => `  applyMigration(db, '${path}');`).join('\n');
}

// 默认 fixture 是绿的：目录里的每个文件都在对应 registrar 里注册。
// 每个红用例只在这个绿基线上注入一处缺陷，红结果才能归因到被测规则本身，
// 而不是 fixture 本身没搭好（#836 的负向 fixture 空转教训）。
function withFixture(callback, overrides = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-migration-registration-'));
  try {
    const globalFiles = overrides.globalFiles ?? GLOBAL_MIGRATIONS;
    const teamFiles = overrides.teamFiles ?? TEAM_MIGRATIONS;
    for (const file of globalFiles) {
      write(root, `${MIGRATIONS_DIR}/global/${file}`, 'SELECT 1;\n');
    }
    for (const file of teamFiles) {
      write(root, `${MIGRATIONS_DIR}/team/${file}`, 'SELECT 1;\n');
    }
    const globalBody = overrides.globalBody
      ?? calls(GLOBAL_MIGRATIONS.map((file) => `global/${file}`));
    const teamBody = overrides.teamBody
      ?? calls(TEAM_MIGRATIONS.map((file) => `team/${file}`));
    write(root, REGISTRY_FILE, overrides.registry ?? [
      registrar('applyGlobalMigrations', globalBody),
      registrar('applyTeamMigrations', teamBody),
    ].join('\n'));
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

test('accepts a workspace where every migration is registered', () => {
  withFixture((root) => {
    // 非 .sql 的旁路文件不参与断言。
    write(root, `${MIGRATIONS_DIR}/team/README.md`, '# migrations\n');
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
    assert.match(result.stdout, /MIGRATION_REGISTRATION_READY: 5 条 migration/);
  });
});

// #838 的原始事故：文件在，注册列表从 0046 直接跳到 0048。
test('rejects a team migration that exists but is never registered', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /MIGRATION_NOT_REGISTERED: applyTeamMigrations\(\) 未注册 team\/0047_task_coordination_preferred_skills\.sql/,
    );
    // 只应报这一条，其余注册不受牵连。
    assert.equal(result.stderr.trim().split('\n').length, 1);
  }, {
    teamBody: calls(TEAM_MIGRATIONS
      .filter((file) => !file.startsWith('0047'))
      .map((file) => `team/${file}`)),
  });
});

test('rejects a global migration that exists but is never registered', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /MIGRATION_NOT_REGISTERED: applyGlobalMigrations\(\) 未注册 global\/0002_device_invites\.sql/,
    );
  }, {
    globalBody: calls(['global/0001_first_slice.sql']),
  });
});

// applyTeamMigrations() 里的 0037/0039 被 sqliteTableExists 守卫包裹，仍算已注册。
test('counts conditionally registered migrations as registered', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }, {
    teamBody: [
      "  applyMigration(db, 'team/0001_first_slice.sql');",
      "  if (sqliteTableExists(db, 'artifacts')) {",
      "    applyMigration(db, 'team/0037_artifact_sources.sql');",
      '  }',
      "  applyMigration(db, 'team/0047_task_coordination_preferred_skills.sql', { disableForeignKeys: true });",
    ].join('\n'),
  });
});

// 函数体里内嵌的 SQL 模板字面量含花括号，不得让花括号配对提前收尾、吞掉后续注册。
test('keeps parsing registrations after an inline SQL template literal', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  }, {
    teamBody: [
      "  applyMigration(db, 'team/0001_first_slice.sql');",
      "  applyMigration(db, 'team/0037_artifact_sources.sql');",
      "  if (sqliteTableExists(db, 'artifacts')) {",
      '    db.exec(`UPDATE channel_document_revisions',
      "      SET source = 'run'",
      "      WHERE payload = '{\"closing\": \"}\"}'",
      '        AND artifact_id IN (SELECT id FROM artifacts);`);',
      '  }',
      "  applyMigration(db, 'team/0047_task_coordination_preferred_skills.sql');",
    ].join('\n'),
  });
});

// 注释掉注册正是孤儿 migration 的成因之一，必须 fail-closed。
for (const [label, commented] of [
  ['line comment', "  // applyMigration(db, 'team/0047_task_coordination_preferred_skills.sql');"],
  ['block comment', "  /* applyMigration(db, 'team/0047_task_coordination_preferred_skills.sql'); */"],
]) {
  test(`does not count a registration disabled by a ${label}`, () => {
    withFixture((root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /MIGRATION_NOT_REGISTERED: .*team\/0047_task_coordination_preferred_skills\.sql/);
    }, {
      teamBody: [
        calls(TEAM_MIGRATIONS
          .filter((file) => !file.startsWith('0047'))
          .map((file) => `team/${file}`)),
        commented,
      ].join('\n'),
    });
  });
}

// 反向断言：改名/删文件留下的悬空引用会让 resolveMigrationPath 在启动时抛错。
test('rejects a registration whose migration file no longer exists', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /MIGRATION_FILE_MISSING: applyTeamMigrations\(\) 引用了不存在的 team\/0047_task_coordination_preferred_skills\.sql/,
    );
  }, {
    teamFiles: TEAM_MIGRATIONS.filter((file) => !file.startsWith('0047')),
  });
});

test('rejects a migration registered under the wrong scope', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(
      result.stderr,
      /MIGRATION_SCOPE_MISMATCH: applyGlobalMigrations\(\) 注册了非 global 路径 team\/0001_first_slice\.sql/,
    );
    // 串场的同时，本该注册在 team 的那条也照样报缺失。
    assert.match(result.stderr, /MIGRATION_NOT_REGISTERED: applyTeamMigrations\(\) 未注册 team\/0001_first_slice\.sql/);
  }, {
    globalBody: calls([...GLOBAL_MIGRATIONS.map((file) => `global/${file}`), 'team/0001_first_slice.sql']),
    teamBody: calls(TEAM_MIGRATIONS
      .filter((file) => !file.startsWith('0001'))
      .map((file) => `team/${file}`)),
  });
});

// 扫不到文件时必须报红：静默通过等于守卫永久失效。
test('fails closed when a migrations directory yields no .sql files', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, new RegExp(`${MIGRATIONS_DIR}/team:MIGRATION_DIR_EMPTY`));
  }, {
    teamFiles: [],
    teamBody: '',
  });
});

// 注册函数被改名/被拆走时同样不能放行。
for (const [label, registry] of [
  ['a registrar is renamed away', registrar('applyGlobalMigrations', calls(GLOBAL_MIGRATIONS.map((file) => `global/${file}`)))],
  ['a registrar body is unbalanced', [
    registrar('applyGlobalMigrations', calls(GLOBAL_MIGRATIONS.map((file) => `global/${file}`))),
    `export function applyTeamMigrations(db: SqliteDatabase): void {\n${calls(TEAM_MIGRATIONS.map((file) => `team/${file}`))}\n`,
  ].join('\n')],
]) {
  test(`fails closed when ${label}`, () => {
    withFixture((root) => {
      const result = runChecker(root);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, /MIGRATION_REGISTRAR_UNPARSEABLE: 找不到或无法解析 applyTeamMigrations\(\)/);
    }, { registry });
  });
}

test('exits 2 when the registry file is missing', () => {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-migration-registration-'));
  try {
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /MIGRATION_REGISTRY_MISSING/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
