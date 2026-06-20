import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createAgentBeanNextDaemonReleasePackage } from '../../../scripts/prepare-agentbean-next-daemon-release.mjs';

describe('AgentBean Next daemon release package', () => {
  test('generates a canonical @agentbean/daemon package from daemon-next', () => {
    const tempDir = mkdtempSync(join(tmpdir(), 'agentbean-next-daemon-release-'));
    try {
      const fixtureRoot = join(tempDir, 'repo');
      writeJson(join(fixtureRoot, 'apps/daemon-next/package.json'), {
        name: '@agentbean/daemon-next',
        version: '0.2.0',
        private: false,
        type: 'module',
        main: './dist/apps/daemon-next/src/index.js',
        types: './dist/apps/daemon-next/src/index.d.ts',
        bin: {
          'agentbean-next-daemon': './dist/apps/daemon-next/src/bin.js',
        },
        exports: {
          '.': {
            types: './dist/apps/daemon-next/src/index.d.ts',
            import: './dist/apps/daemon-next/src/index.js',
          },
        },
        files: ['dist/**/*'],
        dependencies: {
          '@agentbean/contracts': '0.2.0',
          'js-yaml': '^4.1.0',
          'socket.io-client': '^4.8.3',
        },
      });
      writeJson(join(fixtureRoot, 'packages/contracts/package.json'), {
        name: '@agentbean/contracts',
        version: '0.2.0',
        private: false,
      });
      writeText(join(fixtureRoot, 'apps/daemon-next/dist/apps/daemon-next/src/bin.js'), '#!/usr/bin/env node\n');

      const result = createAgentBeanNextDaemonReleasePackage({
        root: fixtureRoot,
        outDir: join(tempDir, 'release'),
      });
      const packageJson = JSON.parse(readFileSync(join(result.outDir, 'package.json'), 'utf8'));

      expect(packageJson.name).toBe('@agentbean/daemon');
      expect(packageJson.version).toBe('0.2.0');
      expect(packageJson.private).toBe(false);
      expect(packageJson.bin).toMatchObject({
        daemon: './dist/apps/daemon-next/src/bin.js',
        'agentbean-daemon': './dist/apps/daemon-next/src/bin.js',
        'agentbean-next-daemon': './dist/apps/daemon-next/src/bin.js',
      });
      expect(packageJson.dependencies).toMatchObject({
        '@agentbean/contracts': '0.2.0',
        'js-yaml': '^4.1.0',
        'socket.io-client': '^4.8.3',
      });
      expect(readFileSync(join(result.outDir, 'dist/apps/daemon-next/src/bin.js'), 'utf8')).toBe(
        '#!/usr/bin/env node\n',
      );
    } finally {
      rmSync(tempDir, { recursive: true, force: true });
    }
  });
});

function writeJson(path: string, value: unknown) {
  writeText(path, `${JSON.stringify(value, null, 2)}\n`);
}

function writeText(path: string, value: string) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, value);
}
