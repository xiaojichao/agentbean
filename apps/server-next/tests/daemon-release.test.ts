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

  test('propagates optionalDependencies and the full dependency set to the canonical package', () => {
    // 回归保护：canonical @agentbean/daemon 必须整体透传 daemon-next 的 dependencies 与
    // optionalDependencies，否则 npm 发布的包元数据会丢字段。
    // 历史 bug：脚本曾手工列举 dependencies 且完全遗漏 optionalDependencies，导致
    // @agentbean/daemon@0.2.5 不含 node-pty 声明，npx 安装的用户运行 codex（唯一 PTY
    // agent，executor-pty.ts 懒加载 node-pty）时报 Cannot find module 'node-pty'。
    // fixture 里多塞的 pino-pretty 模拟「未来新增的硬依赖」，确保走整体透传而非手工列举。
    const tempDir = mkdtempSync(join(tmpdir(), 'agentbean-next-daemon-release-optdeps-'));
    try {
      const fixtureRoot = join(tempDir, 'repo');
      writeJson(join(fixtureRoot, 'apps/daemon-next/package.json'), {
        name: '@agentbean/daemon-next',
        version: '0.2.6',
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
          // 模拟未来新增的硬依赖：必须被透传，验证脚本不是手工列举。
          'pino-pretty': '^11.0.0',
        },
        optionalDependencies: {
          'node-pty': '^1.1.0',
        },
      });
      writeJson(join(fixtureRoot, 'packages/contracts/package.json'), {
        name: '@agentbean/contracts',
        version: '0.2.1',
        private: false,
      });
      writeText(join(fixtureRoot, 'apps/daemon-next/dist/apps/daemon-next/src/bin.js'), '#!/usr/bin/env node\n');

      const result = createAgentBeanNextDaemonReleasePackage({
        root: fixtureRoot,
        outDir: join(tempDir, 'release'),
      });
      const packageJson = JSON.parse(readFileSync(join(result.outDir, 'package.json'), 'utf8'));

      // 整体透传 dependencies：未来新增的硬依赖必须出现（锁住「透传」而非「列举」）。
      expect(packageJson.dependencies['pino-pretty']).toBe('^11.0.0');
      // @agentbean/contracts 版本对齐同时发布的 contracts 包（0.2.1），覆盖源字面量 0.2.0。
      expect(packageJson.dependencies['@agentbean/contracts']).toBe('0.2.1');
      // optionalDependencies 必须透传——本 bug 的核心回归点。
      expect(packageJson.optionalDependencies).toEqual({ 'node-pty': '^1.1.0' });
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
