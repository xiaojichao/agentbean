import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const checker = fileURLToPath(new URL('./check-phase-0-pi-boundary.mjs', import.meta.url));

function write(root, path, source) {
  const file = join(root, path);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, source);
}

function runChecker(root) {
  return spawnSync(process.execPath, [checker, '--workspace-root', root], { encoding: 'utf8' });
}

function withFixture(callback) {
  const root = mkdtempSync(join(tmpdir(), 'agentbean-pi-boundary-'));
  try {
    write(root, 'package.json', JSON.stringify({ workspaces: ['packages/*', 'apps/*'] }));
    callback(root);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
}

function scaffoldWrapper(root, dependencies = { '@earendil-works/pi-coding-agent': '0.80.6' }) {
  write(root, 'packages/pi-management-runtime/package.json', JSON.stringify({
    name: '@agentbean/pi-management-runtime',
    dependencies,
  }));
  const packages = {
    '': { workspaces: ['packages/*', 'apps/*'] },
    'packages/pi-management-runtime': { dependencies },
  };
  for (const [name] of Object.entries(dependencies)) {
    packages[`node_modules/${name}`] = { version: '0.80.6' };
  }
  write(root, 'package-lock.json', JSON.stringify({ lockfileVersion: 3, packages }));
}

test('reports P0_NOT_SCAFFOLDED until the wrapper package exists', () => {
  withFixture((root) => {
    const result = runChecker(root);
    assert.equal(result.status, 2, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /P0_NOT_SCAFFOLDED/);
  });
});

test('allows the exact PI dependency only in the wrapper manifest', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    write(root, 'packages/pi-management-runtime/src/adapter.ts', "import { createAgentSession } from '@earendil-works/pi-coding-agent';\n");

    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test('allows exact direct PI support packages only in the wrapper', () => {
  withFixture((root) => {
    scaffoldWrapper(root, {
      '@earendil-works/pi-coding-agent': '0.80.6',
      '@earendil-works/pi-ai': '0.80.6',
    });
    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test('rejects an imprecise PI dependency version', () => {
  withFixture((root) => {
    scaffoldWrapper(root, { '@earendil-works/pi-coding-agent': '^0.80.6' });

    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /packages\/pi-management-runtime\/package\.json:.*PI_DEPENDENCY_VERSION/);
  });
});

for (const [path, source] of [
  ['apps/server-next/src/pi.ts', "import { AgentSession } from '@earendil-works/pi-coding-agent';\n"],
  ['apps/daemon-next/src/pi.ts', "export * from '@earendil-works/pi-agent-core';\n"],
  ['packages/contracts/package.json', JSON.stringify({ dependencies: { '@earendil-works/pi-ai': '0.80.6' } })],
]) {
  test(`rejects PI use outside the wrapper: ${path}`, () => {
    withFixture((root) => {
      scaffoldWrapper(root);
      write(root, path, source);

      const result = runChecker(root);
      assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
      assert.match(result.stderr, new RegExp(`${path.replaceAll('.', '\\.')}:1:PI_BOUNDARY_VIOLATION`));
    });
  });
}

test('ignores build artifacts and node_modules', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    write(root, 'apps/server-next/dist/pi.js', "import '@earendil-works/pi-coding-agent';\n");
    write(root, 'node_modules/example/index.js', "import '@earendil-works/pi-coding-agent';\n");

    const result = runChecker(root);
    assert.equal(result.status, 0, `${result.stdout}${result.stderr}`);
  });
});

test('rejects PI imports from root scripts', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    write(root, 'scripts/rogue.mjs', "import '@earendil-works/pi-coding-agent';\n");
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /scripts\/rogue\.mjs:1:PI_BOUNDARY_VIOLATION/);
  });
});

test('rejects PI dependencies from the root manifest', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    write(root, 'package.json', JSON.stringify({
      workspaces: ['packages/*', 'apps/*'],
      dependencies: { '@earendil-works/pi-ai': '0.80.6' },
    }));
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /package\.json:1:PI_BOUNDARY_VIOLATION/);
  });
});

test('rejects a missing lockfile', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    rmSync(join(root, 'package-lock.json'));
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /PI_LOCK_MISSING/);
  });
});

test('rejects missing or stale PI lock entries', () => {
  withFixture((root) => {
    scaffoldWrapper(root);
    write(root, 'package-lock.json', JSON.stringify({
      lockfileVersion: 3,
      packages: {
        '': {},
        'packages/pi-management-runtime': { dependencies: {} },
        'node_modules/@earendil-works/pi-coding-agent': { version: '0.80.5' },
      },
    }));
    const result = runChecker(root);
    assert.equal(result.status, 1, `${result.stdout}${result.stderr}`);
    assert.match(result.stderr, /PI_LOCK_VERSION/);
    assert.match(result.stderr, /PI_LOCK_DECLARATION/);
  });
});
