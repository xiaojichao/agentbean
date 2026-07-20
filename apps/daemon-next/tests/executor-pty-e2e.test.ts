// LOCAL-flavored end-to-end for the codex PTY path.
//
// The mock-based tests in executor-pty.test.ts inject a fake spawnPty, so they verify the codex
// contract (argv, file reply, redaction, error handling) but NOT that the real lazy-import chain
// works: createRequire('node-pty') actually loads the native module, spawnPty spawns a real PTY,
// onData/onExit fire, and extractReply parses real PTY output. This file exercises that chain via
// the default ptySpawnLoader. It is SKIPPED where node-pty has no usable binary (the daemon-next
// CI installs with --ignore-scripts on Linux), so it never breaks CI.

import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import { chmodSync, existsSync, mkdtempSync, realpathSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { describe, expect, test } from 'vitest';
import { createCommandExecutor } from '../src/executor';
import { ensureSpawnHelperExecutable, resolveSpawnHelperPaths } from '../src/executor-pty';

const requireNative = createRequire(import.meta.url);
// require succeeding is not enough: on the daemon-next CI (Linux, --ignore-scripts) node-pty's
// package unpacks but has no usable spawn-helper (no linux prebuild, compilation skipped), so an
// actual spawn would fail. Some local Node/native combinations can also resolve node-pty but never
// deliver PTY data/exit events, so gate this local-only e2e on a short isolated smoke process.
function hasNodePtyBinary(): boolean {
  try {
    const ptyRoot = dirname(requireNative.resolve('node-pty/package.json'));
    const prebuilt = join(ptyRoot, 'prebuilds', `${process.platform}-${process.arch}`, 'spawn-helper');
    const compiled = join(ptyRoot, 'build', 'Release', 'spawn-helper');
    return existsSync(prebuilt) || existsSync(compiled);
  } catch {
    return false;
  }
}

function hasUsableNodePty(): boolean {
  if (!hasNodePtyBinary()) return false;
  // node-pty #850: npm tarball ships spawn-helper as 644. chmod before the smoke probe so the gate
  // does not skip e2e on a fresh install (which would hide the exact regression we need to catch).
  ensureSpawnHelperExecutable();
  return [0, 1, 2].every(() => {
    const probeCwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-pty-probe-')));
    const fakeCodex = join(probeCwd, 'fake-codex.mjs');
    try {
      writeFileSync(fakeCodex, "process.stdout.write('agentbean-pty-smoke\\n'); process.exit(0);\n");
      const probe = [
        "const pty = require('node-pty');",
        `const child = pty.spawn(process.execPath, [${JSON.stringify(fakeCodex)}, '# user\\nhi'], { name: 'xterm-color', cols: 80, rows: 30, cwd: ${JSON.stringify(probeCwd)}, env: process.env });`,
        "let output = '';",
        "child.onData((chunk) => { output += chunk; });",
        "child.onExit((event) => { process.exit(event.exitCode === 0 && output.includes('agentbean-pty-smoke') ? 0 : 2); });",
        "setTimeout(() => { try { child.kill('SIGKILL'); } catch {} process.exit(3); }, 1000).unref();",
      ].join('\n');
      // Resolve node-pty from the monorepo install: a tmpdir cwd cannot see workspace
      // node_modules, which would skip every e2e on a fresh machine and hide #850.
      const result = spawnSync(process.execPath, ['-e', probe], {
        cwd: process.cwd(),
        encoding: 'utf8',
        timeout: 2000,
        stdio: 'ignore',
        env: {
          ...process.env,
          NODE_PATH: join(process.cwd(), 'node_modules'),
        },
      });
      return result.status === 0;
    } finally {
      try { rmSync(probeCwd, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  });
}

const testWithPty = hasUsableNodePty() ? test : test.skip;

describe('daemon-next codex PTY executor (real node-pty end-to-end)', () => {
  testWithPty('loads node-pty via the default loader and parses the reply from real PTY output', async () => {
    const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-codex-e2e-')));
    // A stand-in for the codex binary: prints a codex-labelled reply to the PTY and exits 0.
    const fakeCodex = join(cwd, 'fake-codex.mjs');
    try {
      writeFileSync(
        fakeCodex,
        `process.stdout.write('codex\\nreal pty reply\\nhook: done');\n`,
      );

      const executor = createCommandExecutor({ clock: { now: () => Date.now() } });
      const output = await executor({
        id: 'e2e-1', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
        agentId: 'agent-1', requestId: 'request-1', prompt: 'hi',
        customAgent: { adapterKind: 'codex', command: process.execPath, args: [fakeCodex], cwd },
      });

      if (typeof output !== 'object') throw new Error('expected structured result');
      // The real lazy-imported node-pty spawned the fake under a PTY; extractReply parsed its output.
      expect(output.body).toBe('real pty reply');
      expect(output.workspaceRun?.status).toBe('succeeded');
      expect(output.workspaceRun?.exitCode).toBe(0);
    } finally {
      try { rmSync(cwd, { recursive: true, force: true }); } catch { /* already gone */ }
    }
  });

  // Regression for node-pty #850 / user-facing "codex PTY 启动失败：posix_spawnp failed."
  // Without ensureSpawnHelperExecutable, mode 644 makes every spawn throw before onData/onExit.
  testWithPty('recovers when spawn-helper is mode 644 (node-pty #850 posix_spawnp)', async () => {
    const helpers = resolveSpawnHelperPaths();
    expect(helpers.length).toBeGreaterThan(0);
    const modes = helpers.map((helper) => ({ helper, mode: statSync(helper).mode & 0o777 }));
    try {
      for (const { helper } of modes) {
        chmodSync(helper, 0o644);
        expect(statSync(helper).mode & 0o777).toBe(0o644);
      }

      const cwd = realpathSync(mkdtempSync(join(tmpdir(), 'agentbean-codex-e2e-644-')));
      const fakeCodex = join(cwd, 'fake-codex.mjs');
      try {
        writeFileSync(
          fakeCodex,
          `process.stdout.write('codex\\nrecovered from 644\\nhook: done');\n`,
        );

        const executor = createCommandExecutor({ clock: { now: () => Date.now() } });
        const output = await executor({
          id: 'e2e-644', teamId: 'team-1', channelId: 'channel-1', messageId: 'message-1',
          agentId: 'agent-1', requestId: 'request-1', prompt: 'hi',
          customAgent: { adapterKind: 'codex', command: process.execPath, args: [fakeCodex], cwd },
        });

        if (typeof output !== 'object') throw new Error('expected structured result');
        // Must NOT surface the user-facing posix_spawnp failure — default loader chmods first.
        expect(output.body).not.toContain('posix_spawnp');
        expect(output.body).not.toContain('PTY 启动失败');
        expect(output.body).toBe('recovered from 644');
        expect(output.workspaceRun?.status).toBe('succeeded');
        expect(output.workspaceRun?.exitCode).toBe(0);
        // ensureSpawnHelperExecutable left helpers executable for subsequent spawns.
        for (const { helper } of modes) {
          expect(statSync(helper).mode & 0o111).not.toBe(0);
        }
      } finally {
        try { rmSync(cwd, { recursive: true, force: true }); } catch { /* already gone */ }
      }
    } finally {
      for (const { helper, mode } of modes) {
        try { chmodSync(helper, mode); } catch { /* best-effort restore */ }
      }
    }
  });
});
